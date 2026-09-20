/**
 * The release rule.
 *
 * §5.2 item 7 asks for "a release rule", and a release rule that has never been
 * shown to block anything is a slogan. These tests exercise each numbered rule
 * from `src/gate/release-gate.js` against a hand-built matrix report, including
 * the cases the rule deliberately *declines* to block on — the budget warnings
 * and the excluded baseline — because "what does not stop a release" is the half
 * of a gate that people get wrong.
 *
 * The gate reads captured JSON and nothing else: no browser, no re-judging. So
 * it is testable in full without Chrome, which is the reason it was written as a
 * separate stage in the first place.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, rm } from "node:fs/promises";

import { runGate, BLOCKING_SEVERITY_INDEX, DECISION_CONFIDENCE_FLOOR } from "../src/gate/release-gate.js";
import { SEVERITY_LEVELS, ROOT_CAUSE_OPTIONS } from "../src/decision/questions.js";
import { PROFILES } from "../src/runner/profiles.js";
import { orbitalManifest } from "../src/manifest/atlas-orbital.manifest.js";

const CRITICAL = PROFILES.filter((p) => p.critical).map((p) => p.id);

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** @param {string} value @param {number} [p] */
const choice = (value, p = 0.9) => ({ value, distribution: { [value]: p, other: 1 - p } });

/**
 * Root causes are drawn from the real vocabulary. A fixture that invented one
 * would be testing the gate against data the judge can never produce, which is
 * the quiet way a test suite stops describing the system it guards.
 *
 * @param {string} value @param {number} [p]
 */
function rootCause(value, p = 0.9) {
  assert.ok(ROOT_CAUSE_OPTIONS.includes(value), `"${value}" is not a declared root cause`);
  return choice(value, p);
}

/** @param {number} score */
const score = (score) => ({
  score,
  levels: SEVERITY_LEVELS,
  distribution: Object.fromEntries(SEVERITY_LEVELS.map((l, i) => [l, i === Math.round(score) ? 0.8 : 0.05])),
});

/** Metrics comfortably inside every budget. */
function goodMetrics(over = {}) {
  return {
    firstFrameMs: 700,
    timeToInteractiveMs: 1800,
    p95InteractionMs: 120,
    transferBytes: 900_000,
    jsHeapUsedMB: 110,
    droppedFrameRatio: 0.04,
    assetFailures: 0,
    framesRendered: 600,
    framesDropped: 24,
    interactionCount: 6,
    reachedEndState: true,
    stepsToEndState: 3,
    firstFrameNonBlank: true,
  };
}

/** A run that clears every rule. @param {string} profileId @param {any} [over] */
function passingRun(profileId, over = {}) {
  const { metrics, verdict, decision, ...rest } = over;
  return {
    runId: `${profileId}--adaptive`,
    profileId,
    runKind: "adaptive",
    tracePath: `artifacts/matrix/${profileId}/trace.json`,
    servedTier: "high",
    servedPath: "camera-xr",
    pageErrors: [],
    metrics: { ...goodMetrics(), ...metrics },
    verdict: {
      outcome: choice("pass"),
      rootCause: choice("unknown"),
      releaseBlocking: score(0),
      ...verdict,
    },
    decision: { engine: "rule-based", confidence: 0.82, guard: null, ...decision },
    ...rest,
  };
}

/** @param {any[]} runs */
function matrixReport(runs) {
  return {
    kind: "atlas.matrix",
    startedAtIso: "2026-01-01T00:00:00.000Z",
    engine: { name: "rule-based", kind: "deterministic" },
    manifest: { contentHash: orbitalManifest.contentHash },
    runs,
  };
}

/** Every critical profile passing — the baseline "this should ship" report. */
const allPassing = () => CRITICAL.map((id) => passingRun(id));

/**
 * Write a matrix report to a throwaway directory and run the gate against it.
 * `replayReportPath: null` is the default so a stale `artifacts/replay/` in the
 * working tree cannot leak into a test result.
 *
 * @param {any} t
 * @param {any[]} runs
 * @param {any} [opts]
 */
async function gate(t, runs, opts = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atlas-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const matrixPath = path.join(dir, "report.json");
  await writeFile(matrixPath, JSON.stringify(matrixReport(runs)), "utf8");
  return runGate({
    matrixReportPath: matrixPath,
    replayReportPath: null,
    outDir: path.join(dir, "gate"),
    quiet: true,
    ...opts,
  });
}

