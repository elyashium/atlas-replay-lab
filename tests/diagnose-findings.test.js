import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONSOLE_CATEGORIES,
  DIAGNOSIS_RULES,
  FINDING_SCHEMA_VERSION,
  TRACE_SLICE_MAX_EVENTS,
  TRACE_SLICE_RADIUS_MS,
  consoleCategory,
  findingForRun,
  findingsForReport,
} from "../src/diagnose/findings.js";
import { SEVERITY_LEVELS } from "../src/decision/questions.js";
import { runFindings } from "../src/diagnose/run-findings.js";
import { provenanceFor } from "../src/runner/provenance.js";
import { genericManifest } from "../src/manifest/generic.manifest.js";
import { policyStamp } from "../src/gate/policy.js";

const row = (/** @type {any} */ over = {}) => ({
  runId: "r-1",
  profileId: "mid-android-4g",
  runKind: "adaptive",
  provenance: provenanceFor({ id: "mid-android-4g" }),
  tracePath: "artifacts/traces/r-1/trace.json",
  determinismHash: "d1",
  causalHash: "c1",
  servedTier: "mid",
  servedPath: "webgl",
  targetScore: 41,
  metrics: { firstFrameMs: 900, ttiMs: 2400, p95InteractionMs: 260, sustainedFps: 22, droppedFrames: 31 },
  verdict: { outcome: { value: "fail" }, releaseBlocking: { value: "major" } },
  drive: { journeyOutcome: "fail", steps: [{ index: 0, type: "click", selector: "#start", outcome: "pass" }, { index: 1, type: "click", selector: "#place", outcome: "fail" }] },
  screenshots: {},
  pageErrors: [],
  error: null,
  ...over,
});

const trace = (/** @type {any} */ over = {}) => ({
  events: [
    { tOffsetMs: 0, kind: "lifecycle", name: "navigation-start", attributes: {} },
    { tOffsetMs: 896, kind: "frame", name: "first-frame", attributes: { rendered: 1, dropped: 0 } },
    { tOffsetMs: 1400, kind: "asset", name: "asset-load", attributes: { bytes: 2048, ok: true } },
    { tOffsetMs: 1480, kind: "interaction", name: "tap", attributes: { latencyMs: 260 } },
    { tOffsetMs: 3000, kind: "lifecycle", name: "teardown", attributes: {} },
  ],
  consoleErrors: [{ tOffsetMs: 1440, code: "webgl-context-lost", message: "WebGL: CONTEXT_LOST_WEBGL" }],
  ...over,
});

/* ── a passing run is not diagnosed ──────────────────────────────────────── */

test("a passing run produces no finding", () => {
  const passing = row({
    verdict: { outcome: { value: "pass" }, releaseBlocking: { value: "not blocking" } },
    drive: { journeyOutcome: "pass", steps: [{ index: 0, type: "click", selector: "#start", outcome: "pass" }] },
  });
  assert.equal(findingForRun(passing), null);
  assert.equal(findingForRun(null), null);
  assert.equal(findingForRun("nonsense"), null);
});

test("an inconclusive verdict is diagnosed, because unknown is not pass", () => {
  const f = findingForRun(row({ verdict: { outcome: { value: "inconclusive" }, releaseBlocking: { value: "major" } }, drive: { journeyOutcome: "pass", steps: [] } }));
  assert.ok(f);
  assert.match(f.title, /inconclusive/);
});

/* ── the three lists never merge ─────────────────────────────────────────── */

test("observations cite a field or an artifact, and never state a cause", () => {
  const f = findingForRun(row(), { trace: trace(), manifest: genericManifest });
  assert.ok(f.observations.length >= 5);
  for (const o of f.observations) {
    assert.ok(o.source, `every observation needs a source: ${o.what}`);
    assert.equal(typeof o.what, "string");
    // "because" is how a cause sneaks into a fact.
    assert.ok(!/\bbecause\b/i.test(o.what), `observation states a cause: ${o.what}`);
  }
});

