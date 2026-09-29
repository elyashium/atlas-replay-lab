import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, lstat, readdir, readFile, rm, rename, writeFile } from "node:fs/promises";
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
  await mkdir(staged, { recursive: true });
  const contractFile = path.join(tempRoot, "contract.json");
  const active = { network: false, proxy: false, worker: false };
  let heartbeatTimer;
  let primaryError;

  try {
    await writeFile(contractFile, `${JSON.stringify(contract)}\n`, { flag: "wx", mode: 0o644 });
    await dockerCall(docker, ["network", "create", "--internal", "--label", "atlas.managed=true", "--label", `atlas.run=${run.id}`, network]);
    active.network = true;
    const jobNetworkInfo = JSON.parse(await dockerCall(docker, ["network", "inspect", "--format", "{{json .}}", network]));
    assertInternalJobNetwork(jobNetworkInfo);

    await dockerCall(docker, [
      "run", "--detach", "--rm", "--name", proxy, "--network", "bridge",
      "--label", `atlas.run=${run.id}`,
      "--read-only", "--tmpfs", "/tmp:rw,nosuid,noexec,size=32m", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "256m", "--cpus", "0.5",
      "--env", `ATLAS_ALLOWED_ORIGINS=${JSON.stringify(origins)}`,
      "--entrypoint", "node", image, "apps/worker/proxy-entry.js",
    ]);
    active.proxy = true;
    await dockerCall(docker, ["network", "connect", network, proxy]);
    await waitForLog(docker, proxy, /egress proxy ready on 3128/);
    const networks = JSON.parse(await dockerCall(docker, ["inspect", "--format", "{{json .NetworkSettings.Networks}}", proxy]));
    assertProxyNetworkAttachments(networks, network);
    const proxyAddress = networks[network]?.IPAddress;
    if (!proxyAddress || !/^\d+(?:\.\d+){3}$/.test(proxyAddress)) throw new Error("worker proxy did not receive an isolated-network address");

    await dockerCall(docker, [
      "create", "--name", worker, "--network", network, "--dns", "127.0.0.1",
      "--label", `atlas.run=${run.id}`,
      "--read-only", "--tmpfs", "/tmp:rw,nosuid,noexec,size=128m", "--tmpfs", "/dev/shm:rw,nosuid,nodev,size=256m",
      "--tmpfs", "/output:rw,nosuid,nodev,size=512m",
      "--mount", `type=bind,source=${contractFile},target=/job/contract.json,readonly`,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${options.seccompPath}`,
      "--pids-limit", "256", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2",
      "--env", `ATLAS_EGRESS_PROXY=http://${proxyAddress}:3128`,
      "--entrypoint", "node", image, "apps/worker/scripts/job-supervisor.js", "/job/contract.json", "/output/run",
    ]);
    active.worker = true;
    const workerNetworks = JSON.parse(await dockerCall(docker, ["inspect", "--format", "{{json .NetworkSettings.Networks}}", worker]));
    assertWorkerNetworkAttachments(workerNetworks, network);
    await dockerCall(docker, ["start", worker]);

    let heartbeatBusy = false;
    let cancelled = false;
    let heartbeatFailure = null;
    heartbeatTimer = setInterval(() => {
      if (heartbeatBusy || !options.heartbeat) return;
      heartbeatBusy = true;
      options.heartbeat().then(async (cancelRequested) => {
        if (cancelRequested && !cancelled) {
          cancelled = true;
          await dockerCall(docker, ["kill", worker]).catch(() => {});
        }
      }).catch(async () => {
        heartbeatFailure = Object.assign(new Error("worker heartbeat failed; stopping the isolated job"), { code: "worker_heartbeat_failed" });
        await dockerCall(docker, ["kill", worker]).catch(() => {});
      }).finally(() => { heartbeatBusy = false; });
    }, 30_000);
    heartbeatTimer.unref?.();
    let exitCode;
    try { exitCode = await waitForCompletionMarker(docker, worker, options.timeoutMs ?? JOB_TIMEOUT_MS); }
    catch (error) { if (heartbeatFailure) throw heartbeatFailure; throw error; }
    if (heartbeatFailure) throw heartbeatFailure;
    await exportContainerArtifacts(docker, worker, staged);
    await dockerCall(docker, ["exec", worker, "touch", "/output/.parent-collected"]);
    const supervisorExit = Number(await dockerCall(docker, ["wait", worker]));
    if (supervisorExit !== exitCode) throw new Error("worker supervisor exit did not match the collected execution status");
    if (cancelled) throw Object.assign(new Error("run was cancelled by an organization member"), { code: "worker_cancelled" });
    if (exitCode !== 0) throw Object.assign(new Error("isolated browser harness exited without a complete evidence bundle"), { code: "worker_harness_failed" });
    const resultPath = path.join(staged, "job-result.json");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    if (result.status !== "completed" || !["SHIP", "HOLD", "INCONCLUSIVE"].includes(result.verdict)) throw new Error("worker returned an invalid release result");
    const files = await inventory(staged);
    if (!files.some((file) => file.relativePath === "report.html") || !files.some((file) => file.relativePath === "job-result.json")) {
      throw new Error("worker output is missing its report or result summary");
    }

    const destination = path.join(options.artifactRoot, run.id);
    await mkdir(options.artifactRoot, { recursive: true, mode: 0o700 });
    await chmod(options.artifactRoot, 0o700);
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
    primaryError = error?.code === "ETIMEDOUT" ? Object.assign(new Error("worker exceeded its wall-time budget"), { code: "worker_timeout" }) : error;
    throw primaryError;
  } finally {
    clearInterval(heartbeatTimer);
    const cleanupErrors = [];
    if (active.worker) await cleanupDockerResource(docker, ["rm", "--force", worker], cleanupErrors);
    if (active.proxy) await cleanupDockerResource(docker, ["rm", "--force", proxy], cleanupErrors);
    if (active.network) await cleanupDockerResource(docker, ["network", "rm", network], cleanupErrors);
    try { await rm(tempRoot, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length && !primaryError) throw new AggregateError(cleanupErrors, "worker cleanup could not be verified");
  }
}

