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
          if (sql.includes("DELETE FROM runs")) return { rowCount: 1, rows: [{ organization_id: "org-1", id: "run-1" }] };
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
  assert.deepEqual(result, { sessions: 2, shares: 1, runs: 1, codeProposals: 1, proposalUsage: 3, visualReviews: 1, reviewUsage: 2 });
  const deleteRuns = calls.find((call) => call.sql.includes("DELETE FROM runs"));
  assert.match(deleteRuns.sql, /retention_expires_at <= now\(\)/);
  assert.match(deleteRuns.sql, /status <> 'running'/);
  const audit = calls.find((call) => call.sql.includes("run.retention.purged"));
  assert.deepEqual(audit.params, ["org-1", "run-1"]);
  const reviewAudit = calls.find((call) => call.sql.includes("visual-review.retention.purged"));
  assert.deepEqual(reviewAudit.params, ["org-1", "review-1"]);
  assert.match(calls.find((call) => call.sql.includes("DELETE FROM visual_review_usage")).sql, /usage_date < .* - 30/);
  const proposalAudit = calls.find((call) => call.sql.includes("code-proposal.retention.purged"));
  assert.deepEqual(proposalAudit.params, ["org-1", "proposal-1"]);
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-1).sql, "COMMIT");
});