/** @param {any} report @param {string} rule */
const byRule = (report, rule) => report.findings.filter((/** @type {any} */ f) => f.rule === rule);
/** @param {any} report */
const blocks = (report) => report.findings.filter((/** @type {any} */ f) => f.severity === "block");

/* ── the happy path ───────────────────────────────────────────────────────── */

test("a clean matrix ships", async (t) => {
  const { report, shipped } = await gate(t, allPassing());
  assert.equal(shipped, true, JSON.stringify(blocks(report), null, 2));
  assert.equal(report.decision, "ship");
  assert.deepEqual(report.findings, []);
  assert.equal(report.counts.graded, CRITICAL.length);
});

test("the report states the rule it applied, not just the outcome", async (t) => {
  // A gate result that cannot be audited later is a number without provenance.
  const { report, reportPath } = await gate(t, allPassing());
  assert.equal(report.kind, "atlas.release-gate");
  assert.equal(report.rule.blockingSeverityIndex, BLOCKING_SEVERITY_INDEX);
  assert.equal(report.rule.blockingSeverityLevel, "major");
  assert.equal(report.rule.decisionConfidenceFloor, DECISION_CONFIDENCE_FLOOR);
  assert.deepEqual([...report.rule.criticalProfiles].sort(), [...CRITICAL].sort());
  assert.ok(report.rule.baselineExcluded.length > 0);
  assert.equal(report.reproduce, "node bin/atlas.js gate");
  assert.equal(report.source.manifestHash, orbitalManifest.contentHash);
  assert.ok(reportPath.endsWith("report.json"));
});

test("artifact paths in the report are POSIX-shaped on every platform", async (t) => {
  // The report is read on a machine that is not the one that wrote it.
  const { report } = await gate(t, allPassing());
  assert.equal(report.source.matrixReport.includes("\\"), false, report.source.matrixReport);
});

/* ── rule 1: coverage ─────────────────────────────────────────────────────── */

test("a critical profile that never ran blocks the release", async (t) => {
  const runs = allPassing().filter((r) => r.profileId !== "low-cpu-3g");
  const { report, shipped } = await gate(t, runs);
  assert.equal(shipped, false);
  const found = byRule(report, "1-coverage");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "block");
  assert.match(found[0].message, /low-cpu-3g/);
});

test("a run that crashed and produced no trace is an absence of evidence, not a pass", async (t) => {
  // The failure mode this rule exists for: a harness error leaves a run object
  // with no metrics, and a gate that only inspects verdicts sees nothing wrong.
  const runs = allPassing();
  runs[0] = { ...runs[0], tracePath: null, metrics: null, verdict: null, error: "Chrome exited early" };
  const { report, shipped } = await gate(t, runs);
  assert.equal(shipped, false);
  const found = byRule(report, "1-coverage");
  assert.equal(found[0].severity, "block");
  assert.match(found[0].message, /Chrome exited early/);
});

/* ── rule 2: failures ─────────────────────────────────────────────────────── */

test("a failed critical profile blocks, and the finding names the root cause", async (t) => {
  const runs = allPassing();
  runs[2] = passingRun(runs[2].profileId, {
    verdict: { outcome: choice("fail"), rootCause: rootCause("network", 0.71), releaseBlocking: score(4) },
  });
  const { report, shipped } = await gate(t, runs);
  assert.equal(shipped, false);
  const found = byRule(report, "2-no-failures");
  assert.equal(found[0].severity, "block");
  assert.match(found[0].message, /network/);
  assert.equal(found[0].evidence.rootCause, "network");
  assert.equal(found[0].evidence.rootCauseConfidence, 0.71, "the gate records how sure the judge was");
});

test("a failure on a non-critical profile warns instead of blocking", async (t) => {
  // Everything in PROFILES is currently critical, so this uses an extra run the
  // profile list does not know about — which is also what happens when someone
  // adds an exploratory profile before deciding it is release-gating.
  const runs = [
    ...allPassing(),
    passingRun("experimental-foldable", {
      verdict: { outcome: choice("fail"), rootCause: rootCause("codec-unsupported"), releaseBlocking: score(4) },
    }),
  ];
  const { report, shipped } = await gate(t, runs);
  assert.equal(shipped, true, JSON.stringify(blocks(report)));
  assert.ok(report.findings.some((/** @type {any} */ f) => f.severity === "warn" && f.rule === "2-no-failures"));
});

/* ── rule 3: severity ─────────────────────────────────────────────────────── */