test("suggested changes are always empty, and the emptiness is explained", () => {
  const f = findingForRun(row(), { trace: trace() });
  assert.deepEqual(f.suggestedChanges, []);
  assert.match(f.$limitations.suggestedChanges, /not implemented/);
});

test("every inferred cause names the rule that produced it", () => {
  const f = findingForRun(row({ profileId: "webgl-unavailable" }), { trace: trace() });
  assert.ok(f.inferredCauses.length > 0);
  for (const c of f.inferredCauses) {
    assert.equal(c.basis, "rule");
    assert.ok(DIAGNOSIS_RULES.some((r) => r.id === c.id), `unknown rule id ${c.id}`);
    assert.ok(c.why.length > 40, "a cause must explain a mechanism, not restate the observation");
  }
});

test("no rule matching leaves inferred causes empty rather than guessing", () => {
  const f = findingForRun(row(), { trace: trace() });
  assert.deepEqual(f.inferredCauses, []);
  assert.match(f.$limitations.observationsVsCauses, /will not guess/);
});

/* ── the rules that exist ────────────────────────────────────────────────── */

test("a deliberately hostile profile is attributed to Atlas, not to the app", () => {
  // The most common misreading of the matrix: `camera-denied` failing is Atlas
  // denying the camera, and saying otherwise blames the customer for our setup.
  const f = findingForRun(row({ profileId: "camera-denied" }), { trace: trace() });
  const denial = f.inferredCauses.find((c) => c.id === "profile-denied-capability");
  assert.ok(denial, "the denial rule must fire");
  assert.equal(denial.aboutTarget, false);
  assert.match(denial.cause, /withholds camera access on purpose/);
});

test("a missing fallback under denial is attributed to the app", () => {
  const f = findingForRun(row({ profileId: "xr-denied" }), { trace: trace() });
  const ids = f.inferredCauses.map((c) => c.id);
  // Both fire, and they say different things: the denial is ours, the missing
  // fallback is the app's. Collapsing them would lose the finding.
  assert.deepEqual(ids, ["profile-denied-capability", "fallback-absent-under-denial"]);
  assert.equal(f.inferredCauses[1].aboutTarget, true);
});

test("a harness loss is reported as absent evidence, not as a target defect", () => {
  const f = findingForRun(row({ error: "harness failed after 2 attempt(s): target closed", verdict: null, metrics: null, drive: null }));
  const loss = f.inferredCauses.find((c) => c.id === "harness-loss");
  assert.ok(loss);
  assert.equal(loss.aboutTarget, false);
  assert.match(loss.why, /the target may be\s+fine/);
  assert.match(f.title, /harness lost the run/);
});

test("a run that did not reproduce is flagged as unattributable", () => {
  const f = findingForRun(row({ replay: { reproduced: false } }), { trace: trace() });
  const replay = f.inferredCauses.find((c) => c.id === "replay-did-not-reproduce");
  assert.ok(replay);
  assert.equal(replay.aboutTarget, null, "neither side can be blamed for an unrepeated run");
});

/* ── evidence ────────────────────────────────────────────────────────────── */

test("the failing contract step is attached, and the typed value is not", () => {
  const f = findingForRun(
    row({ drive: { journeyOutcome: "fail", steps: [{ index: 0, type: "type", selector: "#email", outcome: "fail", value: "[redacted]" }] } }),
    { contract: { journey: { steps: [{ type: "type", selector: "#email", timeoutMs: 5000 }] } } },
  );
  assert.equal(f.evidence.contractStep.index, 0);
  assert.equal(f.evidence.contractStep.selector, "#email");
  assert.equal(f.evidence.contractStep.declaredTimeoutMs, 5000);
  assert.ok(!("value" in f.evidence.contractStep), "the typed value must not be re-read into a finding");
  assert.ok(!JSON.stringify(f).includes("redacted"), "no redaction placeholder should leak either");
});

