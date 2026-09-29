import { hostname } from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool } from "./db.js";
import { claimNextRun, executeLocalRun, heartbeatRun, recoverExpiredRuns } from "./local-worker.js";
import { recordFailedRun, recordSuccessfulRun } from "./worker-runtime.js";

if (process.env.ATLAS_ENABLE_LOCAL_WORKER !== "1") throw new Error("set ATLAS_ENABLE_LOCAL_WORKER=1 to start the local Docker worker");
const artifactRoot = process.env.ATLAS_LOCAL_ARTIFACT_DIR;
if (!artifactRoot || !path.isAbsolute(artifactRoot)) throw new Error("ATLAS_LOCAL_ARTIFACT_DIR must be an absolute path outside the repository");
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDir, "../../..");
const relativeArtifactRoot = path.relative(repositoryRoot, path.resolve(artifactRoot));
if (!relativeArtifactRoot.startsWith("..") && !path.isAbsolute(relativeArtifactRoot)) throw new Error("ATLAS_LOCAL_ARTIFACT_DIR must be outside the repository");
const pool = createPool();
const workerId = `local:${hostname()}:${process.pid}`.slice(0, 120);
let stopping = false;
let lastRecoveryAt = 0;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

try {
  console.log(`Atlas local worker ${workerId} is polling the queue. This is a local development worker, not a hosted service.`);
  while (!stopping) {
    if (Date.now() - lastRecoveryAt >= 15_000) {
      await recoverExpiredRuns(pool);
      lastRecoveryAt = Date.now();
    }
    const run = await claimNextRun(pool, workerId);
    if (!run) { await delay(1000); continue; }
    console.log(`claimed run ${run.id}`);
    try {
      const execution = await executeLocalRun({
        run,
        artifactRoot,
        seccompPath: path.join(repositoryRoot, "apps/worker/seccomp.json"),
        heartbeat: () => heartbeatRun(pool, run.id, workerId),
      });
      await recordSuccessfulRun(pool, run, workerId, execution);
      console.log(`completed run ${run.id}: ${execution.result.verdict}`);
    } catch (error) {
      await rm(path.join(artifactRoot, run.id), { recursive: true, force: true }).catch(() => {});
      const failed = await recordFailedRun(pool, run, workerId, error);
      console.error(`run ${run.id} failed in the harness (${failed.errorCode})${failed.retry ? "; one retry queued" : failed.cancelled ? "; cancelled" : "; marked INCONCLUSIVE"}`);
    }
  }
} finally {
  await pool.end();
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
