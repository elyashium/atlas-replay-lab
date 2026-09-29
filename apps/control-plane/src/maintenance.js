import { inTransaction } from "./db.js";

/** Purge expired private metadata. Artifact blobs are not connected yet. */
export async function purgeExpiredRecords(pool) {
  return inTransaction(pool, async (client) => {
    const sessions = await client.query("DELETE FROM sessions WHERE expires_at <= now()");
    const shares = await client.query("DELETE FROM share_links WHERE expires_at <= now() OR revoked_at IS NOT NULL");
    const runs = await client.query("DELETE FROM runs WHERE retention_expires_at <= now() AND status <> 'running' RETURNING organization_id,id");
    for (const run of runs.rows) {
      await client.query("INSERT INTO audit_events(organization_id,action,resource_type,resource_id,details) VALUES($1,'run.retention.purged','run',$2,'{}'::jsonb)", [run.organization_id, run.id]);
    }
    const visualReviews = await client.query("DELETE FROM visual_reviews WHERE retention_expires_at <= now() RETURNING organization_id,id");
    for (const review of visualReviews.rows) {
      await client.query("INSERT INTO audit_events(organization_id,action,resource_type,resource_id,details) VALUES($1,'visual-review.retention.purged','visual-review',$2,'{}'::jsonb)", [review.organization_id, review.id]);
    }
    const reviewUsage = await client.query("DELETE FROM visual_review_usage WHERE usage_date < (now() AT TIME ZONE 'UTC')::date - 30");
    return { sessions: sessions.rowCount ?? 0, shares: shares.rowCount ?? 0, runs: runs.rowCount ?? 0, visualReviews: visualReviews.rowCount ?? 0, reviewUsage: reviewUsage.rowCount ?? 0 };
  });
}

export function startRetentionMaintenance(pool, logger = console, intervalMs = 60 * 60 * 1000) {
  let stopped = false;
  let inFlight;
  const run = () => {
    if (stopped || inFlight) return inFlight;
    inFlight = purgeExpiredRecords(pool)
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