test("the trace slice is centred on the first console error and stays chronological", () => {
  const f = findingForRun(row(), { trace: trace() });
  assert.equal(f.evidence.traceSliceWindow.centreMs, 1440);
  assert.equal(f.evidence.traceSliceWindow.radiusMs, TRACE_SLICE_RADIUS_MS);
  const offsets = f.evidence.traceSlice.map((e) => e.tOffsetMs);
  assert.deepEqual(offsets, [896, 1400, 1480]);
  assert.deepEqual([...offsets].sort((a, b) => a - b), offsets);
  // 0ms and 3000ms are outside the 750ms window and are correctly absent.
  assert.ok(!offsets.includes(0));
  assert.ok(!offsets.includes(3000));
});

test("the slice carries attribute keys, not attribute values", () => {
  const f = findingForRun(row(), { trace: trace() });
  const interaction = f.evidence.traceSlice.find((e) => e.name === "tap");
  assert.deepEqual(interaction.attributeKeys, ["latencyMs"]);
  assert.ok(!("attributes" in interaction));
});

test("a crowded window is capped, keeping the events nearest the failure", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ tOffsetMs: 1000 + i * 4, kind: "frame", name: "frame", attributes: {} }));
  const f = findingForRun(row(), { trace: trace({ events: many }) });
  assert.equal(f.evidence.traceSlice.length, TRACE_SLICE_MAX_EVENTS);
  const offsets = f.evidence.traceSlice.map((e) => e.tOffsetMs);
  assert.deepEqual([...offsets].sort((a, b) => a - b), offsets, "cap must not scramble the order");
  assert.ok(Math.abs(offsets[0] - 1440) <= TRACE_SLICE_RADIUS_MS);
});

test("no slice is emitted when the failure moment cannot be located", () => {
  // Centring on 0 would put the window at session start and quietly mislead.
  const f = findingForRun(row(), { trace: { events: [], consoleErrors: [] } });
  assert.deepEqual(f.evidence.traceSlice, []);
  assert.equal(f.evidence.traceSliceWindow, null);
});

test("console errors travel as category and code, never as message text", () => {
  const f = findingForRun(row(), { trace: trace() });
  const graphics = f.evidence.consoleCategories.find((c) => c.category === "graphics");
  assert.deepEqual(graphics, { category: "graphics", count: 1, codes: ["webgl-context-lost"], firstAtMs: 1440 });
  // The message is the one trace field that can carry a customer string.
  assert.ok(!JSON.stringify(f).includes("CONTEXT_LOST_WEBGL"));
});

test("an unrecognised error code is surfaced, not silently bucketed", () => {
  assert.equal(consoleCategory("webgl-context-lost"), "graphics");
  assert.equal(consoleCategory("csp-violation"), "security");
  assert.equal(consoleCategory("something-new"), "uncategorised");
  const f = findingForRun(row(), { trace: trace({ consoleErrors: [{ tOffsetMs: 10, code: "something-new", message: "x" }] }) });
  assert.equal(f.evidence.consoleCategories[0].category, "uncategorised");
});

test("category tables are frozen and their codes do not overlap", () => {
  assert.throws(() => {
    // @ts-expect-error deliberately violating the type to test the freeze
    CONSOLE_CATEGORIES.graphics.push("anything");
  }, TypeError);
  const seen = new Set();
  for (const codes of Object.values(CONSOLE_CATEGORIES)) {
    for (const code of codes) {
      assert.ok(!seen.has(code), `${code} is in two categories`);
      seen.add(code);
    }
  }
});

test("screenshots are named with their review requirement, never inlined", () => {
  const f = findingForRun(row({ screenshots: { start: "artifacts/shots/r-1/start.png" } }), { trace: trace() });
  const shot = f.evidence.artifacts.find((a) => a.what === "screenshot:start");
  assert.equal(shot.path, "artifacts/shots/r-1/start.png");
  assert.match(shot.review, /consent/);
  assert.match(shot.review, /human review/);
});

