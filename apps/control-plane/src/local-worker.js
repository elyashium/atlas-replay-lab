import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, lstat, readdir, readFile, rm, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateTargetContract } from "../../../src/targets/contract.js";

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_FILES = 5000;
const MAX_ATTEMPTS = 2;
const JOB_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Run one verified HTTPS target in a throwaway Docker worker. This local
 * executor deliberately accepts no customer credentials or model keys.
 * @param {{run: any; artifactRoot: string; image?: string; docker?: string; seccompPath: string; heartbeat?: () => Promise<void>; timeoutMs?: number}} options
 */
export async function executeLocalRun(options) {
  const { run } = options;
  if (!run || !/^[0-9a-f-]{36}$/i.test(run.id ?? "")) throw new Error("invalid run id");
  const checked = validateTargetContract(run.contract_snapshot);
  if (!checked.ok) throw new Error("stored target contract failed validation");
  const contract = checked.contract;
  const target = new URL(contract.target.url);
  if (target.protocol !== "https:") throw new Error("isolated workers require an HTTPS target");
  const origins = [...new Set(contract.target.allowedOrigins)];
  if (origins.some((origin) => new URL(origin).protocol !== "https:")) throw new Error("isolated worker origins must all use HTTPS");

  const docker = options.docker ?? process.env.DOCKER ?? "docker";
  const image = options.image ?? process.env.ATLAS_WORKER_IMAGE ?? "atlas-worker:local";
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const network = `atlas-job-${suffix}`;
  const proxy = `atlas-proxy-${suffix}`;
  const worker = `atlas-worker-${suffix}`;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `atlas-run-${suffix}-`));
  const staged = path.join(tempRoot, "artifacts");
  const containerOutput = path.join(tempRoot, "container-output");
  await mkdir(staged, { recursive: true });
  await mkdir(containerOutput, { recursive: true });
  const contractFile = path.join(tempRoot, "contract.json");
  const active = { network: false, proxy: false, worker: false };
  let heartbeatTimer;

  try {
    await writeFile(contractFile, `${JSON.stringify(contract)}\n`, { flag: "wx", mode: 0o600 });
    await dockerCall(docker, ["network", "create", "--internal", "--label", "atlas.managed=true", network]);
    active.network = true;

    await dockerCall(docker, [
      "run", "--detach", "--rm", "--name", proxy, "--network", "bridge",
      "--read-only", "--tmpfs", "/tmp:rw,nosuid,noexec,size=32m", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "256m", "--cpus", "0.5",
      "--env", `ATLAS_ALLOWED_ORIGINS=${JSON.stringify(origins)}`,
      "--entrypoint", "node", image, "apps/worker/proxy-entry.js",
    ]);
    active.proxy = true;
    await dockerCall(docker, ["network", "connect", network, proxy]);
    await waitForLog(docker, proxy, /egress proxy ready on 3128/);
    const networks = JSON.parse(await dockerCall(docker, ["inspect", "--format", "{{json .NetworkSettings.Networks}}", proxy]));
    const proxyAddress = networks[network]?.IPAddress;
    if (!proxyAddress || !/^\d+(?:\.\d+){3}$/.test(proxyAddress)) throw new Error("worker proxy did not receive an isolated-network address");

    await dockerCall(docker, [
      "create", "--name", worker, "--network", network, "--dns", "127.0.0.1",
      "--read-only", "--tmpfs", "/tmp:rw,nosuid,noexec,size=128m", "--tmpfs", "/dev/shm:rw,nosuid,nodev,size=256m",
      "--tmpfs", "/job:rw,nosuid,nodev,noexec,size=8m", "--tmpfs", "/output:rw,nosuid,nodev,size=512m",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${options.seccompPath}`,
      "--pids-limit", "256", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2",
      "--env", `ATLAS_EGRESS_PROXY=http://${proxyAddress}:3128`,
      "--entrypoint", "node", image, "apps/worker/scripts/execute-job.js", "/job/contract.json", "/output/run",
    ]);
    active.worker = true;
    await dockerCall(docker, ["cp", contractFile, `${worker}:/job/contract.json`]);
    await dockerCall(docker, ["start", worker]);

    let heartbeatBusy = false;
    heartbeatTimer = setInterval(() => {
      if (heartbeatBusy || !options.heartbeat) return;
      heartbeatBusy = true;
      options.heartbeat().catch(() => {}).finally(() => { heartbeatBusy = false; });
    }, 30_000);
    heartbeatTimer.unref?.();
    const exitCode = await waitForContainer(docker, worker, options.timeoutMs ?? JOB_TIMEOUT_MS);
    if (exitCode !== 0) throw Object.assign(new Error("isolated browser harness exited without a complete evidence bundle"), { code: "worker_harness_failed" });
    await dockerCall(docker, ["cp", `${worker}:/output/run/.`, staged]);
    const resultPath = path.join(staged, "job-result.json");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    if (result.status !== "completed" || !["SHIP", "HOLD"].includes(result.verdict)) throw new Error("worker returned an invalid release result");
    const files = await inventory(staged);
    if (!files.some((file) => file.relativePath === "report.html") || !files.some((file) => file.relativePath === "job-result.json")) {
      throw new Error("worker output is missing its report or result summary");
    }

    const destination = path.join(options.artifactRoot, run.id);
    await mkdir(options.artifactRoot, { recursive: true, mode: 0o700 });
    await rm(destination, { recursive: true, force: true });
    await rename(staged, destination);
    return {
      result,
      artifacts: await Promise.all(files.map(async (file) => {
        const bytes = await readFile(path.join(destination, file.relativePath));
        return {
          id: randomUUID(),
          objectKey: `${run.id}/${file.relativePath}`,
          mediaType: mediaType(file.relativePath),
          byteLength: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      })),
    };
  } catch (error) {
    if (error?.code === "ETIMEDOUT") throw Object.assign(new Error("worker exceeded its wall-time budget"), { code: "worker_timeout" });
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    if (active.worker) await dockerCall(docker, ["rm", "--force", worker]).catch(() => {});
    if (active.proxy) await dockerCall(docker, ["stop", "--time", "2", proxy]).catch(() => {});
    if (active.network) await dockerCall(docker, ["network", "rm", network]).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/** Claim exactly one queue item using PostgreSQL row locking and return the leased snapshot. */
export async function claimNextRun(pool, workerId) {
  const result = await pool.query(
    `WITH picked AS (
       SELECT id FROM runs
       WHERE status='queued' AND attempt_count < $2 AND retention_expires_at > now()
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE runs r SET status='running',worker_id=$1,lease_expires_at=now()+interval '2 minutes',
       started_at=COALESCE(started_at,now()),attempt_count=attempt_count+1,error_code=NULL
     FROM picked WHERE r.id=picked.id
     RETURNING r.id,r.organization_id,r.project_id,r.target_id,r.contract_snapshot,r.binding_snapshot,r.attempt_count`,
    [workerId, MAX_ATTEMPTS],
  );
  return result.rows[0] ?? null;
}

export async function heartbeatRun(pool, runId, workerId) {
  const result = await pool.query(
    "UPDATE runs SET lease_expires_at=now()+interval '2 minutes' WHERE id=$1 AND status='running' AND worker_id=$2 RETURNING id",
    [runId, workerId],
  );
  if (!result.rowCount) throw new Error("run lease was lost");
}

async function inventory(root) {
  const files = [];
  let total = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink() || info.isBlockDevice() || info.isCharacterDevice() || info.isFIFO() || info.isSocket()) throw new Error("worker output contains an unsupported filesystem entry");
      if (entry.isDirectory()) { await walk(fullPath); continue; }
      if (!entry.isFile()) throw new Error("worker output contains an unsupported filesystem entry");
      const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
      if (!/^[A-Za-z0-9._/-]{1,240}$/.test(relativePath) || relativePath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("worker output contains an unsafe path");
      total += info.size;
      if (total > MAX_OUTPUT_BYTES || files.length >= MAX_OUTPUT_FILES) throw new Error("worker output exceeded the artifact budget");
      files.push({ relativePath, byteLength: info.size });
    }
  }
  await walk(root);
  return files;
}

