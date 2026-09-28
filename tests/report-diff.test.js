import test from "node:test";
import assert from "node:assert/strict";
import { assessComparability, diffReports } from "../src/report/diff.js";

/**
 * A minimal but shape-accurate matrix report. Every field the diff reads is
 * present, so a test that passes here is testing the diff and not a typo.
 */
const report = (/** @type {any} */ over = {}) => ({
  kind: "atlas.matrix-report",
  schemaVersion: 1,
  startedAtIso: "2026-09-28T10:00:00.000Z",
  seed: 1234,
  reproduce: "node bin/atlas.js matrix --target examples/target-contract.json",
  manifest: { id: "atlas.generic", version: 1, contentHash: "aaaaaaaaaaaaaaaa" },
  engine: { mode: "rules", name: "rule-based", kind: "deterministic", status: "ok" },
  runnerBuildId: "7adff4a",
  environment: { node: "v22.11.0", platform: "win32-x64", chromeProduct: "Chrome/140.0.7339.80", headless: true },
  target: { contractHash: "cccccccccccccccc", contract: { id: "acme-staging", buildId: "7adff4a" } },
  runs: [],
  ...over,
});

const run = (/** @type {any} */ over = {}) => ({
  runId: "r-1",
  profileId: "mid-android-4g",
  runKind: "adaptive",
  tracePath: "artifacts/traces/r-1/trace.json",
  determinismHash: "d1",
  causalHash: "c1",
  servedTier: "mid",
  targetScore: 62,
  verdict: { outcome: { value: "pass" }, releaseBlocking: { value: "minor" } },
  drive: { journeyOutcome: "pass" },
  metrics: { firstFrameMs: 900, ttiMs: 1800, p95InteractionMs: 120, sustainedFps: 52, droppedFrames: 4 },
  pageErrors: [],
  error: null,
  ...over,
});

/* ── comparability is computed before any delta ──────────────────────────── */

test("two identical-identity reports are comparable", () => {
  const c = assessComparability(report(), report());
  assert.equal(c.comparable, true, c.blocking.map((b) => b.reason).join("; "));
  assert.deepEqual(c.blocking, []);
  assert.match(c.note, /attributable to the application/);
});

test("any fatal identity mismatch makes the comparison confounded", () => {
  const cases = {
    manifest: { manifest: { id: "x", version: 2, contentHash: "bbbbbbbbbbbbbbbb" } },
    contract: { target: { contractHash: "dddddddddddddddd", contract: { id: "acme-staging" } } },
    atlasEngine: { engine: { mode: "guarded-jev", name: "guarded", kind: "model", status: "ok" } },
    atlasBuild: { runnerBuildId: "b0e64d9" },
    chrome: { environment: { node: "v22.11.0", platform: "win32-x64", chromeProduct: "Chrome/141.0.0.0", headless: true } },
    headless: { environment: { node: "v22.11.0", platform: "win32-x64", chromeProduct: "Chrome/140.0.7339.80", headless: false } },
  };
  for (const [key, over] of Object.entries(cases)) {
    const c = assessComparability(report(), report(over));
    assert.equal(c.comparable, false, `${key} must block attribution`);
    assert.ok(c.blocking.some((b) => b.key === key), `${key} should appear in blocking, got ${c.blocking.map((b) => b.key)}`);
    assert.ok(c.blocking.every((b) => b.why.length > 20), "each blocker must say why it matters");
  }
});

test("a seed or Node change is advisory, not disqualifying", () => {
  const c = assessComparability(report(), report({ seed: 99 }));
  assert.equal(c.comparable, true);
  assert.ok(c.advisory.some((a) => a.key === "seed"));
});

test("an identity that is unrecorded on both sides is not treated as a match", () => {
  // Two runs that both failed to record their Atlas build are two runs whose
  // Atlas build is unknown. The acceptance gate asks for reportable identities;
  // silence is not one.
  const c = assessComparability(report({ runnerBuildId: null }), report({ runnerBuildId: null }));
  assert.equal(c.comparable, false);
  assert.match(c.blocking.map((b) => b.reason).join(" "), /unrecorded on both runs/);
});

/* ── the headline refuses to claim an improvement it cannot attribute ────── */

test("a genuine fix on a comparable pair reads as improved", () => {
  const before = report({ runs: [run({ verdict: { outcome: { value: "fail" } }, drive: { journeyOutcome: "fail" }, targetScore: 31 })] });
  const after = report({ runs: [run({ targetScore: 78, causalHash: "c2", determinismHash: "d2" })] });
  const diff = diffReports(before, after);
  assert.equal(diff.headline, "improved");
  assert.equal(diff.counts.fixed, 1);
  assert.equal(diff.profiles[0].status, "fixed");
  assert.equal(diff.comparability.comparable, true);
});

test("the same delta with Atlas changed underneath reads as confounded, not improved", () => {
  // This is the case the module exists for: subtracting two scores across an
  // Atlas upgrade produces a flattering number that measures nothing.
  const before = report({ runs: [run({ verdict: { outcome: { value: "fail" } }, drive: { journeyOutcome: "fail" }, targetScore: 31 })] });
  const after = report({ runnerBuildId: "b0e64d9", runs: [run({ targetScore: 78 })] });
  const diff = diffReports(before, after);
  assert.equal(diff.headline, "confounded");
  // The deltas are still reported — hiding real numbers helps nobody.
  assert.equal(diff.counts.fixed, 1);
  assert.match(diff.comparability.note, /not attributable/);
  assert.match(diff.$limitations, /may be attributed to the application/);
});

