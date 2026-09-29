import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, inTransaction } from "./db.js";
import { claimNextRun, executeLocalRun, heartbeatRun } from "./local-worker.js";
import { newId } from "./security.js";

if (process.env.ATLAS_ENABLE_LOCAL_WORKER !== "1") throw new Error("set ATLAS_ENABLE_LOCAL_WORKER=1 to start the local Docker worker");
const artifactRoot = process.env.ATLAS_LOCAL_ARTIFACT_DIR;
if (!artifactRoot || !path.isAbsolute(artifactRoot)) throw new Error("ATLAS_LOCAL_ARTIFACT_DIR must be an absolute path outside the repository");
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDir, "../../..");
const pool = createPool();
const workerId = `local:${hostname()}:${process.pid}`.slice(0, 120);
let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

try {
  console.log(`Atlas local worker ${workerId} is polling the queue. This is a local development worker, not a hosted service.`);
  while (!stopping) {
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
      await inTransaction(pool, async (client) => {
        const owned = await client.query("SELECT 1 FROM runs WHERE id=$1 AND status='running' AND worker_id=$2 FOR UPDATE", [run.id, workerId]);
        if (!owned.rowCount) throw new Error("run lease was lost before result commit");
        for (const artifact of execution.artifacts) {
          await client.query(
            "INSERT INTO artifacts(id,organization_id,run_id,object_key,media_type,byte_length,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [artifact.id, run.organization_id, run.id, artifact.objectKey, artifact.mediaType, artifact.byteLength, artifact.sha256],
          );
        }
        await client.query(
          "UPDATE runs SET status='completed',verdict=$3,result_snapshot=$4,finished_at=now(),worker_id=NULL,lease_expires_at=NULL,error_code=NULL WHERE id=$1 AND worker_id=$2",
          [run.id, workerId, execution.result.verdict, execution.result],
        );
        await client.query(
          "INSERT INTO audit_events(organization_id,action,resource_type,resource_id,details) VALUES($1,'run.completed','run',$2,$3)",
          [run.organization_id, run.id, { verdict: execution.result.verdict, artifactCount: execution.artifacts.length, workerMode: "local-docker" }],
        );
      });
      console.log(`completed run ${run.id}: ${execution.result.verdict}`);
    } catch (error) {
      const errorCode = safeErrorCode(error);
      const retry = Number(run.attempt_count) < 2;
      await inTransaction(pool, async (client) => {
        const updated = await client.query(
          "UPDATE runs SET status=$3,verdict=$4,error_code=$5,worker_id=NULL,lease_expires_at=NULL,finished_at=CASE WHEN $3='failed' THEN now() ELSE NULL END WHERE id=$1 AND status='running' AND worker_id=$2 RETURNING organization_id",
          [run.id, workerId, retry ? "queued" : "failed", retry ? null : "INCONCLUSIVE", errorCode],
        );
        if (updated.rowCount && !retry) {
          await client.query("INSERT INTO audit_events(organization_id,action,resource_type,resource_id,details) VALUES($1,'run.inconclusive','run',$2,$3)", [updated.rows[0].organization_id, run.id, { errorCode, workerMode: "local-docker" }]);
        }
      });
      console.error(`run ${run.id} failed in the harness (${errorCode})${retry ? "; one retry queued" : "; marked INCONCLUSIVE"}`);
    }
  }
} finally {
  await pool.end();
}

function safeErrorCode(error) {
  const value = typeof error?.code === "string" ? error.code : "worker_failed";
  return /^[a-z0-9_-]{1,64}$/i.test(value) ? value : "worker_failed";
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
