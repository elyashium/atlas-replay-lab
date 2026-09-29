import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const image = process.env.ATLAS_WORKER_IMAGE ?? "atlas-worker:local";
const docker = process.env.DOCKER ?? "docker";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const suffix = randomBytes(6).toString("hex");
const jobNetwork = `atlas-job-${suffix}`;
const fixtureNetwork = `atlas-fixture-${suffix}`;
const proxyName = `atlas-proxy-${suffix}`;
const targetName = `atlas-target-${suffix}`;
const workerName = `atlas-worker-${suffix}`;
const fixtureHost = "fixture.example.test";
const fixtureAddress = "93.184.216.2";
const seccomp = path.join(repoRoot, "apps/worker/seccomp.json");
const active = new Set();

try {
  run("network", ["create", "--internal", "--label", "atlas.test=network-boundary", jobNetwork]);
  run("network", ["create", "--internal", "--subnet", "93.184.216.0/29", "--gateway", "93.184.216.1", "--label", "atlas.test=network-boundary", fixtureNetwork]);

  run("run", [
    "--detach", "--rm", "--name", targetName, "--network", fixtureNetwork, "--ip", fixtureAddress,
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=32m", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m", "--cpus", "0.25",
    "--entrypoint", "node", image, "apps/worker/scripts/tls-fixture.js",
  ]);
  active.add(targetName);
  await waitForLogs(targetName, /TLS fixture ready on 443/);

  run("run", [
    "--detach", "--rm", "--name", proxyName, "--network", "bridge",
    "--add-host", `${fixtureHost}:${fixtureAddress}`,
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=32m", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "256m", "--cpus", "0.5",
    "--env", `ATLAS_ALLOWED_ORIGINS=${JSON.stringify([`https://${fixtureHost}`])}`,
    "--entrypoint", "node", image, "apps/worker/proxy-entry.js",
  ]);
  active.add(proxyName);
  run("network", ["connect", jobNetwork, proxyName]);
  run("network", ["connect", fixtureNetwork, proxyName]);
  await waitForLogs(proxyName, /egress proxy ready on 3128/);
  const networks = JSON.parse(run("inspect", ["--format", "{{json .NetworkSettings.Networks}}", proxyName]));
  const proxyAddress = networks[jobNetwork]?.IPAddress;
  if (!proxyAddress || !/^\d+(?:\.\d+){3}$/.test(proxyAddress)) throw new Error("proxy has no numeric address on the isolated job network");

  const boundaryDetails = run("run", [
    "--rm", "--name", workerName, "--network", jobNetwork, "--dns", "127.0.0.1",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,noexec,size=768m", "--tmpfs", "/dev/shm:rw,nosuid,nodev,size=256m",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${seccomp}`,
    "--pids-limit", "256", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2",
    "--env", `ATLAS_EGRESS_PROXY=http://${proxyAddress}:3128`,
    "--env", "ATLAS_DEBUG_CHROME=1",
    "--entrypoint", "node", image, "apps/worker/scripts/browser-network-check.js",
  ]);
  process.stdout.write(`${boundaryDetails.trim()}\n`);
  process.stdout.write("PASS: isolated container could reach the synthetic HTTPS origin through the job proxy, while direct public/private sockets and worker DNS were blocked\n");
} finally {
  for (const name of [workerName, proxyName, targetName]) {
    if (active.has(name)) runQuiet("stop", ["--time", "2", name]);
  }
  runQuiet("network", ["rm", jobNetwork]);
  runQuiet("network", ["rm", fixtureNetwork]);
}

function run(command, args) {
  const result = spawnSync(docker, [command, ...args], { encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${command} failed (${result.status}): ${`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim()}`);
  return result.stdout.trim();
}

function runQuiet(command, args) {
  const result = spawnSync(docker, [command, ...args], { encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024 });
  if (result.error) process.stderr.write(`${command}: ${result.error.message}\n`);
}

async function waitForLogs(name, pattern) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const logs = run("logs", [name]);
    if (pattern.test(logs)) return;
    const state = JSON.parse(run("inspect", ["--format", "{{json .State}}", name]));
    if (!state.Running) throw new Error(`${name} exited before readiness`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${name} was not ready before timeout`);
}