test("the policy rule and stamp ride along when the caller has them", () => {
  const f = findingForRun(row(), {
    trace: trace(),
    manifest: genericManifest,
    policyStamp: { id: "atlas.release-policy", version: "2026-09-28.1", contentHash: "abc123abc123abcd" },
    rule: { id: "score-floor", statement: "targetScore >= 50" },
  });
  assert.equal(f.evidence.policy.version, "2026-09-28.1");
  assert.equal(f.evidence.policyRule.id, "score-floor");
  assert.ok(f.evidence.comfortPolicy.sustainedFpsFloor > 0);
});

test("a partial manifest does not throw from the diagnosis path", () => {
  const f = findingForRun(row(), { trace: trace(), manifest: { id: "x", version: 1 } });
  assert.equal(f.evidence.comfortPolicy, null);
});

/* ── severity and identity ───────────────────────────────────────────────── */

test("severity is copied from the gate, never recomputed", () => {
  for (const level of SEVERITY_LEVELS) {
    const f = findingForRun(row({ verdict: { outcome: { value: "fail" }, releaseBlocking: { value: level } } }));
    assert.equal(f.severity, level);
  }
});

test("a row with no gate judgement does not get a low severity by default", () => {
  assert.equal(findingForRun(row({ verdict: null, drive: { journeyOutcome: "fail", steps: [] } })).severity, "major");
  assert.equal(findingForRun(row({ verdict: null, drive: null, error: "lost" })).severity, "hard block");
});

test("the same failure twice has the same id, and a different one does not", () => {
  const a = findingForRun(row(), { trace: trace() });
  const b = findingForRun(row({ runId: "r-9", metrics: { firstFrameMs: 950 } }), { trace: trace() });
  assert.equal(a.id, b.id, "same profile, same shape of failure — a recurrence, not a new problem");
  const c = findingForRun(row({ profileId: "low-cpu-3g" }), { trace: trace() });
  assert.notEqual(a.id, c.id);
  assert.match(a.id, /^[0-9a-f]{12}$/);
});

test("a finding is byte-identical across two calls on the same input", () => {
  // No clock is read and no id is minted, so a finding is diffable.
  const one = JSON.stringify(findingForRun(row(), { trace: trace(), manifest: genericManifest }));
  const two = JSON.stringify(findingForRun(row(), { trace: trace(), manifest: genericManifest }));
  assert.equal(one, two);
});

/* ── report level ────────────────────────────────────────────────────────── */

test("a report's findings separate target problems from harness problems", () => {
  const report = {
    kind: "atlas.matrix-report",
    target: { contract: { journey: { steps: [] } } },
    runs: [
      row({ runId: "ok", verdict: { outcome: { value: "pass" } }, drive: { journeyOutcome: "pass", steps: [] } }),
      row({ runId: "app", profileId: "xr-denied" }),
      row({ runId: "lost", error: "harness failed after 2 attempt(s): target closed", verdict: null, drive: null }),
      row({ runId: "plain" }),
    ],
  };
  const out = findingsForReport(report, { traces: { app: trace(), plain: trace() }, manifest: genericManifest });
  assert.equal(out.schemaVersion, FINDING_SCHEMA_VERSION);
  assert.equal(out.counts.rows, 4);
  assert.equal(out.counts.findings, 3, "the passing row must not produce one");
  assert.equal(out.counts.aboutTarget, 1);
  assert.equal(out.counts.aboutHarness, 1);
  assert.equal(out.counts.unexplained, 1);
  assert.match(out.$limitations.unexplained, /not a defect in the diagnosis/);
});

test("every finding records its lane, so a number cannot be lifted as a device result", () => {
  const out = findingsForReport({ runs: [row()] }, { traces: { "r-1": trace() } });
  assert.equal(out.findings[0].lane, "emulation");
  assert.match(out.findings[0].$limitations.lane, /physical handset/);
  assert.match(out.findings[0].$limitations.sampleSize, /not a rate/);
});

