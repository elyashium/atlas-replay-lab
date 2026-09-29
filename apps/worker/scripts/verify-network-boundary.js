import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { decodePng } from "../../../src/image/png.js";
import { assertInternalJobNetwork, assertProxyNetworkAttachments, assertWorkerNetworkAttachments, exportContainerArtifacts } from "../../control-plane/src/local-worker.js";

const image = process.env.ATLAS_WORKER_IMAGE ?? "atlas-worker:local";
const docker = process.env.DOCKER ?? "docker";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const suffix = randomBytes(6).toString("hex");
const jobNetwork = `atlas-job-${suffix}`;
const fixtureNetwork = `atlas-fixture-${suffix}`;
const proxyName = `atlas-proxy-${suffix}`;
const targetName = `atlas-target-${suffix}`;
const workerName = `atlas-worker-${suffix}`;
const jobWorkerName = `atlas-job-worker-${suffix}`;
const fixtureHost = "fixture.example.test";
const fixtureAddress = "93.184.216.2";
const seccomp = path.join(repoRoot, "apps/worker/seccomp.json");
const active = new Set();
const jobOutput = await mkdtemp(path.join(tmpdir(), `atlas-job-evidence-${suffix}-`));
const contractFile = path.join(jobOutput, "contract.json");
const capturedOutput = path.join(jobOutput, "captured");

