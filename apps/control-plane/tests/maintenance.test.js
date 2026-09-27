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
          return { rowCount: 1, rows: [] };
        },
        release() {},
      };
    },
  };
  const result = await purgeExpiredRecords(pool);
  assert.deepEqual(result, { sessions: 2, shares: 1, runs: 1 });
  const deleteRuns = calls.find((call) => call.sql.includes("DELETE FROM runs"));
  assert.match(deleteRuns.sql, /retention_expires_at <= now\(\)/);
  assert.match(deleteRuns.sql, /status <> 'running'/);
  const audit = calls.find((call) => call.sql.includes("run.retention.purged"));
  assert.deepEqual(audit.params, ["org-1", "run-1"]);
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-1).sql, "COMMIT");
});
