import test from "node:test";
import assert from "node:assert/strict";
import { assertInternalJobNetwork, assertProxyNetworkAttachments, assertWorkerNetworkAttachments, claimNextRun, heartbeatRun, recoverExpiredRuns } from "../src/local-worker.js";

test("worker topology requires an internal network and one isolated worker attachment", () => {
  assert.doesNotThrow(() => assertInternalJobNetwork({ Internal: true }));
  assert.throws(() => assertInternalJobNetwork({ Internal: false }), /not Docker-internal/);
  assert.doesNotThrow(() => assertWorkerNetworkAttachments({ "atlas-job-1": {} }, "atlas-job-1"));
  assert.throws(() => assertWorkerNetworkAttachments({ "atlas-job-1": {}, bridge: {} }, "atlas-job-1"), /unexpected Docker network attachment/);
});

test("egress proxy may bridge only the default and current job network", () => {
  const safe = { bridge: {}, "atlas-job-1": { IPAddress: "172.18.0.2" } };
  assert.doesNotThrow(() => assertProxyNetworkAttachments(safe, "atlas-job-1"));
  assert.throws(() => assertProxyNetworkAttachments({ ...safe, database: {} }, "atlas-job-1"), /unexpected Docker network attachment/);
  assert.throws(() => assertProxyNetworkAttachments({ bridge: {}, "atlas-job-1": { IPAddress: "invalid" } }, "atlas-job-1"), /no isolated job-network address/);
});

test("queue claims atomically with SKIP LOCKED and a bounded lease", async () => {
  let call;
  const pool = { async query(sql, params) { call = { sql, params }; return { rows: [{ id: "run-1", attempt_count: 1 }] }; } };
  const run = await claimNextRun(pool, "worker:one");
  assert.equal(run.id, "run-1");
  assert.match(call.sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(call.sql, /lease_expires_at=now\(\)\+interval '2 minutes'/);
  assert.deepEqual(call.params, ["worker:one", 2]);
});

test("a heartbeat can extend only the lease owned by that worker", async () => {
  let call;
  const pool = { async query(sql, params) { call = { sql, params }; return { rowCount: 1, rows: [{ cancelled: false }] }; } };
  assert.equal(await heartbeatRun(pool, "run-1", "worker:one"), false);
  assert.match(call.sql, /status='running' AND worker_id=\$2/);
  assert.deepEqual(call.params, ["run-1", "worker:one"]);
  pool.query = async () => ({ rowCount: 0 });
  await assert.rejects(heartbeatRun(pool, "run-1", "worker:other"), /lease was lost/);
});

test("expired leases are reserved while orphan Docker resources are removed, then retried", async () => {
  const statements = [];
  const pool = { async query(sql, params) {
    statements.push({ sql, params });
    if (sql.includes("WITH expired AS")) return { rows: [{ id: "run-1", attempt_count: 1 }] };
    if (sql.includes("UPDATE runs SET status=CASE")) return { rowCount: 1, rows: [{ organization_id: "org-1", status: "queued" }] };
    return { rowCount: 0 };
  } };
  const calls = [];
  const result = await recoverExpiredRuns(pool, { docker: "docker", call: async (_docker, args) => {
    calls.push(args);
    if (args[0] === "ps") return "container-1";
    if (args[0] === "network") return "network-1";
    return "";
  } });
  assert.equal(result, 1);
  assert.match(statements[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(statements[0].sql, /worker_id=\$1,lease_expires_at=now\(\)\+interval '2 minutes'/);
  assert.deepEqual(calls, [
    ["ps", "--all", "--quiet", "--filter", "label=atlas.run=run-1"],
    ["rm", "--force", "container-1"],
    ["network", "ls", "--quiet", "--filter", "label=atlas.run=run-1"],
    ["network", "rm", "network-1"],
  ]);
  const finish = statements.find((entry) => entry.sql.includes("UPDATE runs SET status=CASE"));
  assert.equal(finish.params[0], "run-1");
  assert.equal(finish.params[2], false);
});

test("an exhausted expired lease becomes failed and explicitly INCONCLUSIVE", async () => {
  let final;
  const pool = { async query(sql, params) {
    if (sql.includes("WITH expired AS")) return { rows: [{ id: "run-2", attempt_count: 2 }] };
    if (sql.includes("UPDATE runs SET status=CASE")) { final = params; return { rowCount: 1, rows: [{ organization_id: "org-1", status: "failed" }] }; }
    return { rowCount: 1 };
  } };
  await recoverExpiredRuns(pool, { call: async () => "" });
  assert.equal(final[2], true);
});
