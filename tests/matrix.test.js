/**
 * Matrix harness accounting — offline. `harnessErrorRow` is the quarantine
 * contract: a profile the harness could not run must still be a complete row
 * (rule 1 blocks the absence; nothing downstream may crash on it), and the
 * message must carry both the attempt count and the cause.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { harnessErrorRow } from "../src/runner/run-matrix.js";

const step = (over = {}) => ({
  profile: { id: "low-cpu-3g", label: "Low-CPU" },
  runKind: "adaptive",
  forcedTier: null,
  ...over,
});

test("a quarantined row is shape-complete with no trace", () => {
  const row = harnessErrorRow(step(), "low-cpu-3g", "trace-1", "CDP connection closed", 2, process.hrtime.bigint());
  assert.equal(row.runId, "low-cpu-3g");
  assert.equal(row.profileId, "low-cpu-3g");
  assert.equal(row.tracePath, null);
  assert.equal(row.verdict, null);
  assert.equal(row.metrics, null);
  assert.equal(row.decision, null);
  assert.deepEqual(row.screenshots, {});
  assert.deepEqual(row.pageErrors, []);
  assert.match(row.error, /2 attempt\(s\)/);
  assert.match(row.error, /CDP connection closed/);
  assert.equal(typeof row.wallMs, "number");
});

test("a single failed attempt still quarantines, naming one attempt", () => {
  const row = harnessErrorRow(step(), "x", "t", "boom", 1, process.hrtime.bigint());
  assert.match(row.error, /1 attempt\(s\)/);
});

test("quarantine rows keep their profile identity for rule 1", () => {
  // The gate blocks "critical profile X produced no trace" — it can only do
  // that if the row says which profile was lost.
  const row = harnessErrorRow(
    step({ profile: { id: "xr-denied", label: "XR denied" } }),
    "xr-denied",
    "t",
    "timeout",
    3,
    process.hrtime.bigint(),
  );
  assert.equal(row.profileId, "xr-denied");
  assert.equal(row.runKind, "adaptive");
});