test("the severity threshold is a boundary, not a suggestion", async (t) => {
  const under = allPassing();
  under[1] = passingRun(under[1].profileId, { verdict: { releaseBlocking: score(BLOCKING_SEVERITY_INDEX - 0.01) } });
  assert.equal((await gate(t, under)).shipped, true, "just under major must ship");

  const at = allPassing();
  at[1] = passingRun(at[1].profileId, { verdict: { releaseBlocking: score(BLOCKING_SEVERITY_INDEX) } });
  const { report, shipped } = await gate(t, at);
  assert.equal(shipped, false, "exactly major must block");
  assert.equal(byRule(report, "3-severity")[0].severity, "block");
});

/* ── rule 4: the business invariant ───────────────────────────────────────── */

test("an unreached checkout blocks even when the served tier is the lowest one", async (t) => {
  // The point of the whole ladder: degrading visuals is allowed, losing the
  // business outcome is not. A gate that accepted "well, it was on static
  // fallback" would make the tier system an excuse generator.
  const runs = allPassing();
  runs[3] = passingRun(runs[3].profileId, {
    servedTier: "static-fallback",
    servedPath: "static-safe",
    metrics: { reachedEndState: false, stepsToEndState: null },
    verdict: { outcome: choice("degraded-but-acceptable"), releaseBlocking: score(2) },
    drive: { completed: ["boot", "probing", "routing"], failedAt: "loading" },
  });
  const { report, shipped } = await gate(t, runs);
  assert.equal(shipped, false);
  const found = byRule(report, "4-business-invariant");
  assert.equal(found[0].severity, "block");
  assert.equal(found[0].evidence.failedAt, "loading");
  assert.equal(found[0].evidence.servedTier, "static-fallback");
});

test("taking too many steps to checkout warns — it arrived, just clumsily", async (t) => {
  const runs = allPassing();
  runs[0] = passingRun(runs[0].profileId, {
    metrics: { stepsToEndState: orbitalManifest.invariants.business.maxStepsToEndState + 2 },
  });
  const { report, shipped } = await gate(t, runs);
  assert.equal(shipped, true);
  assert.equal(byRule(report, "4-business-invariant")[0].severity, "warn");
});

/* ── rule 5: inconclusive ─────────────────────────────────────────────────── */

test("\"we don't know\" blocks, with its own reason code", async (t) => {
  // Filed separately from a failure because the fix is usually to the harness,
  // and a team that cannot tell those apart fixes the wrong thing.
  const runs = allPassing();
  runs[4] = passingRun(runs[4].profileId, {
    verdict: { outcome: choice("inconclusive"), releaseBlocking: score(1) },
    error: "trace truncated",
  });
  const { report, shipped } = await gate(t, runs);
  assert.equal(shipped, false);
  const found = byRule(report, "5-inconclusive");
  assert.equal(found[0].severity, "block");
  assert.equal(found[0].evidence.harnessError, "trace truncated");
  assert.equal(byRule(report, "2-no-failures").length, 0, "inconclusive is not a failure");
});

/* ── rule 6: decision confidence ──────────────────────────────────────────── */

test("a guard override is recorded as information, and does not hold the release", async (t) => {
  // The design working as intended. It must be visible — a gate that silently
  // swallows overrides gives no signal when the primary engine starts failing
  // on every run — but it is not a defect in the build.
  const runs = allPassing();
  runs[1] = passingRun(runs[1].profileId, {
    servedTier: "mid",
    decision: {
      engine: "rule-based",
      confidence: 0.79,
      guard: { overridden: true, primaryEngine: "jev", reason: "primary chose a tier the device cannot render" },
    },
  });
  const { report, shipped } = await gate(t, runs);
  assert.equal(shipped, true);
  const found = byRule(report, "6-decision-confidence");
  assert.equal(found[0].severity, "info");
  assert.match(found[0].message, /jev/);
  assert.match(found[0].message, /cannot render/);
});

test("a low-confidence decision that nothing overrode is flagged for a human", async (t) => {
  const runs = allPassing();
  runs[1] = passingRun(runs[1].profileId, {
    servedTier: "mid",
    decision: { engine: "jev", confidence: DECISION_CONFIDENCE_FLOOR - 0.1, guard: { overridden: false } },
  });
  const { report, shipped } = await gate(t, runs);
  assert.equal(shipped, true, "unsure is a warning, not a block — it ships with a note");
  const found = byRule(report, "6-decision-confidence");
  assert.equal(found[0].severity, "warn");
  assert.match(found[0].message, /human look/);
});