test("a report with no runs array yields no findings rather than throwing", () => {
  assert.equal(findingsForReport({}).counts.findings, 0);
  assert.equal(findingsForReport(null).counts.rows, 0);
});

/* ── the IO shell ────────────────────────────────────────────────────────────
 * Everything above is pure. These exercise `runFindings`, which is the only
 * part that touches disk: where it reads the report from, how it resolves each
 * row's own trace, and what it writes. Nothing here launches a browser or
 * writes into the repository's `artifacts/`.
 * ------------------------------------------------------------------------- */

/**
 * A matrix report on disk, plus a `<dir>/<runId>/trace.json` for each trace
 * given — the layout `runFindings` falls back to when a report has been copied
 * out of the repository it was produced in.
 *
 * @param {{ runs: any[]; traces?: Record<string, any>; report?: Record<string, any> }} spec
 */
async function onDisk(spec) {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-findings-"));
  const outDir = await mkdtemp(path.join(tmpdir(), "atlas-findings-out-"));
  for (const [runId, value] of Object.entries(spec.traces ?? {})) {
    await mkdir(path.join(dir, runId), { recursive: true });
    await writeFile(path.join(dir, runId, "trace.json"), JSON.stringify(value), "utf8");
  }
  const reportPath = path.join(dir, "report.json");
  await writeFile(
    reportPath,
    JSON.stringify({ kind: "atlas.matrix-report", ...spec.report, runs: spec.runs }),
    "utf8",
  );
  return { dir, outDir, reportPath };
}

test("diagnosis refuses to run without a matrix report, and says so plainly", async () => {
  const { dir, outDir } = await onDisk({ runs: [] });
  await assert.rejects(
    () => runFindings({ report: path.join(dir, "not-here.json"), outDir, quiet: true }),
    /no matrix report with a runs array/,
  );
  // A report-shaped file that never ran anything is the same absence.
  const shell = path.join(dir, "shell.json");
  await writeFile(shell, JSON.stringify({ kind: "atlas.matrix-report" }), "utf8");
  await assert.rejects(
    () => runFindings({ report: shell, outDir, quiet: true }),
    /does not produce any/,
    "the error must say diagnosis reads evidence rather than inventing it",
  );
});

test("findings.json is written where asked, and matches what was returned", async () => {
  const { outDir, reportPath } = await onDisk({
    runs: [row({ runId: "io-slice", tracePath: "artifacts/matrix/io-slice/trace.json" })],
    traces: { "io-slice": trace() },
    report: {
      startedAtIso: "2026-09-28T00:00:00.000Z",
      runnerBuildId: "build-7",
      manifest: { id: "generic-url", contentHash: "mh01234567890abc" },
      target: { contractHash: "ch01234567890abc" },
    },
  });

  const { findings, file } = await runFindings({ report: reportPath, outDir, quiet: true });
  assert.equal(file, path.join(outDir, "findings.json"));
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), findings);

  // The source block is the answer to "which run produced this diagnosis" —
  // without it a findings file is unattributable.
  assert.equal(findings.source.report, reportPath);
  assert.equal(findings.source.reportStartedAtIso, "2026-09-28T00:00:00.000Z");
  assert.equal(findings.source.runnerBuildId, "build-7");
  assert.equal(findings.source.manifestHash, "mh01234567890abc");
  assert.equal(findings.source.contractHash, "ch01234567890abc");
  assert.equal(findings.source.tracesLoaded, 1);
  assert.equal(findings.source.tracesMissing, 0);
  assert.equal(findings.$limitations.traces, undefined, "nothing was missing, so nothing to disclaim");

  const [finding] = findings.findings;
  // The trace resolved from the report's own directory, so the slice is there.
  assert.equal(finding.evidence.traceSliceWindow.centreMs, 1440);
  assert.deepEqual(
    finding.evidence.traceSlice.map((/** @type {any} */ e) => e.tOffsetMs),
    [896, 1400, 1480],
  );
  // The report named a manifest this repository can resolve, so the comfort
  // thresholds the run was graded against travel with the finding.
  assert.ok(finding.evidence.comfortPolicy.sustainedFpsFloor > 0);
  assert.equal(finding.evidence.policy.contentHash, policyStamp().contentHash);
});