function mediaType(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  return ({ ".html": "text/html", ".json": "application/json", ".png": "image/png", ".webp": "image/webp", ".txt": "text/plain", ".csv": "text/csv" })[extension] ?? "application/octet-stream";
}

function dockerCall(docker, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(docker, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout = (stdout + chunk).slice(-128 * 1024); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-128 * 1024); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(Object.assign(new Error(`docker ${args[0]} failed (${code}): ${stderr.trim()}`), { exitCode: code })));
  });
}

async function waitForLog(docker, name, pattern) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const logs = await dockerCall(docker, ["logs", name]);
    if (pattern.test(logs)) return;
    const state = JSON.parse(await dockerCall(docker, ["inspect", "--format", "{{json .State}}", name]));
    if (!state.Running) throw new Error("per-job egress proxy exited before readiness");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("per-job egress proxy did not become ready");
}

async function waitForContainer(docker, name, timeoutMs) {
  const waiter = dockerCall(docker, ["wait", name]);
  let timer;
  try {
    const code = await Promise.race([
      waiter,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("worker timeout"), { code: "ETIMEDOUT" })), timeoutMs); }),
    ]);
    return Number(code);
  } catch (error) {
    if (error?.code === "ETIMEDOUT") await dockerCall(docker, ["kill", name]).catch(() => {});
    throw error;
  } finally { clearTimeout(timer); }
}