test("an override is not double-counted as a low-confidence decision", async (t) => {
  // The two branches are exclusive on purpose: after an override the served
  // confidence belongs to the *replacement* decision, so reading it as the
  // primary engine's uncertainty would be simply wrong.
  const runs = allPassing();
  runs[1] = passingRun(runs[1].profileId, {
    decision: { engine: "rule-based", confidence: 0.2, guard: { overridden: true, primaryEngine: "jev", reason: "primary threw" } },
  });
  const { report } = await gate(t, runs);
  const found = byRule(report, "6-decision-confidence");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "info");
});

test("a confident decision produces no finding at all", async (t) => {
  const { report } = await gate(t, allPassing());
  assert.equal(byRule(report, "6-decision-confidence").length, 0);
});

/* ── budgets: warn, never block ───────────────────────────────────────────── */

test("a run over every single budget still ships", async (t) => {
  // Stated plainly because it is the most counter-intuitive part of the rule:
  // the budgets are high-tier targets, and a low-CPU device on 3G missing them
  // while still completing checkout is the ladder working, not a regression.
  const runs = allPassing();
  runs[2] = passingRun(runs[2].profileId, {
    servedTier: "low",
    metrics: {
      firstFrameMs: 4200,
      timeToInteractiveMs: 9000,
      p95InteractionMs: 640,
      transferBytes: 5_000_000,
      jsHeapUsedMB: 400,
      droppedFrameRatio: 0.55,
      assetFailures: 3,
    },
    verdict: { outcome: choice("degraded-but-acceptable"), releaseBlocking: score(2) },
  });
  const { report, shipped } = await gate(t, runs);
  assert.equal(shipped, true, JSON.stringify(blocks(report)));

  const budget = byRule(report, "budget");
  assert.ok(budget.every((/** @type {any} */ f) => f.severity === "warn"));
  const flagged = new Set(budget.map((/** @type {any} */ f) => f.evidence?.metric ?? f.rule));
  for (const metric of ["firstFrameMs", "timeToInteractiveMs", "p95InteractionMs", "transferBytes", "jsHeapUsedMB"]) {
    assert.ok(flagged.has(metric), `${metric} breach was not reported`);
  }
  assert.ok(budget.some((/** @type {any} */ f) => /droppedFrameRatio/.test(f.message)));
  assert.ok(budget.some((/** @type {any} */ f) => /asset request/.test(f.message)));
});

test("a metric exactly on budget is not a breach", async (t) => {
  const runs = allPassing();
  runs[0] = passingRun(runs[0].profileId, { metrics: { firstFrameMs: orbitalManifest.budgets.firstFrameMs } });
  const { report } = await gate(t, runs);
  assert.equal(byRule(report, "budget").length, 0, "the budget is a ceiling, not an exclusive bound");
});

test("a blank first frame is called out even though the timing number is met", async (t) => {
  const runs = allPassing();
  runs[0] = passingRun(runs[0].profileId, { metrics: { firstFrameMs: 300, firstFrameNonBlank: false } });
  const { report } = await gate(t, runs);
  const found = byRule(report, "budget");
  assert.ok(found.some((/** @type {any} */ f) => /blank/.test(f.message) && /meaningless/.test(f.message)));
});

test("uncaught page errors warn and are sampled, not dumped whole", async (t) => {
  const runs = allPassing();
  runs[0] = passingRun(runs[0].profileId, { pageErrors: Array.from({ length: 12 }, (_, i) => `err ${i}`) });
  const { report, shipped } = await gate(t, runs);
  assert.equal(shipped, true);
  const found = byRule(report, "page-errors");
  assert.equal(found[0].severity, "warn");
  assert.match(found[0].message, /12/);
  assert.equal(found[0].evidence.length, 5, "a gate report is a summary, not a log file");
});

/* ── the baseline ─────────────────────────────────────────────────────────── */

test("the baseline run is excluded from grading by design", async (t) => {
  // The baseline bypasses the router on purpose: it is the "before" half of the
  // failure story. Grading it would mean the gate can never pass, which would
  // make the whole rule decorative.
  const runs = [
    ...allPassing(),
    {
      ...passingRun("low-cpu-3g", {
        verdict: { outcome: choice("fail"), rootCause: rootCause("render-stall"), releaseBlocking: score(4) },
        metrics: { reachedEndState: false },
      }),
      runId: "low-cpu-3g--baseline",
      runKind: "baseline",
    },
  ];
  const { report, shipped } = await gate(t, runs);
  assert.equal(shipped, true, JSON.stringify(blocks(report)));
  assert.equal(report.counts.graded, CRITICAL.length, "the baseline is not counted as a graded run");
  assert.equal(report.baseline.runId, "low-cpu-3g--baseline");
  assert.equal(report.baseline.outcome, "fail");
  assert.equal(report.baseline.reachedEndState, false);
  assert.equal(
    report.findings.some((/** @type {any} */ f) => f.runId === "low-cpu-3g--baseline"),
    false,
    "no finding may reference the baseline",
  );
});