/** Fail closed if Docker did not create the job segment as an internal network. */
export function assertInternalJobNetwork(networkInfo) {
  if (!networkInfo || networkInfo.Internal !== true) throw new Error("worker job network is not Docker-internal; refusing to start browser job");
}

/** The egress proxy is the only container attached to both the job and default bridge networks. */
export function assertProxyNetworkAttachments(networks, jobNetwork) {
  const attached = Object.keys(networks ?? {}).sort();
  const expected = ["bridge", jobNetwork].sort();
  if (attached.length !== expected.length || attached.some((name, index) => name !== expected[index])) {
    throw new Error("egress proxy has an unexpected Docker network attachment");
  }
  if (!/^\d+(?:\.\d+){3}$/.test(networks?.[jobNetwork]?.IPAddress ?? "")) {
    throw new Error("egress proxy has no isolated job-network address");
  }
}

/** A browser worker must have exactly one network attachment: its internal job segment. */
export function assertWorkerNetworkAttachments(networks, jobNetwork) {
  const attached = Object.keys(networks ?? {});
  if (attached.length !== 1 || attached[0] !== jobNetwork) {
    throw new Error("browser worker has an unexpected Docker network attachment");
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

/** Reap containers from expired local leases before making a run claimable again. */
export async function recoverExpiredRuns(pool, { docker = process.env.DOCKER ?? "docker", call = dockerCall } = {}) {
  const recoveryId = `reaper:${randomUUID()}`;
  const expired = await pool.query(
    `WITH expired AS (
       SELECT id FROM runs WHERE status='running' AND lease_expires_at <= now()
       ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT 50
     )
     UPDATE runs r SET worker_id=$1,lease_expires_at=now()+interval '2 minutes'
     FROM expired WHERE r.id=expired.id
     RETURNING r.id,r.attempt_count`,
    [recoveryId],
  );
  let recovered = 0;
  for (const run of expired.rows) {
    const containers = (await call(docker, ["ps", "--all", "--quiet", "--filter", `label=atlas.run=${run.id}`])).split(/\s+/).filter(Boolean);
    for (const container of containers) await call(docker, ["rm", "--force", container]);
    const networks = (await call(docker, ["network", "ls", "--quiet", "--filter", `label=atlas.run=${run.id}`])).split(/\s+/).filter(Boolean);
    for (const network of networks) await call(docker, ["network", "rm", network]);
    const exhausted = Number(run.attempt_count) >= MAX_ATTEMPTS;
    const result = await pool.query(
      "UPDATE runs SET status=CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' WHEN $3 THEN 'failed' ELSE 'queued' END,verdict=CASE WHEN cancel_requested_at IS NOT NULL THEN NULL WHEN $3 THEN 'INCONCLUSIVE' ELSE NULL END,error_code=CASE WHEN cancel_requested_at IS NOT NULL THEN NULL WHEN $3 THEN 'worker_lease_expired' ELSE NULL END,worker_id=NULL,lease_expires_at=NULL,finished_at=CASE WHEN cancel_requested_at IS NOT NULL OR $3 THEN now() ELSE NULL END WHERE id=$1 AND status='running' AND worker_id=$2 RETURNING organization_id,status",
      [run.id, recoveryId, exhausted],
    );
    if (result.rowCount && result.rows[0].status !== "queued") {
      const cancelled = result.rows[0].status === "cancelled";
      await pool.query("INSERT INTO audit_events(organization_id,action,resource_type,resource_id,details) VALUES($1,$2,'run',$3,$4)", [result.rows[0].organization_id, cancelled ? "run.cancelled" : "run.inconclusive", run.id, cancelled ? { workerMode: "local-docker" } : { errorCode: "worker_lease_expired", workerMode: "local-docker" }]);
    }
    recovered += result.rowCount ?? 0;
  }
  return recovered;
}

export async function heartbeatRun(pool, runId, workerId) {
  const result = await pool.query(
    "UPDATE runs SET lease_expires_at=now()+interval '2 minutes' WHERE id=$1 AND status='running' AND worker_id=$2 RETURNING cancel_requested_at IS NOT NULL AS cancelled",
    [runId, workerId],
  );
  if (!result.rowCount) throw new Error("run lease was lost");
  return result.rows[0].cancelled;
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

export async function exportContainerArtifacts(docker, name, destination) {
  const unsupported = await dockerCall(docker, ["exec", name, "find", "/output/run", "-mindepth", "1", "!", "-type", "f", "!", "-type", "d", "-print"]);
  if (unsupported) throw new Error("worker output contains an unsupported filesystem entry");
  const listing = await dockerCall(docker, ["exec", name, "find", "/output/run", "-type", "f", "-printf", "%P\\n"]);
  const relativePaths = listing ? listing.split(/\r?\n/).filter(Boolean) : [];
  if (!relativePaths.length || relativePaths.length > MAX_OUTPUT_FILES) throw new Error("worker output is empty or contains too many files");
  let totalBytes = 0;
  for (const relativePath of relativePaths) {
    if (!/^[A-Za-z0-9._/-]{1,240}$/.test(relativePath) || relativePath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("worker output contains an unsafe path");
    const encoded = await dockerReadBase64(docker, ["exec", name, "base64", "--wrap=0", `/output/run/${relativePath}`]);
    const encodedText = encoded.toString("ascii").replace(/\r?\n$/, "");
    const bytes = Buffer.from(encodedText, "base64");
    if (bytes.toString("base64") !== encodedText) throw new Error("worker output transfer was not valid base64");
    totalBytes += bytes.length;
    if (totalBytes > MAX_OUTPUT_BYTES) throw new Error("worker output exceeded the artifact byte budget");
    const destinationPath = path.join(destination, ...relativePath.split("/"));
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, bytes, { flag: "wx", mode: 0o600 });
  }
}

function dockerReadBase64(docker, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(docker, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks = [];
    let size = 0;
    let stderr = "";
    const maximum = Math.ceil(MAX_OUTPUT_BYTES / 3) * 4 + 8;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximum) { child.kill(); reject(new Error("worker artifact exceeded the per-file transfer limit")); return; }
      chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`docker artifact read failed (${code}): ${stderr.trim()}`)));
  });
}

async function cleanupDockerResource(docker, args, errors) {
  try { await dockerCall(docker, args); }
  catch (error) {
    if (/no such (?:container|network)|not found/i.test(error.message)) return;
    errors.push(error);
  }
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

async function waitForCompletionMarker(docker, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await dockerCall(docker, ["exec", name, "cat", "/output/.worker-exit-code"]);
      if (!/^[0-9]+$/.test(value)) throw new Error("worker completion marker is malformed");
      return Number(value);
    } catch (error) {
      if (!/no such file|no such container|is not running/i.test(error.message)) throw error;
      const state = JSON.parse(await dockerCall(docker, ["inspect", "--format", "{{json .State}}", name]));
      if (!state.Running) throw new Error("worker stopped before artifact collection");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await dockerCall(docker, ["kill", name]).catch(() => {});
  throw Object.assign(new Error("worker exceeded its wall-time budget"), { code: "ETIMEDOUT" });
}
