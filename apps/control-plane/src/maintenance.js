import { inTransaction } from "./db.js";
import path from "node:path";
import { lstat, rm } from "node:fs/promises";

/** Purge expired private metadata and, in local-worker mode, its artifact directories. */
export async function purgeExpiredRecords(pool, { artifactRoot = process.env.ATLAS_LOCAL_ARTIFACT_DIR, artifactStore = null } = {}) {
  if (artifactRoot && !path.isAbsolute(artifactRoot)) throw new Error("ATLAS_LOCAL_ARTIFACT_DIR must be an absolute path");
  const deleted = await inTransaction(pool, async (client) => {
    const sessions = await client.query("DELETE FROM sessions WHERE expires_at <= now()");
    const shares = await client.query("DELETE FROM share_links WHERE expires_at <= now() OR revoked_at IS NOT NULL");
    const shareRequestBuckets = await client.query("DELETE FROM shared_report_request_buckets WHERE bucket_start < date_trunc('minute', now()) - interval '2 minutes'");
    const anonymousShareRequestBuckets = await client.query("DELETE FROM anonymous_share_request_buckets WHERE bucket_start < date_trunc('minute', now()) - interval '2 minutes'");
    const runs = await client.query("SELECT organization_id,id FROM runs WHERE retention_expires_at <= now() AND status <> 'running' FOR UPDATE");
    for (const run of runs.rows) {
      await client.query("INSERT INTO audit_events(organization_id,action,resource_type,resource_id,details) VALUES($1,'run.retention.purged','run',$2,'{}'::jsonb)", [run.organization_id, run.id]);
    }
    if (runs.rows.length) {
      await client.query("INSERT INTO artifact_purge_queue(run_id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING", [runs.rows.map((run) => run.id)]);
      await client.query("DELETE FROM runs WHERE id=ANY($1::uuid[])", [runs.rows.map((run) => run.id)]);
    }
    const codeProposals = await client.query("DELETE FROM code_proposals WHERE retention_expires_at <= now() RETURNING organization_id,id");
    for (const proposal of codeProposals.rows) {
      await client.query("INSERT INTO audit_events(organization_id,action,resource_type,resource_id,details) VALUES($1,'code-proposal.retention.purged','code-proposal',$2,'{}'::jsonb)", [proposal.organization_id, proposal.id]);
    }
    const proposalUsage = await client.query("DELETE FROM code_proposal_usage WHERE usage_date < (now() AT TIME ZONE 'UTC')::date - 30");
    const visualReviews = await client.query("DELETE FROM visual_reviews WHERE retention_expires_at <= now() RETURNING organization_id,id");
    for (const review of visualReviews.rows) {
      await client.query("INSERT INTO audit_events(organization_id,action,resource_type,resource_id,details) VALUES($1,'visual-review.retention.purged','visual-review',$2,'{}'::jsonb)", [review.organization_id, review.id]);
    }
    const reviewUsage = await client.query("DELETE FROM visual_review_usage WHERE usage_date < (now() AT TIME ZONE 'UTC')::date - 30");
    return { sessions: sessions.rowCount ?? 0, shares: shares.rowCount ?? 0, shareRequestBuckets: shareRequestBuckets.rowCount ?? 0, anonymousShareRequestBuckets: anonymousShareRequestBuckets.rowCount ?? 0, runs: runs.rows, runCount: runs.rowCount ?? 0, visualReviews: visualReviews.rowCount ?? 0, reviewUsage: reviewUsage.rowCount ?? 0, codeProposals: codeProposals.rowCount ?? 0, proposalUsage: proposalUsage.rowCount ?? 0 };
  });
  let artifactDirectories = 0;
  let artifactObjects = 0;
  if (artifactStore || artifactRoot) {
    const pending = await pool.query("SELECT run_id AS id FROM artifact_purge_queue ORDER BY requested_at LIMIT 100");
    for (const run of pending.rows) {
      if (!/^[0-9a-f-]{36}$/i.test(run.id)) continue;
      if (artifactStore) {
        artifactObjects += await artifactStore.deleteRun(run.id);
      }
      if (artifactRoot) {
        const directory = path.join(artifactRoot, run.id);
        try {
          const info = await lstat(directory);
          if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("run artifact path is not a normal directory");
          await rm(directory, { recursive: true, force: true });
          artifactDirectories += 1;
        } catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
      await pool.query("DELETE FROM artifact_purge_queue WHERE run_id=$1", [run.id]);
    }
  }
  const result = { ...deleted, artifactDirectories, artifactObjects };
  delete result.runs;
  return result;
}

export function startRetentionMaintenance(pool, logger = console, intervalMs = 60 * 60 * 1000, options = {}) {
  let stopped = false;
  let inFlight;
  const run = () => {
    if (stopped || inFlight) return inFlight;
    inFlight = purgeExpiredRecords(pool, options)
      .then((deleted) => { if (Object.values(deleted).some(Boolean)) logger.info({ deleted }, "expired control-plane records purged"); })
      .catch((error) => { logger.error({ err: error }, "retention purge failed; it will retry on the next interval"); })
      .finally(() => { inFlight = undefined; });
    return inFlight;
  };
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return async () => { stopped = true; clearInterval(timer); await inFlight; };
}
