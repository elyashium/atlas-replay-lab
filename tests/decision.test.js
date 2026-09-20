/**
 * Both decision engines, against the same fixtures.
 *
 * This is the §5.4 test that matters most, because it is the one that keeps the
 * §4.3 abstraction honest: `RuleBasedDecisionEngine` and `JevDecisionEngine`
 * must be interchangeable behind one interface, and the only way to know that
 * is to run both through identical inputs and assert on the *shape* of what
 * comes back, not just on the values.
 *
 * The Jev half runs against hand-authored fixtures built in memory. They are
 * **illustrative, not captured** — nothing here measures how Jev behaves, and
 * no assertion below should ever be read as evidence about the model. What it
 * does prove is that the Jev code path parses, normalises, and returns a
 * well-formed decision without an API key present.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { orbitalManifest } from "../src/manifest/atlas-orbital.manifest.js";
import { RuleBasedDecisionEngine, tierRenderable, predict, cpuFactor } from "../src/decision/rule-based.js";
import { JevDecisionEngine } from "../src/decision/jev.js";
import { GuardedDecisionEngine, severityRank, DEFAULT_TIER_CONFIDENCE_FLOOR } from "../src/decision/guarded.js";
import { FixtureJevTransport, FixtureMissError, fixtureKey, resolveTransport } from "../src/decision/jev-transport.js";
import {
  tierQuestions,
  traceQuestions,
  validateQuestions,
  TIER_OPTIONS,
  RISK_LEVELS,
  OUTCOME_OPTIONS,
  ROOT_CAUSE_OPTIONS,
  SEVERITY_LEVELS,
  softmax,
  confidenceOfChoice,
  confidenceOfNoul,
  expectedScore,
} from "../src/decision/questions.js";
import { normalizeDistribution, readProbability, readScore, readChoiceValue } from "../src/decision/jev.js";
import { SYNTHETIC_STATES } from "../src/decision/fixtures/states.js";
import { TRACE_SCENARIOS, buildScenarioTrace } from "../src/decision/fixtures/traces.js";
import { buildFixtureFile } from "../scripts/build-fixtures.js";

const manifest = orbitalManifest;
const ctx = { manifest, origin: /** @type {const} */ ("ci-matrix") };

/**
 * Built once, in memory. Deliberately *not* read from
 * `src/decision/fixtures/jev-responses.json`: a suite that only passes after
 * someone remembers to run a generator is a suite people learn to ignore.
 */
const { fixtureFile } = buildFixtureFile();

/** A fresh Jev engine over the in-memory fixtures. */
const jevEngine = () =>
  new JevDecisionEngine({ transport: new FixtureJevTransport({ fixtures: fixtureFile, strict: false }) });

const rules = new RuleBasedDecisionEngine();

/* ── the question sets ────────────────────────────────────────────────────── */

test("both question sets are structurally valid", () => {
  // If a question is malformed, everything downstream still "works" — it just
  // answers a badly-posed question. That is the failure hardest to notice, so
  // it gets asserted first.
  assert.deepEqual(validateQuestions(tierQuestions(manifest.budgets)), []);
  assert.deepEqual(validateQuestions(traceQuestions(manifest)), []);
});

test("the tier question offers exactly the tiers the manifest can serve", () => {
  const q = tierQuestions(manifest.budgets).find((x) => x.id === "tier");
  assert.ok(q, "there must be a 'tier' question");
  assert.deepEqual([.../** @type {any} */ (q).options].sort(), [...TIER_OPTIONS].sort());
  // Every option needs its own criterion. An option with no criterion is an
  // option the model has to guess the meaning of.
  for (const option of TIER_OPTIONS) {
    assert.ok(
      /** @type {any} */ (q).criteria?.[option],
      `option "${option}" has no criterion — the model would be guessing`,
    );
  }
});