test("a baseline run does not satisfy the coverage rule for its profile", async (t) => {
  // The subtle version of the same idea: a profile whose *only* run was the
  // baseline has not been shown to work.
  const runs = [
    ...allPassing().filter((r) => r.profileId !== "low-cpu-3g"),
    { ...passingRun("low-cpu-3g"), runId: "low-cpu-3g--baseline", runKind: "baseline" },
  ];
  const { report, shipped } = await gate(t, runs);
  assert.equal(shipped, false);
  assert.match(byRule(report, "1-coverage")[0].message, /low-cpu-3g/);
});

/* ── rule 7: replay ───────────────────────────────────────────────────────── */

/** @param {any} t @param {any} verdict @param {any} [comparison] */
async function withReplay(t, verdict, comparison) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atlas-replay-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const replayPath = path.join(dir, "report.json");
  await writeFile(
    replayPath,
    JSON.stringify({ runId: "low-cpu-3g--replay", verdict, comparison }),
    "utf8",
  );
  return gate(t, allPassing(), { replayReportPath: replayPath });
}

test("a replay that did not reproduce blocks the release", async (t) => {
  // If replay cannot reproduce a captured session, every "we fixed it, here is
  // the proof" claim in the README is unsupported.
  const { report, shipped } = await withReplay(
    t,
    { reproduced: false, reason: "state sequence diverged at index 4" },
    { timedMatch: false },
  );
  assert.equal(shipped, false);
  const found = byRule(report, "7-replay");
  assert.equal(found[0].severity, "block");
  assert.match(found[0].message, /index 4/);
});

test("a causal reproduction with different timing is expected, and says so", async (t) => {
  const { report, shipped } = await withReplay(t, { reproduced: true, reason: "ok" }, { timedMatch: false });
  assert.equal(shipped, true);
  const found = byRule(report, "7-replay");
  assert.equal(found[0].severity, "info");
  assert.match(found[0].message, /ADR-0004/, "the reader is pointed at why this is not a defect");
});

test("an exact replay produces no replay finding", async (t) => {
  const { report } = await withReplay(t, { reproduced: true, reason: "ok" }, { timedMatch: true });
  assert.equal(byRule(report, "7-replay").length, 0);
});

test("with no replay report the gate says the check did not run", async (t) => {
  const { report } = await gate(t, allPassing());
  assert.equal(report.source.replayReport, null);
  assert.equal(byRule(report, "7-replay").length, 0);
});

/* ── failure modes of the gate itself ─────────────────────────────────────── */

test("a missing matrix report is an error that names the command to fix it", async () => {
  await assert.rejects(
    () => runGate({ matrixReportPath: path.join(os.tmpdir(), "atlas-does-not-exist", "report.json"), quiet: true }),
    /node bin\/atlas\.js matrix/,
  );
});

test("an explicitly named replay report that does not exist is an error, not a silent skip", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atlas-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const matrixPath = path.join(dir, "report.json");
  await writeFile(matrixPath, JSON.stringify(matrixReport(allPassing())), "utf8");
  await assert.rejects(
    () =>
      runGate({
        matrixReportPath: matrixPath,
        replayReportPath: path.join(dir, "nope.json"),
        outDir: path.join(dir, "gate"),
        quiet: true,
      }),
    /replay report not found/,
  );
});

test("the counts add up to the findings actually listed", async (t) => {
  const runs = allPassing();
  runs[0] = passingRun(runs[0].profileId, {
    metrics: { firstFrameMs: 5000, reachedEndState: false },
    verdict: { outcome: choice("fail"), rootCause: rootCause("render-stall"), releaseBlocking: score(4) },
    decision: { engine: "jev", confidence: 0.3, guard: { overridden: false } },
    pageErrors: ["boom"],
  });
  const { report } = await gate(t, runs);
  const n = (/** @type {string} */ s) => report.findings.filter((/** @type {any} */ f) => f.severity === s).length;
  assert.equal(report.counts.blocks, n("block"));
  assert.equal(report.counts.warnings, n("warn"));
  assert.equal(report.counts.info, n("info"));
  assert.equal(report.counts.blocks + report.counts.warnings + report.counts.info, report.findings.length);
  assert.ok(report.counts.blocks >= 3, "fail + severity + business invariant should all fire");
});