try {
  run("network", ["create", "--internal", "--label", "atlas.test=network-boundary", jobNetwork]);
  run("network", ["create", "--internal", "--subnet", "93.184.216.0/29", "--gateway", "93.184.216.1", "--label", "atlas.test=network-boundary", fixtureNetwork]);
  assertInternalJobNetwork(JSON.parse(run("network", ["inspect", "--format", "{{json .}}", jobNetwork])));
  assertInternalJobNetwork(JSON.parse(run("network", ["inspect", "--format", "{{json .}}", fixtureNetwork])));

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
    "--env", "ATLAS_PROXY_TEST_DIAGNOSTICS=1",
    "--entrypoint", "node", image, "apps/worker/proxy-entry.js",
  ]);
  active.add(proxyName);
  run("network", ["connect", jobNetwork, proxyName]);
  run("network", ["connect", fixtureNetwork, proxyName]);
  await waitForLogs(proxyName, /egress proxy ready on 3128/);
  const networks = JSON.parse(run("inspect", ["--format", "{{json .NetworkSettings.Networks}}", proxyName]));
  assertProxyNetworkAttachments({ bridge: networks.bridge, [jobNetwork]: networks[jobNetwork] }, jobNetwork);
  assert.deepEqual(Object.keys(networks).sort(), ["bridge", fixtureNetwork, jobNetwork].sort(), "verifier proxy may only bridge its job, default, and synthetic fixture networks");
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
  const proxyLogs = run("logs", [proxyName]);
  const refusedProxyTunnels = (proxyLogs.match(/ATLAS_PROXY_CONNECT_REFUSED/g) ?? []).length;
  if (refusedProxyTunnels < 5) throw new Error(`browser adversarial cases did not produce enough per-origin proxy denials (${refusedProxyTunnels})`);
  process.stdout.write(`PASS: per-origin proxy denied ${refusedProxyTunnels} browser egress attempts from fetch, redirect, image, WebSocket and service-worker probes\n`);
  const udpProbePackets = (proxyLogs.match(/ATLAS_TEST_UDP_PROBE_RECEIVED/g) ?? []).length;
  if (udpProbePackets < 1) throw new Error("WebRTC probe did not reach the isolated-network UDP trap; STUN behavior was not exercised");
  process.stdout.write(`OBSERVED: WebRTC sent ${udpProbePackets} UDP packet(s) to a same-job-network trap; no server-reflexive candidate was gathered. This does not test external STUN reachability.\n`);
  process.stdout.write("PASS: isolated container could reach the synthetic HTTPS origin through the job proxy, while direct public/private sockets and worker DNS were blocked\n");

  const fixtureContract = {
    schemaVersion: 1,
    id: "docker-fixture",
    name: "Synthetic isolated-worker fixture",
    environment: "staging",
    authorization: { authorized: true, note: "Synthetic verifier fixture; not a third-party target" },
    target: { url: `https://${fixtureHost}/`, allowedOrigins: [`https://${fixtureHost}`], buildId: "a1b2c3d4" },
    journey: { steps: [{ type: "waitForVisible", selector: "#ready", timeoutMs: 5000 }], success: { selector: "#ready" }, fallback: { selector: "#fallback", requiredOn: [] } },
    profiles: ["high-wifi"],
    budgets: { journeyTimeoutMs: 10000, stepTimeoutMs: 5000 },
    mediaConsent: false,
    policy: { version: "1", criticalProfiles: ["high-wifi"], minimumScore: 0 },
    screenshots: { consent: true, redactSelectors: ["[data-private]"], componentSelectors: [{ id: "ready", selector: "#ready" }] },
  };
  await writeFile(contractFile, `${JSON.stringify(fixtureContract)}\n`, { flag: "wx" });
  run("create", [
    "--name", jobWorkerName, "--network", jobNetwork, "--dns", "127.0.0.1",
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,noexec,size=128m", "--tmpfs", "/dev/shm:rw,nosuid,nodev,size=256m",
    "--tmpfs", "/output:rw,nosuid,nodev,size=512m",
    "--mount", `type=bind,source=${contractFile},target=/job/contract.json,readonly`,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${seccomp}`,
    "--pids-limit", "256", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2",
    "--env", `ATLAS_EGRESS_PROXY=http://${proxyAddress}:3128`, "--env", "NODE_ENV=test", "--env", "ATLAS_WORKER_TEST_MODE=1",
    "--entrypoint", "node", image, "apps/worker/scripts/job-supervisor.js", "/job/contract.json", "/output/run",
  ]);
  active.add(jobWorkerName);
  for (const name of [jobWorkerName]) {
    const workerNetworks = JSON.parse(run("inspect", ["--format", "{{json .NetworkSettings.Networks}}", name]));
    assertWorkerNetworkAttachments(workerNetworks, jobNetwork);
  }
  run("start", [jobWorkerName]);
  let jobExit;
  const jobDeadline = Date.now() + 120_000;
  while (Date.now() < jobDeadline) {
    const marker = spawnSync(docker, ["exec", jobWorkerName, "cat", "/output/.worker-exit-code"], { encoding: "utf8", timeout: 5000 });
    if (marker.status === 0) { jobExit = Number(marker.stdout.trim()); break; }
    const state = JSON.parse(run("inspect", ["--format", "{{json .State}}", jobWorkerName]));
    if (!state.Running) throw new Error(`synthetic browser worker exited before artifact collection: ${run("logs", [jobWorkerName])}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (jobExit === undefined) throw new Error(`synthetic browser run timed out: ${run("logs", [jobWorkerName])}`);
  process.stdout.write(`job output root: ${run("exec", [jobWorkerName, "ls", "-la", "/output"])}\n`);
  process.stdout.write(`job output files: ${run("exec", [jobWorkerName, "find", "/output", "-maxdepth", "3", "-type", "f"])}\n`);
  await exportContainerArtifacts(docker, jobWorkerName, capturedOutput);
  const matrixReport = JSON.parse(await readFile(path.join(capturedOutput, "matrix", "report.json"), "utf8"));
  const screenshots = matrixReport.runs?.[0]?.screenshots ?? {};
  const componentPath = screenshots["component-ready"];
  const checkpointPath = screenshots["cp-final"];
  if (!componentPath || !checkpointPath) throw new Error("worker did not export both the consented final checkpoint and component crop");
  const componentFile = await findArtifact(capturedOutput, path.basename(componentPath));
  const checkpointFile = await findArtifact(capturedOutput, path.basename(checkpointPath));
  const componentImage = decodePng(await readFile(componentFile));
  const checkpointImage = decodePng(await readFile(checkpointFile));
  if (componentImage.width >= checkpointImage.width || componentImage.height >= checkpointImage.height) {
    throw new Error(`component crop was not smaller than the full checkpoint (${componentImage.width}x${componentImage.height} vs ${checkpointImage.width}x${checkpointImage.height})`);
  }
  const componentRedactionPixels = countOpaqueBlack(componentImage);
  const checkpointRedactionPixels = countOpaqueBlack(checkpointImage);
  if (componentRedactionPixels < 100 || checkpointRedactionPixels < 100) {
    throw new Error(`opaque redaction was not visible in both screenshots (${componentRedactionPixels} component pixels; ${checkpointRedactionPixels} checkpoint pixels)`);
  }
  process.stdout.write(`PASS: selector crops were exported separately and opaque-redacted (${componentImage.width}x${componentImage.height}, ${componentRedactionPixels} covered pixels; full checkpoint ${checkpointImage.width}x${checkpointImage.height}, ${checkpointRedactionPixels} covered pixels)\n`);
  const jobResult = JSON.parse(await readFile(path.join(capturedOutput, "job-result.json"), "utf8"));
  run("exec", [jobWorkerName, "touch", "/output/.parent-collected"]);
  if (Number(run("wait", [jobWorkerName])) !== jobExit) throw new Error("synthetic worker supervisor exit did not match its execution marker");
  if (jobExit !== 0) throw new Error(`synthetic browser run failed (${jobExit}): ${run("logs", [jobWorkerName])}`);
  if (jobResult.status !== "completed" || !["SHIP", "HOLD", "INCONCLUSIVE"].includes(jobResult.verdict) || jobResult.profiles?.completed !== 1) {
    throw new Error("synthetic queue job did not produce a complete, explicit release result");
  }
  const gateReport = JSON.parse(await readFile(path.join(capturedOutput, "gate", "report.json"), "utf8"));
  if (String(gateReport.decision).toUpperCase() !== jobResult.verdict) throw new Error("worker summary verdict did not match the deterministic gate report");
  if (jobResult.verdict === "SHIP" && gateReport.findings.some((finding) => finding.severity === "block")) throw new Error("worker emitted SHIP despite a blocking gate finding");
  process.stdout.write(`PASS: actual Atlas target matrix, gate, findings, and report completed in the isolated worker (${jobResult.verdict}; ${jobResult.profiles.completed}/${jobResult.profiles.total} profile)\n`);
  process.stdout.write(`Synthetic fixture verdict evidence: ${JSON.stringify({ targetDecision: jobResult.targetDecision, gateFindings: gateReport.findings })}\n`);
} finally {
  for (const name of [jobWorkerName, workerName, proxyName, targetName]) {
    if (active.has(name)) runQuiet("rm", ["--force", name]);
  }
  runQuiet("network", ["rm", jobNetwork]);
  runQuiet("network", ["rm", fixtureNetwork]);
  await rm(jobOutput, { recursive: true, force: true });
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

async function findArtifact(root, expectedName) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === expectedName) return candidate;
    if (entry.isDirectory()) {
      try { return await findArtifact(candidate, expectedName); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  throw Object.assign(new Error(`artifact ${expectedName} was not exported`), { code: "ENOENT" });
}

function countOpaqueBlack(image) {
  let count = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset] === 0 && image.data[offset + 1] === 0 && image.data[offset + 2] === 0 && image.data[offset + 3] === 255) count += 1;
  }
  return count;
}