test("a run whose trace cannot be read still gets a finding, and the gap is stated", async () => {
  const { outDir, reportPath } = await onDisk({
    // No trace written for this row: the file the report points at is gone.
    runs: [row({ runId: "io-gone", tracePath: "artifacts/matrix/io-gone/trace.json" })],
  });

  const { findings } = await runFindings({ report: reportPath, outDir, quiet: true });
  assert.equal(findings.source.tracesLoaded, 0);
  assert.equal(findings.source.tracesMissing, 1);
  assert.match(findings.$limitations.traces, /no trace slice or console categories/);
  // The finding still exists — a lost trace costs evidence, not the failure.
  assert.equal(findings.counts.findings, 1);
  assert.deepEqual(findings.findings[0].evidence.traceSlice, []);
  assert.equal(findings.findings[0].evidence.traceSliceWindow, null);
  assert.deepEqual(findings.findings[0].evidence.consoleCategories, []);
});

test("a harness-lost row is not also counted as a missing trace", async () => {
  // Rule 1 already owns a quarantined run; counting its absent trace again
  // would double-report one absence as two problems.
  const { outDir, reportPath } = await onDisk({
    runs: [
      row({
        runId: "io-lost",
        tracePath: null,
        error: "harness failed after 2 attempt(s): target closed",
        verdict: null,
        metrics: null,
        drive: null,
      }),
    ],
  });

  const { findings } = await runFindings({ report: reportPath, outDir, quiet: true });
  assert.equal(findings.source.tracesMissing, 0);
  assert.equal(findings.$limitations.traces, undefined);
  assert.equal(findings.counts.aboutHarness, 1);
  assert.equal(findings.counts.aboutTarget, 0);
  assert.match(findings.findings[0].title, /harness lost the run/);
});

test("an unresolvable manifest id costs the comfort policy and nothing else", async () => {
  const { outDir, reportPath } = await onDisk({
    runs: [row({ runId: "io-unknown", tracePath: "artifacts/matrix/io-unknown/trace.json" })],
    traces: { "io-unknown": trace() },
    report: { manifest: { id: "some-other-teams-manifest", contentHash: "zz01234567890abc" } },
  });

  const { findings } = await runFindings({ report: reportPath, outDir, quiet: true });
  assert.equal(findings.findings[0].evidence.comfortPolicy, null);
  // The hash is still recorded, so a reader can go find the manifest by hand.
  assert.equal(findings.source.manifestHash, "zz01234567890abc");
  assert.equal(findings.findings[0].evidence.traceSliceWindow.centreMs, 1440);
});

test("two diagnoses of the same report are byte-identical", async () => {
  // The whole point of a deterministic diagnosis: `findings.json` can be
  // committed to a bundle and diffed. A clock or a minted id would break this.
  const { outDir, reportPath } = await onDisk({
    runs: [row({ runId: "io-det", tracePath: "artifacts/matrix/io-det/trace.json" })],
    traces: { "io-det": trace() },
    report: { manifest: { id: "generic-url", contentHash: "mh01234567890abc" } },
  });
  const second = await mkdtemp(path.join(tmpdir(), "atlas-findings-out-"));

  const one = await runFindings({ report: reportPath, outDir, quiet: true });
  const two = await runFindings({ report: reportPath, outDir: second, quiet: true });
  assert.equal(await readFile(one.file, "utf8"), await readFile(two.file, "utf8"));
});
