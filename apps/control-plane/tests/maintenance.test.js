import test from "node:test";
import assert from "node:assert/strict";
import { purgeExpiredRecords } from "../src/maintenance.js";

test("retention purge removes expired non-running rows and records a minimal audit event", async () => {
  const calls = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          calls.push({ sql, params });
          if (sql.includes("DELETE FROM sessions")) return { rowCount: 2, rows: [] };
          if (sql.includes("DELETE FROM share_links")) return { rowCount: 1, rows: [] };
          if (sql.includes("SELECT organization_id,id FROM runs")) return { rowCount: 1, rows: [{ organization_id: "org-1", id: "123e4567-e89b-42d3-a456-426614174000" }] };
          if (sql.includes("DELETE FROM visual_reviews")) return { rowCount: 1, rows: [{ organization_id: "org-1", id: "review-1" }] };
          if (sql.includes("DELETE FROM visual_review_usage")) return { rowCount: 2, rows: [] };
          if (sql.includes("DELETE FROM code_proposals")) return { rowCount: 1, rows: [{ organization_id: "org-1", id: "proposal-1" }] };
          if (sql.includes("DELETE FROM code_proposal_usage")) return { rowCount: 3, rows: [] };
          return { rowCount: 1, rows: [] };
        },
        release() {},
      };
    },
  };
  const result = await purgeExpiredRecords(pool);
  assert.deepEqual(result, { sessions: 2, shares: 1, shareRequestBuckets: 1, anonymousShareRequestBuckets: 1, runCount: 1, codeProposals: 1, proposalUsage: 3, visualReviews: 1, reviewUsage: 2, artifactDirectories: 0, artifactObjects: 0 });
  const selectRuns = calls.find((call) => call.sql.includes("SELECT organization_id,id FROM runs"));
  assert.match(selectRuns.sql, /retention_expires_at <= now\(\)/);
  assert.match(selectRuns.sql, /status <> 'running'/);
  const audit = calls.find((call) => call.sql.includes("run.retention.purged"));
  assert.deepEqual(audit.params, ["org-1", "123e4567-e89b-42d3-a456-426614174000"]);
  const reviewAudit = calls.find((call) => call.sql.includes("visual-review.retention.purged"));
  assert.deepEqual(reviewAudit.params, ["org-1", "review-1"]);
  assert.match(calls.find((call) => call.sql.includes("DELETE FROM visual_review_usage")).sql, /usage_date < .* - 30/);
  assert.match(calls.find((call) => call.sql.includes("DELETE FROM shared_report_request_buckets")).sql, /bucket_start < date_trunc\('minute', now\(\)\) - interval '2 minutes'/);
  assert.match(calls.find((call) => call.sql.includes("DELETE FROM anonymous_share_request_buckets")).sql, /bucket_start < date_trunc\('minute', now\(\)\) - interval '2 minutes'/);
  const proposalAudit = calls.find((call) => call.sql.includes("code-proposal.retention.purged"));
  assert.deepEqual(proposalAudit.params, ["org-1", "proposal-1"]);
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("artifact purge uses a retryable database outbox and removes only the exact run directory", async () => {
  const { mkdtemp, mkdir, writeFile, rm, access } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "atlas-retention-test-"));
  const runId = "123e4567-e89b-42d3-a456-426614174001";
  const runDirectory = path.join(root, runId);
  await mkdir(runDirectory);
  await writeFile(path.join(runDirectory, "trace.json"), "private evidence");
  const calls = [];
  const pool = {
    async connect() { return { async query(sql) { calls.push(sql); if (sql.includes("SELECT organization_id,id FROM runs")) return { rowCount: 0, rows: [] }; return { rowCount: 0, rows: [] }; }, release() {} }; },
    async query(sql) { calls.push(sql); if (sql.includes("SELECT run_id AS id FROM artifact_purge_queue")) return { rows: [{ id: runId }], rowCount: 1 }; return { rows: [], rowCount: 1 }; },
  };
  try {
    const result = await purgeExpiredRecords(pool, { artifactRoot: root });
    assert.equal(result.artifactDirectories, 1);
    assert.equal(result.artifactObjects, 0);
    await assert.rejects(access(runDirectory));
    assert.ok(calls.some((sql) => sql.includes("DELETE FROM artifact_purge_queue")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retention leaves remote purge work queued until S3-compatible prefix deletion succeeds", async () => {
  const runId = "423e4567-e89b-42d3-a456-426614174000";
  const calls = [];
  let deleteFails = true;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          calls.push(sql);
          if (sql.includes("SELECT organization_id,id FROM runs")) return { rows: [{ organization_id: "org-1", id: runId }], rowCount: 1 };
          return { rows: [], rowCount: sql.startsWith("DELETE") ? 1 : 0 };
        },
        release() {},
      };
    },
    async query(sql) {
      calls.push(sql);
      if (sql.includes("SELECT run_id AS id FROM artifact_purge_queue")) return { rows: [{ id: runId }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const artifactStore = { async deleteRun(id) { assert.equal(id, runId); if (deleteFails) throw new Error("temporary object-store outage"); return 2; } };
  await assert.rejects(purgeExpiredRecords(pool, { artifactStore }), /temporary object-store outage/);
  assert.equal(calls.some((sql) => sql.includes("DELETE FROM artifact_purge_queue")), false);
  deleteFails = false;
  const result = await purgeExpiredRecords(pool, { artifactStore });
  assert.equal(result.runCount, 1);
  assert.equal(result.artifactObjects, 2);
  assert.ok(calls.some((sql) => sql.includes("DELETE FROM artifact_purge_queue")));
});
