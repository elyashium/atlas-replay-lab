import { hostname } from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool } from "./db.js";
import { claimNextRun, executeLocalRun, heartbeatRun, recoverExpiredRuns } from "./local-worker.js";
import { recordFailedRun, recordSuccessfulRun } from "./worker-runtime.js";
import { loadLocalEnv } from "./load-env.js";
import { createArtifactStore } from "./artifact-store.js";
import { uploadRunArtifacts } from "./artifact-upload.js";

loadLocalEnv();
if (process.env.ATLAS_ENABLE_LOCAL_WORKER !== "1") throw new Error("set ATLAS_ENABLE_LOCAL_WORKER=1 to start the local Docker worker");
const artifactRoot = process.env.ATLAS_LOCAL_ARTIFACT_DIR;
if (!artifactRoot || !path.isAbsolute(artifactRoot)) throw new Error("ATLAS_LOCAL_ARTIFACT_DIR must be an absolute path outside the repository");
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDir, "../../..");
const relativeArtifactRoot = path.relative(repositoryRoot, path.resolve(artifactRoot));
if (!relativeArtifactRoot.startsWith("..") && !path.isAbsolute(relativeArtifactRoot)) throw new Error("ATLAS_LOCAL_ARTIFACT_DIR must be outside the repository");
const pool = createPool();
const artifactStore = createArtifactStore();
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
      if (artifactStore) await uploadRunArtifacts(artifactStore, artifactRoot, run.id, execution.artifacts);
      await recordSuccessfulRun(pool, run, workerId, execution);
      if (artifactStore) await rm(path.join(artifactRoot, run.id), { recursive: true, force: true }).catch((error) => console.error(`temporary artifact cleanup failed for ${run.id}: ${error?.name ?? "filesystem_error"}`));
      console.log(`completed run ${run.id}: ${execution.result.verdict}`);
    } catch (error) {
      if (artifactStore) {
        try {
          const ownership = await pool.query("SELECT status,worker_id FROM runs WHERE id=$1", [run.id]);
          const stillOwned = ownership.rows[0]?.status === "running" && ownership.rows[0]?.worker_id === workerId;
          if (stillOwned) await artifactStore.deleteRun(run.id);
        } catch (purgeError) {
          console.error(`could not safely clean partial remote artifacts for ${run.id}: ${purgeError?.name ?? "storage_error"}`);
        }
      }
      await rm(path.join(artifactRoot, run.id), { recursive: true, force: true }).catch(() => {});
      const failed = await recordFailedRun(pool, run, workerId, error);
      console.error(`run ${run.id} failed in the harness (${failed.errorCode})${failed.retry ? "; one retry queued" : failed.cancelled ? "; cancelled" : "; marked INCONCLUSIVE"}`);
    }
  }
} finally {
  artifactStore?.close();
  await pool.end();
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
