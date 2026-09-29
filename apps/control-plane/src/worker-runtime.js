import { inTransaction } from "./db.js";

/** Commit a completed local job and its already-written artifact inventory atomically. */
export async function recordSuccessfulRun(pool, run, workerId, execution) {
  await inTransaction(pool, async (client) => {
    const owned = await client.query(
      "SELECT 1 FROM runs WHERE id=$1 AND status='running' AND worker_id=$2 AND cancel_requested_at IS NULL FOR UPDATE",
      [run.id, workerId],
    );
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
}

/** Persist cancellation, a retryable harness failure, or an exhausted inconclusive job. */
export async function recordFailedRun(pool, run, workerId, error) {
  const errorCode = safeErrorCode(error);
  const cancelled = error?.code === "worker_cancelled";
  const retry = !cancelled && Number(run.attempt_count) < 2;
  return inTransaction(pool, async (client) => {
    const updated = await client.query(
      "UPDATE runs SET status=CASE WHEN cancel_requested_at IS NOT NULL OR $3 THEN 'cancelled' WHEN $4 THEN 'queued' ELSE 'failed' END,verdict=CASE WHEN cancel_requested_at IS NOT NULL OR $3 OR $4 THEN NULL ELSE 'INCONCLUSIVE' END,error_code=CASE WHEN cancel_requested_at IS NOT NULL OR $3 THEN NULL ELSE $5 END,worker_id=NULL,lease_expires_at=NULL,finished_at=CASE WHEN cancel_requested_at IS NOT NULL OR $3 OR NOT $4 THEN now() ELSE NULL END WHERE id=$1 AND status='running' AND worker_id=$2 RETURNING organization_id,status",
      [run.id, workerId, cancelled, retry, errorCode],
    );
    if (updated.rowCount && updated.rows[0].status !== "queued") {
      const isCancelled = updated.rows[0].status === "cancelled";
      const action = isCancelled ? "run.cancelled" : "run.inconclusive";
      const details = isCancelled ? { workerMode: "local-docker" } : { errorCode, workerMode: "local-docker" };
      await client.query("INSERT INTO audit_events(organization_id,action,resource_type,resource_id,details) VALUES($1,$2,'run',$3,$4)", [updated.rows[0].organization_id, action, run.id, details]);
    }
    return { errorCode, cancelled, retry, status: updated.rows[0]?.status ?? "lease-lost" };
  });
}

function safeErrorCode(error) {
  const value = typeof error?.code === "string" ? error.code : "worker_failed";
  return /^[a-z0-9_-]{1,64}$/i.test(value) ? value : "worker_failed";
}