test("criteria mention the budget numbers rather than saying 'fast enough'", () => {
  const q = tierQuestions(manifest.budgets).find((x) => x.id === "firstFrameRisk");
  const text = JSON.stringify(/** @type {any} */ (q).criteria);
  assert.ok(
    text.includes(String(manifest.budgets.firstFrameMs)),
    "a risk question that does not name the budget is asking about a vibe",
  );
});

test("a question with duplicate options is rejected", () => {
  const broken = [{ id: "x", kind: "choice", question: "?", options: ["a", "a"], criteria: { a: "..." } }];
  assert.ok(validateQuestions(/** @type {any} */ (broken)).length > 0);
});

test("a choice question missing a criterion is rejected", () => {
  const broken = [{ id: "x", kind: "choice", question: "?", options: ["a", "b"], criteria: { a: "..." } }];
  assert.ok(validateQuestions(/** @type {any} */ (broken)).some((p) => p.includes("b")));
});

/* ── rule engine: the contract every decision must satisfy ────────────────── */

/** @param {any} d @param {string} label */
function assertWellFormedTierDecision(d, label) {
  assert.ok(TIER_OPTIONS.includes(d.tier), `${label}: "${d.tier}" is not a declared tier`);
  assert.equal(d.tierAnswer.value, d.tier, `${label}: answer value must match the chosen tier`);

  const sum = Object.values(d.tierAnswer.distribution).reduce((/** @type {number} */ s, /** @type {any} */ v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `${label}: tier distribution sums to ${sum}`);
  assert.deepEqual(
    Object.keys(d.tierAnswer.distribution).sort(),
    [...TIER_OPTIONS].sort(),
    `${label}: distribution must cover exactly the declared options`,
  );

  assert.ok(d.confidence >= 0 && d.confidence <= 1, `${label}: confidence ${d.confidence} out of range`);
  assert.ok(d.cameraPathSafe.pTrue >= 0 && d.cameraPathSafe.pTrue <= 1, `${label}: pTrue out of range`);
  assert.deepEqual(d.firstFrameRisk.levels, [...RISK_LEVELS], `${label}: risk levels must be the declared ladder`);
  assert.ok(
    d.firstFrameRisk.score >= 0 && d.firstFrameRisk.score <= RISK_LEVELS.length - 1,
    `${label}: risk score ${d.firstFrameRisk.score} outside 0..${RISK_LEVELS.length - 1}`,
  );
  assert.ok(["camera-xr", "interactive-2d", "static-safe"].includes(d.path), `${label}: unknown path "${d.path}"`);
  assert.equal(typeof d.engine, "string");
}

test("the rule engine returns a well-formed decision for every synthetic state", async () => {
  for (const synth of SYNTHETIC_STATES) {
    assertWellFormedTierDecision(await rules.routeTier(synth.state, ctx), synth.id);
  }
});

test("the rule engine never serves a tier the device cannot render", async () => {
  // The single most important safety property of the router. Everything else is
  // a quality judgement; this one is a correctness bug if it ever fails.
  for (const synth of SYNTHETIC_STATES) {
    const d = await rules.routeTier(synth.state, ctx);
    assert.ok(
      tierRenderable(synth.state, manifest, d.tier),
      `${synth.id}: served "${d.tier}" on a device that cannot render it`,
    );
  }
});

test("the rule engine is deterministic — same state in, same bytes out", async () => {
  for (const synth of SYNTHETIC_STATES) {
    const a = await rules.routeTier(synth.state, ctx);
    const b = await rules.routeTier(structuredClone(synth.state), ctx);
    assert.deepEqual(a, b, `${synth.id} is not deterministic`);
  }
});

test("the sync and async twins agree exactly", async () => {
  // The control plane calls the sync one on the hot path; the harness awaits the
  // async one. They must not be allowed to drift apart.
  for (const synth of SYNTHETIC_STATES) {
    assert.deepEqual(await rules.routeTier(synth.state, ctx), rules.routeTierSync(synth.state, ctx), synth.id);
  }
});

test("the rule engine matches ground truth on every uncontested state", async () => {
  /** @type {string[]} */
  const misses = [];
  for (const synth of SYNTHETIC_STATES) {
    if (synth.contested) continue;
    const d = await rules.routeTier(synth.state, ctx);
    if (d.tier !== synth.groundTruth) misses.push(`${synth.id}: expected ${synth.groundTruth}, got ${d.tier}`);
  }
  assert.deepEqual(misses, [], `the deterministic engine disagrees with its own labels:\n${misses.join("\n")}`);
});

test("camera safety tracks the permission, not the hardware", async () => {
  for (const synth of SYNTHETIC_STATES) {
    const d = await rules.routeTier(synth.state, ctx);
    assert.equal(
      d.cameraPathSafe.pTrue >= 0.5,
      synth.cameraExpectedSafe,
      `${synth.id}: camera safety p=${d.cameraPathSafe.pTrue}, expected safe=${synth.cameraExpectedSafe}`,
    );
  }
});

test("a denied camera is never routed onto the camera path", async () => {
  for (const synth of SYNTHETIC_STATES) {
    if (synth.state.cameraPermission === "granted") continue;
    const d = await rules.routeTier(synth.state, ctx);
    assert.notEqual(d.path, "camera-xr", `${synth.id}: routed to camera-xr without permission`);
  }
});

test("degrading the network never upgrades the tier", async () => {
  // A monotonicity property: it is the sort of thing a scoring tweak breaks
  // silently, and the symptom in production is a slow device getting the
  // heaviest build.
  const base = SYNTHETIC_STATES.find((s) => s.id === "mid-android-4g");
  assert.ok(base);
  const good = await rules.routeTier(/** @type {any} */ (base).state, ctx);
  const poor = await rules.routeTier(
    { .../** @type {any} */ (base).state, effectiveConnectionType: "2g", downlinkMbps: 0.4, rttMs: 900 },
    ctx,
  );
  assert.ok(
    TIER_OPTIONS.indexOf(poor.tier) >= TIER_OPTIONS.indexOf(good.tier),
    `2G was served "${poor.tier}" where 4G got "${good.tier}"`,
  );
});

test("predict is monotone in cost across the ladder", () => {
  const state = /** @type {any} */ (SYNTHETIC_STATES.find((s) => s.id === "mid-android-4g")).state;
  const high = predict(state, manifest, "high");
  const mid = predict(state, manifest, "mid");
  const low = predict(state, manifest, "low");
  assert.ok(high.firstFrameMs > mid.firstFrameMs, "high must cost more than mid");
  assert.ok(mid.firstFrameMs > low.firstFrameMs, "mid must cost more than low");
  assert.ok(high.frameTimeMs > low.frameTimeMs);
});

test("cpuFactor is ordered and finite for every synthetic state", () => {
  const weak = cpuFactor({ .../** @type {any} */ (SYNTHETIC_STATES[0]).state, hardwareConcurrency: 2, deviceMemoryGB: 1, gpuTier: "low" });
  const strong = cpuFactor(/** @type {any} */ (SYNTHETIC_STATES[0]).state);
  assert.ok(Number.isFinite(weak) && Number.isFinite(strong));
  assert.ok(weak > strong, "a weaker device must carry a larger cost factor");
});

/* ── rule engine: verdicts ────────────────────────────────────────────────── */

/** @param {any} v @param {string} label */
function assertWellFormedVerdict(v, label) {
  assert.ok(OUTCOME_OPTIONS.includes(v.outcome.value), `${label}: bad outcome "${v.outcome.value}"`);
  assert.ok(ROOT_CAUSE_OPTIONS.includes(v.rootCause.value), `${label}: bad rootCause "${v.rootCause.value}"`);
  assert.deepEqual(v.releaseBlocking.levels, [...SEVERITY_LEVELS], label);
  assert.ok(
    v.releaseBlocking.score >= 0 && v.releaseBlocking.score <= SEVERITY_LEVELS.length - 1,
    `${label}: severity ${v.releaseBlocking.score} out of range`,
  );
  for (const key of ["visualInvariantHeld", "interactionInvariantHeld", "businessInvariantHeld"]) {
    assert.ok(v[key].pTrue >= 0 && v[key].pTrue <= 1, `${label}: ${key} out of range`);
  }
  assert.ok(v.confidence >= 0 && v.confidence <= 1, `${label}: confidence out of range`);
}

test("the rule engine judges every scenario into a well-formed verdict", async () => {
  for (const scenario of TRACE_SCENARIOS) {
    const trace = buildScenarioTrace(scenario, manifest);
    assertWellFormedVerdict(await rules.judgeTrace(trace, ctx), scenario.id);
  }
});

test("the rule engine matches the expected outcome on every uncontested scenario", async () => {
  /** @type {string[]} */
  const misses = [];
  for (const scenario of TRACE_SCENARIOS) {
    if (scenario.contested) continue;
    const v = await rules.judgeTrace(buildScenarioTrace(scenario, manifest), ctx);
    if (v.outcome.value !== scenario.expected.outcome) {
      misses.push(`${scenario.id}: expected ${scenario.expected.outcome}, got ${v.outcome.value}`);
    }
  }
  assert.deepEqual(misses, [], misses.join("\n"));
});

test("the three invariants are judged independently, not as one blob", async () => {
  // The scenario that proves it: checkout succeeds while the visuals are broken.
  // If the invariants were collapsed into a single score, this trace would come
  // back all-good or all-bad, and the report would lose the only detail that
  // tells you which subsystem to look at.
  const scenario = TRACE_SCENARIOS.find((s) => s.id === "fail-render-stall");
  assert.ok(scenario);
  const v = await rules.judgeTrace(buildScenarioTrace(/** @type {any} */ (scenario), manifest), ctx);
  assert.equal(
    v.businessInvariantHeld.pTrue >= 0.5,
    /** @type {any} */ (scenario).expected.business,
    "business invariant",
  );
  assert.equal(
    v.interactionInvariantHeld.pTrue >= 0.5,
    /** @type {any} */ (scenario).expected.interaction,
    "interaction invariant",
  );
});

test("a session that never reached checkout can never be judged a pass", async () => {
  for (const scenario of TRACE_SCENARIOS) {
    const trace = buildScenarioTrace(scenario, manifest);
    if (trace.metrics.reachedEndState) continue;
    const v = await rules.judgeTrace(trace, ctx);
    assert.notEqual(v.outcome.value, "pass", `${scenario.id} passed without reaching checkout`);
    assert.ok(v.businessInvariantHeld.pTrue < 0.5, `${scenario.id}: business invariant should not hold`);
  }
});

test("a truncated session is inconclusive, not a pass and not a fail", async () => {
  const scenario = TRACE_SCENARIOS.find((s) => s.id === "inconclusive-truncated");
  assert.ok(scenario);
  const v = await rules.judgeTrace(buildScenarioTrace(/** @type {any} */ (scenario), manifest), ctx);
  assert.equal(v.outcome.value, "inconclusive");
});

test("a blank first frame is always at least a major severity", async () => {
  for (const scenario of TRACE_SCENARIOS) {
    const trace = buildScenarioTrace(scenario, manifest);
    if (trace.metrics.firstFrameNonBlank !== false) continue;
    const v = await rules.judgeTrace(trace, ctx);
    assert.ok(
      v.releaseBlocking.score >= 3,
      `${scenario.id}: blank first frame scored only ${v.releaseBlocking.score}`,
    );
  }
});

/* ── both engines, same fixtures ──────────────────────────────────────────── */

test("the Jev engine returns the same decision shape as the rule engine", async () => {
  const jev = jevEngine();
  for (const synth of SYNTHETIC_STATES) {
    const d = await jev.routeTier(synth.state, ctx);
    assertWellFormedTierDecision(d, `jev/${synth.id}`);
    assert.equal(d.engine, "jev");
    // The abstraction is only real if the two are key-for-key interchangeable.
    const r = await rules.routeTier(synth.state, ctx);
    assert.deepEqual(Object.keys(d).sort(), Object.keys(r).sort(), `${synth.id}: engines return different shapes`);
  }
});

test("the Jev engine returns the same verdict shape as the rule engine", async () => {
  const jev = jevEngine();
  for (const scenario of TRACE_SCENARIOS) {
    const trace = buildScenarioTrace(scenario, manifest);
    const v = await jev.judgeTrace(trace, ctx);
    assertWellFormedVerdict(v, `jev/${scenario.id}`);
    const r = await rules.judgeTrace(trace, ctx);
    assert.deepEqual(Object.keys(v).sort(), Object.keys(r).sort(), `${scenario.id}: engines return different shapes`);
  }
});

test("the Jev engine emits no free text — typed answers only", async () => {
  // ADR-0006. Jev has no string channel, so a rationale could only be invented
  // here; an empty array is the honest representation.
  const jev = jevEngine();
  const d = await jev.routeTier(/** @type {any} */ (SYNTHETIC_STATES[0]).state, ctx);
  assert.deepEqual(d.rationale, []);
});

test("the fixtures cover every synthetic state and every scenario", () => {
  // A missing fixture degrades to a `FixtureMissError` at call time, which in
  // non-strict mode is swallowed and reported as a per-row error. Useful in the
  // comparison report; useless as a test signal. So assert coverage directly.
  const labels = new Set(fixtureFile.cases.map((/** @type {any} */ c) => c.label));
  for (const synth of SYNTHETIC_STATES) {
    assert.ok(labels.has(`tier/${synth.id}@ci-matrix`), `no ci-matrix fixture for ${synth.id}`);
    assert.ok(labels.has(`tier/${synth.id}@production`), `no production fixture for ${synth.id}`);
  }
  for (const scenario of TRACE_SCENARIOS) {
    assert.ok(labels.has(`trace/${scenario.id}`), `no trace fixture for ${scenario.id}`);
  }
});

test("the same decision from either call site hits a fixture", async () => {
  // §4.1: production and CI share the code path. The only thing that differs is
  // `ctx.origin`, which is part of the hashed state — so both must be covered or
  // fixture mode silently breaks for one of the two callers.
  const jev = jevEngine();
  const state = /** @type {any} */ (SYNTHETIC_STATES[0]).state;
  const fromProd = await jev.routeTier(state, { manifest, origin: "production" });
  const fromCi = await jev.routeTier(state, { manifest, origin: "ci-matrix" });
  assert.equal(fromProd.tier, fromCi.tier, "the same state must route identically from either origin");
});

test("the deliberate divergences actually diverge", async () => {
  // The comparison harness is worthless if the two engines agree everywhere by
  // construction — an agreement rate of 100% would mean the fixtures were
  // written by reading the rule engine's output, which is the exact failure the
  // `contested` flag exists to avoid. These four are hand-authored to differ.
  const jev = jevEngine();
  /** @type {string[]} */
  const agreed = [];

  for (const id of ["mid-android-3g", "packet-loss-4g", "stalling-midsession"]) {
    const synth = SYNTHETIC_STATES.find((s) => s.id === id);
    assert.ok(synth, `synthetic state ${id} is missing`);
    const a = await rules.routeTier(/** @type {any} */ (synth).state, ctx);
    const b = await jev.routeTier(/** @type {any} */ (synth).state, ctx);
    if (a.tier === b.tier) agreed.push(`${id}: both said "${a.tier}"`);
  }

  const scenario = TRACE_SCENARIOS.find((s) => s.id === "fail-memory-pressure");
  assert.ok(scenario);
  const trace = buildScenarioTrace(/** @type {any} */ (scenario), manifest);
  const rv = await rules.judgeTrace(trace, ctx);
  const jv = await jev.judgeTrace(trace, ctx);
  if (rv.rootCause.value === jv.rootCause.value) {
    agreed.push(`fail-memory-pressure: both said "${rv.rootCause.value}"`);
  }

  assert.deepEqual(agreed, [], `contested cases are supposed to disagree:\n${agreed.join("\n")}`);
});

test("a fixture miss is an error, not a silently wrong answer", async () => {
  const strict = new JevDecisionEngine({
    transport: new FixtureJevTransport({ fixtures: { $id: "empty", cases: [] }, strict: true }),
  });
  await assert.rejects(
    () => strict.routeTier(/** @type {any} */ (SYNTHETIC_STATES[0]).state, ctx),
    FixtureMissError,
  );
});

test("the fixture key changes when the question wording changes", () => {
  // The property that makes generated fixtures safe: reword a criterion and the
  // old fixture stops matching loudly instead of answering the new question.
  const questions = tierQuestions(manifest.budgets);
  const state = { a: 1 };
  const before = fixtureKey({ state, questions, model: "jev-1" });
  const reworded = structuredClone(questions);
  /** @type {any} */ (reworded)[0].question += " (really)";
  assert.notEqual(before, fixtureKey({ state, questions: reworded, model: "jev-1" }));
});

test("without an API key there is no live transport at all", () => {
  // Not "it fails gracefully": there is nothing to fail. Zero external calls is
  // the default state of this repo, and CI depends on it.
  const resolved = resolveTransport({ env: {} });
  assert.equal(resolved.transport, null);
  assert.equal(resolved.mode, "absent");
  assert.match(resolved.reason ?? "", /TYPESAFE_API_KEY/);
});

/* ── the guard ────────────────────────────────────────────────────────────── */

/** A stub standing in for a model that returns whatever the test needs. */
class StubEngine {
  kind = /** @type {const} */ ("model");
  name = "stub";
  /** @param {{tier?: any; verdict?: any; throws?: Error}} opts */
  constructor(opts) { this.opts = opts; }
  async routeTier(/** @type {any} */ state, /** @type {any} */ c) {
    if (this.opts.throws) throw this.opts.throws;
    return { ...this.opts.tier, path: "interactive-2d", engine: this.name, rationale: [] };
  }
  async judgeTrace(/** @type {any} */ t, /** @type {any} */ c) {
    if (this.opts.throws) throw this.opts.throws;
    return { ...this.opts.verdict, engine: this.name, rationale: [] };
  }
}

/** @param {any} over */
const tierAnswer = (over) => ({
  tier: "high",
  tierAnswer: { value: "high", distribution: { high: 0.95, mid: 0.03, low: 0.01, "static-fallback": 0.01 } },
  cameraPathSafe: { pTrue: 0.9 },
  firstFrameRisk: { score: 1, levels: [...RISK_LEVELS], distribution: softmax({ "very unlikely": 1, unlikely: 2, possible: 0, likely: 0, "very likely": 0 }) },
  confidence: 0.95,
  ...over,
});

const noWebgl = /** @type {any} */ (SYNTHETIC_STATES.find((s) => s.id === "no-webgl")).state;
const strong = /** @type {any} */ (SYNTHETIC_STATES.find((s) => s.id === "desktop-wifi-strong")).state;

test("the guard overrides an infeasible tier and says why", async () => {
  const guard = new GuardedDecisionEngine({ primary: new StubEngine({ tier: tierAnswer({}) }) });
  const d = await guard.routeTier(noWebgl, ctx);
  assert.notEqual(d.tier, "high", "a device with no WebGL must not be served the high tier");
  assert.ok(tierRenderable(noWebgl, manifest, d.tier));
  assert.equal(d.guard.overridden, true);
  assert.equal(d.guard.primaryEngine, "stub");
  assert.match(d.guard.reason, /cannot render/);
  assert.equal(guard.stats.overriddenInfeasible, 1);
});

test("the guard overrides a low-confidence decision", async () => {
  const flat = { high: 0.26, mid: 0.25, low: 0.25, "static-fallback": 0.24 };
  const guard = new GuardedDecisionEngine({
    primary: new StubEngine({
      tier: tierAnswer({ tierAnswer: { value: "high", distribution: flat }, confidence: confidenceOfChoice(flat) }),
    }),
  });
  const d = await guard.routeTier(strong, ctx);
  assert.equal(d.guard.overridden, true);
  assert.ok(d.guard.primaryConfidence < DEFAULT_TIER_CONFIDENCE_FLOOR);
  assert.equal(guard.stats.overriddenLowConfidence, 1);
});

test("a thrown primary degrades to the rule engine rather than failing the run", async () => {
  const guard = new GuardedDecisionEngine({ primary: new StubEngine({ throws: new Error("502 from the gateway") }) });
  const d = await guard.routeTier(strong, ctx);
  assert.equal(d.engine, "rule-based");
  assert.equal(d.guard.overridden, true);
  assert.match(d.guard.error, /502/);
  assert.equal(guard.stats.overriddenError, 1);
});

test("a confident, feasible decision is trusted — the guard is not a veto", async () => {
  const guard = new GuardedDecisionEngine({ primary: new StubEngine({ tier: tierAnswer({}) }) });
  const d = await guard.routeTier(strong, ctx);
  assert.equal(d.tier, "high");
  assert.equal(d.guard?.overridden ?? false, false);
  assert.equal(guard.stats.trusted, 1);
});

test("the path is never the model's to decide", async () => {
  // The stub always claims "interactive-2d". On a strong device with camera
  // permission the correct path is "camera-xr", and the guard must re-derive it
  // from capability even when it trusts the tier.
  const guard = new GuardedDecisionEngine({ primary: new StubEngine({ tier: tierAnswer({}) }) });
  const d = await guard.routeTier(strong, ctx);
  assert.equal(d.path, "camera-xr");
});

/** @param {any} over */
const verdict = (over) => ({
  outcome: { value: "pass", distribution: softmax({ pass: 4, "degraded-but-acceptable": 0, fail: -4, inconclusive: -4 }) },
  rootCause: { value: "unknown", distribution: normalizeDistribution({ unknown: 1 }, ROOT_CAUSE_OPTIONS) },
  releaseBlocking: { score: 0, levels: [...SEVERITY_LEVELS], distribution: normalizeDistribution({ "not blocking": 1 }, SEVERITY_LEVELS) },
  visualInvariantHeld: { pTrue: 0.95 },
  interactionInvariantHeld: { pTrue: 0.95 },
  businessInvariantHeld: { pTrue: 0.95 },
  confidence: 0.95,
  ...over,
});

test("the gate fails closed: a model may tighten a verdict, never loosen it", async () => {
  // The scenario deterministically fails. A model claiming "pass" must not be
  // able to ship it — this is the single asymmetry that makes it safe to put a
  // model in the loop at all.
  const scenario = /** @type {any} */ (TRACE_SCENARIOS.find((s) => s.id === "fail-baseline-low-cpu-3g"));
  const trace = buildScenarioTrace(scenario, manifest);
  const guard = new GuardedDecisionEngine({ primary: new StubEngine({ verdict: verdict({}) }) });
  const v = await guard.judgeTrace(trace, ctx);
  assert.notEqual(v.outcome.value, "pass");
  assert.equal(v.guard.overridden, true);
  assert.ok(severityRank(v.outcome.value) > severityRank("pass"));
});

test("a model verdict stricter than the deterministic one is kept", async () => {
  const scenario = /** @type {any} */ (TRACE_SCENARIOS.find((s) => s.id === "pass-high-desktop"));
  const trace = buildScenarioTrace(scenario, manifest);
  const strict = verdict({
    outcome: { value: "fail", distribution: softmax({ pass: -4, "degraded-but-acceptable": -2, fail: 4, inconclusive: -4 }) },
  });
  const guard = new GuardedDecisionEngine({ primary: new StubEngine({ verdict: strict }) });
  const v = await guard.judgeTrace(trace, ctx);
  assert.equal(v.outcome.value, "fail", "the model is allowed to be more pessimistic than the rules");
  assert.equal(v.guard?.overridden ?? false, false);
});

test("severityRank orders outcomes from most to least shippable", () => {
  assert.ok(severityRank("pass") < severityRank("degraded-but-acceptable"));
  assert.ok(severityRank("degraded-but-acceptable") < severityRank("inconclusive"));
  assert.ok(severityRank("inconclusive") < severityRank("fail"));
});

/* ── answer readers ───────────────────────────────────────────────────────── */

test("normalizeDistribution drops undeclared keys and renormalises", () => {
  const d = normalizeDistribution({ high: 0.5, mid: 0.3, nonsense: 0.2 }, TIER_OPTIONS);
  assert.deepEqual(Object.keys(d).sort(), [...TIER_OPTIONS].sort());
  assert.ok(Math.abs(Object.values(d).reduce((s, v) => s + v, 0) - 1) < 1e-9);
  assert.equal("nonsense" in d, false);
});

test("an all-zero distribution becomes uniform rather than NaN", () => {
  const d = normalizeDistribution({}, TIER_OPTIONS);
  for (const option of TIER_OPTIONS) assert.ok(Math.abs(d[option] - 1 / TIER_OPTIONS.length) < 1e-9);
});

test("the answer readers refuse to invent values", () => {
  assert.equal(readChoiceValue({ choice: "nonsense" }, TIER_OPTIONS), null);
  assert.equal(readChoiceValue(/** @type {any} */ (null), TIER_OPTIONS), null);
  assert.equal(readScore(/** @type {any} */ ({})), null);
  assert.equal(readProbability(/** @type {any} */ ({})), 0.5, "an absent probability is maximal uncertainty");
});

test("confidence is highest when a distribution is decisive", () => {
  const sharp = confidenceOfChoice({ high: 0.97, mid: 0.01, low: 0.01, "static-fallback": 0.01 });
  const flat = confidenceOfChoice({ high: 0.25, mid: 0.25, low: 0.25, "static-fallback": 0.25 });
  assert.ok(sharp > flat);
  assert.ok(flat >= 0 && sharp <= 1);
  // A noul at 0.5 is the least informative answer possible.
  assert.ok(confidenceOfNoul(0.5) < confidenceOfNoul(0.99));
  assert.ok(Math.abs(confidenceOfNoul(0.02) - confidenceOfNoul(0.98)) < 1e-9, "certainty is symmetric");
});

test("expectedScore lands on the level a one-hot distribution names", () => {
  assert.ok(Math.abs(expectedScore({ "not blocking": 1 }, SEVERITY_LEVELS) - 0) < 1e-9);
  assert.ok(Math.abs(expectedScore({ "hard block": 1 }, SEVERITY_LEVELS) - 4) < 1e-9);
  assert.ok(Math.abs(expectedScore({ minor: 0.5, moderate: 0.5 }, SEVERITY_LEVELS) - 1.5) < 1e-9);
});

test("softmax is a probability distribution and respects temperature", () => {
  const scores = { a: 2, b: 1, c: 0 };
  for (const t of [0.3, 1, 3]) {
    const d = softmax(scores, t);
    assert.ok(Math.abs(Object.values(d).reduce((s, v) => s + v, 0) - 1) < 1e-9, `t=${t} does not sum to 1`);
  }
  assert.ok(softmax(scores, 0.3).a > softmax(scores, 3).a, "lower temperature must be more decisive");
});