test("a regression is reported as such even when other profiles improved", () => {
  const before = report({
    runs: [run({ profileId: "mid-android-4g" }), run({ profileId: "low-cpu-3g", runId: "r-2", verdict: { outcome: { value: "fail" } } })],
  });
  const after = report({
    runs: [
      run({ profileId: "mid-android-4g", verdict: { outcome: { value: "fail" } }, drive: { journeyOutcome: "fail" } }),
      run({ profileId: "low-cpu-3g", runId: "r-2" }),
    ],
  });
  const diff = diffReports(before, after);
  assert.equal(diff.headline, "regressed");
  assert.equal(diff.counts.regressed, 1);
  assert.equal(diff.counts.fixed, 1);
});

/* ── hashes separate behaviour change from timing change ─────────────────── */

test("same causal hash with a different determinism hash is a timing change", () => {
  const diff = diffReports(
    report({ runs: [run()] }),
    report({ runs: [run({ determinismHash: "d2", metrics: { firstFrameMs: 600, ttiMs: 1800, p95InteractionMs: 120, sustainedFps: 52, droppedFrames: 4 } })] }),
  );
  const p = diff.profiles[0];
  assert.equal(p.hashes.causalChanged, false);
  assert.equal(p.hashes.determinismChanged, true);
  assert.match(p.hashes.reading, /performance change with no behaviour change/);
  assert.equal(p.behaviourChanged, false);
  assert.equal(p.status, "changed");
});

test("a changed causal hash is called a behaviour change regardless of the score", () => {
  const diff = diffReports(report({ runs: [run()] }), report({ runs: [run({ causalHash: "c9", determinismHash: "d9", targetScore: 95 })] }));
  assert.equal(diff.profiles[0].hashes.causalChanged, true);
  assert.match(diff.profiles[0].hashes.reading, /structurally different/);
});

/* ── absence is never a number ───────────────────────────────────────────── */

test("a metric present on only one side is skipped, not zeroed", () => {
  const diff = diffReports(
    report({ runs: [run({ metrics: { firstFrameMs: 900, sustainedFps: 52 } })] }),
    report({ runs: [run({ metrics: { firstFrameMs: 700 } })] }),
  );
  const keys = diff.profiles[0].metrics.map((m) => m.key);
  assert.deepEqual(keys, ["firstFrameMs"]);
  const ff = diff.profiles[0].metrics[0];
  assert.equal(ff.delta, -200);
  assert.equal(ff.direction, "better");
});

test("higher-is-better metrics are not read as regressions when they rise", () => {
  const diff = diffReports(
    report({ runs: [run({ metrics: { sustainedFps: 30 } })] }),
    report({ runs: [run({ metrics: { sustainedFps: 58 } })] }),
  );
  assert.equal(diff.profiles[0].metrics[0].direction, "better");
});

test("a harness failure on either side is inconclusive, not a regression", () => {
  const diff = diffReports(
    report({ runs: [run()] }),
    report({ runs: [run({ error: "harness failed after 2 attempt(s): target closed", verdict: null, metrics: null })] }),
  );
  assert.equal(diff.profiles[0].status, "inconclusive");
  assert.equal(diff.counts.regressed, 0);
});

test("the baseline run is excluded, because its delta measures nothing about a fix", () => {
  const diff = diffReports(
    report({ runs: [run(), run({ profileId: "baseline", runKind: "baseline", runId: "r-b", verdict: { outcome: { value: "fail" } } })] }),
    report({ runs: [run(), run({ profileId: "baseline", runKind: "baseline", runId: "r-b" })] }),
  );
  assert.equal(diff.counts.total, 1);
  assert.deepEqual(diff.profiles.map((p) => p.profileId), ["mid-android-4g"]);
});

test("profiles present on one side only are added or removed, never compared", () => {
  const diff = diffReports(
    report({ runs: [run({ profileId: "mid-android-4g" })] }),
    report({ runs: [run({ profileId: "low-cpu-3g" })] }),
  );
  const statuses = Object.fromEntries(diff.profiles.map((p) => [p.profileId, p.status]));
  assert.deepEqual(statuses, { "low-cpu-3g": "added", "mid-android-4g": "removed" });
  assert.equal(diff.counts.added, 1);
  assert.equal(diff.counts.removed, 1);
});

test("two byte-identical reports are unchanged, and say so", () => {
  const diff = diffReports(report({ runs: [run()] }), report({ runs: [run()] }));
  assert.equal(diff.headline, "unchanged");
  assert.equal(diff.counts.unchanged, 1);
  assert.equal(diff.profiles[0].hashes.causalChanged, false);
  assert.equal(diff.profiles[0].hashes.determinismChanged, false);
});

test("a non-matrix document is refused rather than silently diffed", () => {
  assert.throws(() => diffReports(null, report()), /before report is not an object/);
  assert.throws(() => diffReports(report(), { kind: "atlas.release-gate" }), /no runs array/);
});
