/**
 * RuleBasedDecisionEngine — the default engine.
 *
 * Zero external calls, zero API key, fully deterministic, and the thing every
 * hard-coded assertion in the test suite is checked against. If the Jev engine
 * is unavailable, misconfigured, or low-confidence, this is what answers.
 *
 * It is a *cost model*, not a lookup table: it predicts first-frame time and
 * frame cost from the capability snapshot and the manifest's own declared
 * tier parameters, then picks the richest tier that fits the declared budget.
 * That matters because the same model is what makes the low-CPU/3G failure
 * story predictable rather than hand-tuned to one profile.
 *
 * @typedef {import("../../types/atlas.js").CapabilitySnapshot} CapabilitySnapshot
 * @typedef {import("../../types/atlas.js").DecisionContext} DecisionContext
 * @typedef {import("../../types/atlas.js").DecisionEngine} DecisionEngine
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 * @typedef {import("../../types/atlas.js").ServeTier} ServeTier
 * @typedef {import("../../types/atlas.js").TierDecision} TierDecision
 * @typedef {import("../../types/atlas.js").Trace} Trace
 * @typedef {import("../../types/atlas.js").TraceVerdict} TraceVerdict
 * @typedef {import("../../types/atlas.js").RootCause} RootCause
 */

import { resolvePath, satisfiedRequirements } from "../capability/buckets.js";
import {
  COMFORT_LEVELS,
  RISK_LEVELS,
  ROOT_CAUSE_OPTIONS,
  SEVERITY_LEVELS,
  OUTCOME_OPTIONS,
  TIER_OPTIONS,
  confidenceOfChoice,
  confidenceOfNoul,
  expectedScore,
  incidentQuestionKey,
  round6,
  softmax,
} from "./questions.js";
import { validateStateOrdering } from "../manifest/validate.js";
import { evaluateComfort } from "../gate/comfort.js";

/**
 * Hand-written matchers for the incidents this repo shipped with.
 *
 * This table is the honest shape of the rule-based answer to "have we seen this
 * before", and it is deliberately incomplete. Each entry is a predicate someone
 * wrote *after* seeing a specific failure, which means it recognises that
 * failure and nothing else: an incident recorded by a customer next Tuesday has
 * no entry here and never will, because nobody will be writing JavaScript in
 * response to it.
 *
 * So this is the one question where the two engines are not doing the same work
 * in two ways — one of them is structurally unable to do the work at all past
 * the cases it was pre-taught. Keeping the table here, visible and obviously
 * finite, is more useful than hiding the gap behind a 0.5: §4.4's comparison is
 * only interesting if the rule engine's ceiling is legible.
 *
 * Returns `null` for "no matcher exists", which the caller turns into 0.5 and a
 * rationale line, not into a confident "no".
 *
 * @type {Record<string, (ev: IncidentEvidence) => number>}
 */
const KNOWN_INCIDENT_MATCHERS = {
  "inc-blankfirst": (ev) =>
    ev.blankFirstFrame || (ev.minCoverage !== null && ev.minCoverage <= 0.002) ? 0.93 : 0.04,

  "inc-heavyblank": (ev) =>
    ev.transferBytes > 1_500_000 && ev.assetFailures === 0 && ev.framesRendered < 10 ? 0.9 : 0.05,

  "inc-xrdeadend": (ev) => {
    if (!ev.xrAttempted) return 0.03;
    return ev.xrFallbackHeld === false ? 0.94 : 0.07;
  },

  "inc-stallwindow": (ev) => {
    if (ev.pacingRatio === null) return 0.5;
    if (ev.pacingRatio > 1.5) return 0.91;
    if (ev.pacingRatio > 1) return 0.68;
    return 0.05;
  },

  "inc-timingblind": (ev) =>
    ev.transferBytes <= 2_000 && ev.framesRendered > 20 ? 0.88 : 0.05,
};

/**
 * @typedef {object} IncidentEvidence
 * @property {boolean} blankFirstFrame
 * @property {number | null} minCoverage
 * @property {number} transferBytes
 * @property {number} assetFailures
 * @property {number} framesRendered
 * @property {boolean} xrAttempted
 * @property {boolean | null} xrFallbackHeld
 * @property {number | null} pacingRatio  worst-window p95 ÷ the declared budget
 */

/* ── cost model ──────────────────────────────────────────────────────────── */

/**
 * Fixed score for the static poster: better than nothing, worse than any
 * viable experience. See the calibration comment at the use site in
 * `routeTierSync` — this number is policy, and policy lives in one place.
 */
export const STATIC_FALLBACK_SCORE = -3.0;

/**
 * Relative CPU slowness vs. a reference desktop core. 1.0 = reference.
 * @param {CapabilitySnapshot} s
 */
export function cpuFactor(s) {
  const cores = s.hardwareConcurrency ?? 4;
  const mem = s.deviceMemoryGB ?? 4;
  const byCores = Math.max(1, 8 / Math.max(1, cores));
  const byMem = mem <= 2 ? 1.8 : mem <= 4 ? 1.3 : 1;
  const byGpu = s.gpuTier === "low" ? 1.6 : s.gpuTier === "mid" ? 1.15 : s.gpuTier === "none" ? 2.2 : 1;
  return round6(byCores * byMem * byGpu);
}

/**
 * Predicted transfer time in ms for a byte count on this connection.
 * @param {CapabilitySnapshot} s
 * @param {number} bytes
 * @param {number} requestCount
 */
export function transferMs(s, bytes, requestCount) {
  const mbps = s.downlinkMbps ?? (s.effectiveConnectionType === "4g" ? 9 : s.effectiveConnectionType === "3g" ? 1.4 : 5);
  const rtt = s.rttMs ?? (s.effectiveConnectionType === "3g" ? 300 : 90);
  const bits = bytes * 8;
  const throughputMs = (bits / Math.max(0.05, mbps) / 1e6) * 1000;
  // One RTT for connection reuse plus one per request, roughly.
  const latencyMs = rtt * (1 + Math.min(requestCount, 4) * 0.5);
  return round6(throughputMs + latencyMs);
}

/**
 * Predicted first-frame time and steady frame time for a given tier.
 * @param {CapabilitySnapshot} s
 * @param {ExperienceManifest} manifest
 * @param {ServeTier} tier
 */
export function predict(s, manifest, tier) {
  if (tier === "static-fallback") {
    // Poster only: one small image, no shader work.
    return {
      firstFrameMs: round6(transferMs(s, 62_000, 1) + 80),
      frameTimeMs: 0,
      bytes: 62_000,
    };
  }
  const spec = manifest.tiers.find((t) => t.id === tier);
  if (!spec) return { firstFrameMs: Infinity, frameTimeMs: Infinity, bytes: Infinity };
  const bytes = spec.assets.reduce((sum, a) => sum + a.approxBytes, 0);
  const cpu = cpuFactor(s);
  // Runtime boot + shader compile scale with CPU; compile cost scales with passes.
  const bootMs = 110 * cpu + spec.params.shaderPasses * 45 * cpu;
  const decodeMs = (spec.params.textureSize / 256) ** 2 * 18 * cpu;
  const firstFrameMs = transferMs(s, bytes, spec.assets.length) + bootMs + decodeMs;
  const frameTimeMs = spec.params.perFrameWorkMs * cpu + spec.params.particleCount / 900 * cpu;
  return { firstFrameMs: round6(firstFrameMs), frameTimeMs: round6(frameTimeMs), bytes };
}

/**
 * Hard capability gate: can this tier render at all on this state?
 * @param {CapabilitySnapshot} s
 * @param {ExperienceManifest} manifest
 * @param {ServeTier} tier
 */
export function tierRenderable(s, manifest, tier) {
  if (tier === "static-fallback") return true;
  const spec = manifest.tiers.find((t) => t.id === tier);
  if (!spec) return false;
  const have = satisfiedRequirements(s);
  return spec.requires.every((r) => have.has(r));
}

/* ── engine ──────────────────────────────────────────────────────────────── */

/** @implements {DecisionEngine} */
export class RuleBasedDecisionEngine {
  /** @type {"deterministic"} */
  kind = "deterministic";
  name = "rule-based";

  /**
   * @param {CapabilitySnapshot} state
   * @param {DecisionContext} ctx
   * @returns {Promise<TierDecision>}
   */
  async routeTier(state, ctx) {
    return this.routeTierSync(state, ctx);
  }

  /**
   * Synchronous twin — the browser-facing control plane calls this on the hot
   * path, where an `await` per request would be pure overhead.
   *
   * @param {CapabilitySnapshot} state
   * @param {DecisionContext} ctx
   * @returns {TierDecision}
   */
  routeTierSync(state, ctx) {
    const { manifest } = ctx;
    /** @type {string[]} */
    const rationale = [];
    const budget = manifest.budgets.firstFrameMs;

    /** @type {Record<string, number>} */
    const scores = {};
    /** @type {ServeTier[]} */
    const candidates = /** @type {ServeTier[]} */ ([...TIER_OPTIONS]);

    for (const tier of candidates) {
      if (tier === "static-fallback") {
        // The poster is not an experience tier and does not compete on
        // headroom terms: its 0ms frame time and 62KB transfer would otherwise
        // score near-perfect and beat every real tier on capable hardware
        // (measured: static outscored high on a strong desktop). The constant
        // below means "better than nothing, worse than any viable experience":
        // it sits below a struggling-but-viable low (low-cpu-3g scores ≈ −2.2)
        // and above total failure (slow-2g's low scores ≈ −4.4). Calibrated in
        // tests/decision.test.js via the uncontested ground truths, not derived.
        scores[tier] = STATIC_FALLBACK_SCORE;
        continue;
      }
      if (!tierRenderable(state, manifest, tier)) {
        scores[tier] = -12;
        continue;
      }
      const p = predict(state, manifest, tier);
      // Headroom expressed in budget-multiples; >0 means it fits.
      const headroom = (budget - p.firstFrameMs) / budget;
      // Frame-time headroom against the tier's own fps target.
      const spec = manifest.tiers.find((t) => t.id === tier);
      const frameBudget = spec ? 1000 / spec.params.targetFps : 1000 / 30;
      const frameHeadroom = spec ? (frameBudget - p.frameTimeMs) / frameBudget : 1;
      // Richness must dominate positive headroom: the ladder serves the richest
      // tier the device can sustain, not the leanest tier with the most slack.
      // A capable desktop fits 'high' with ~35% headroom and must be served it;
      // the old weights (1.1/0.7/0.35) let 'low' win there by nearly 1.2 points.
      // Calibrated against the uncontested ground truths in fixtures/states.js
      // (tightest binding cases: flagship needs high−mid > 1.86, mid-android-4g
      // needs mid−low > 2.04 while unknown-everything needs mid−low < 2.21).
      //
      // The transfer floor sits at −8, deliberately far below the frame floor
      // (−2): clamping catastrophic transfer at −2 equalised a dead network
      // across tiers, and with transfer tied the richness bonus picked the
      // RICHEST tier — measured serving 'high' to a 2G device. Transfer spans
      // orders of magnitude across tiers where frame cost does not, so
      // catastrophic transfer must stay distinguishable for the leanest viable
      // tier (or the static poster) to win it.
      const richness = tier === "high" ? 4.4 : tier === "mid" ? 2.4 : 0.3;
      scores[tier] = round6(richness + 2.4 * clamp(headroom, -8, 1) + 1.6 * clamp(frameHeadroom, -2, 1));
    }

    // Accessibility: an explicit reduced-motion preference is a stated request
    // for no motion, not a capability limit — every interactive tier is out,
    // and the static poster wins by construction rather than by outscoring.
    if (state.reducedMotionPreferred) {
      scores.high -= 12;
      scores.mid -= 12;
      scores.low -= 12;
      rationale.push("prefers-reduced-motion is set: interactive tiers excluded, static poster served.");
    }
    // A state with no GPU acceleration at all should not attempt the top tier
    // even if it somehow reports WebGL2.
    if (state.gpuTier === "none") {
      scores.high -= 4;
      rationale.push("gpuTier=none: excluding the 'high' tier regardless of reported WebGL version.");
    }

    const dist = softmax(scores, 0.55);
    const tier = /** @type {ServeTier} */ (
      candidates.reduce((best, t) => (scores[t] > scores[best] ? t : best), candidates[0])
    );

    const chosen = predict(state, manifest, tier);
    rationale.push(
      `cpuFactor=${cpuFactor(state)}; predicted first frame on '${tier}' = ` +
        `${Math.round(chosen.firstFrameMs)}ms against a ${budget}ms budget.`,
    );
    for (const t of candidates) {
      if (t !== tier && !tierRenderable(state, manifest, t)) {
        rationale.push(`'${t}' is not renderable here (missing ${missingFor(state, manifest, t).join(", ")}).`);
      }
    }

    // ── cameraPathSafe (noul) ──────────────────────────────────────────────
    let pCamera = 0.5;
    if (state.cameraPermission === "granted") pCamera = 0.9;
    // "prompt" means the permission state is unknown — and an unknown state is
    // not a safe state. Attempting the camera path before the user has answered
    // risks the exact permission failure the question asks about, so prompt
    // sits just below the decision boundary rather than just above it.
    if (state.cameraPermission === "prompt") pCamera = 0.45;
    if (state.cameraPermission === "denied" || state.cameraPermission === "unavailable") pCamera = 0.02;
    if (state.webglVersion === 0) pCamera = Math.min(pCamera, 0.05);
    if (state.gpuTier === "low" && (state.deviceMemoryGB ?? 4) <= 2) pCamera = Math.min(pCamera, 0.25);
    if ((state.recentFrameTimeMsP95 ?? 0) > 60) pCamera = Math.min(pCamera, 0.3);
    pCamera = round6(clamp(pCamera, 0.01, 0.99));
    if (pCamera < 0.5) {
      rationale.push(
        `camera path judged unsafe (p=${pCamera}): permission=${state.cameraPermission}, ` +
          `webgl=${state.webglVersion}, gpu=${state.gpuTier}.`,
      );
    }

    // ── firstFrameRisk (score, asked about the 'mid' tier specifically) ────
    const midPredicted = predict(state, manifest, "mid").firstFrameMs;
    const ratio = midPredicted / budget;
    const riskDist = softmax(
      {
        "very unlikely": -4 * (ratio - 0.35),
        unlikely: -4 * Math.abs(ratio - 0.6),
        possible: -4 * Math.abs(ratio - 0.95),
        likely: -4 * Math.abs(ratio - 1.4),
        "very likely": -4 * Math.max(0, 2.2 - ratio),
      },
      0.9,
    );

    return {
      tier,
      tierAnswer: { value: tier, distribution: dist },
      cameraPathSafe: { pTrue: pCamera },
      firstFrameRisk: {
        score: expectedScore(riskDist, RISK_LEVELS),
        levels: [...RISK_LEVELS],
        distribution: riskDist,
      },
      path: resolvePath(state, manifest, tier),
      confidence: confidenceOfChoice(dist),
      engine: this.name,
      rationale,
    };
  }

  /**
   * @param {Trace} trace
   * @param {DecisionContext} ctx
   * @returns {Promise<TraceVerdict>}
   */
  async judgeTrace(trace, ctx) {
    return this.judgeTraceSync(trace, ctx);
  }

  /**
   * @param {Trace} trace
   * @param {DecisionContext} ctx
   * @returns {TraceVerdict}
   */
  judgeTraceSync(trace, ctx) {
    const { manifest } = ctx;
    const m = trace.metrics;
    const b = manifest.budgets;
    /** @type {string[]} */
    const rationale = [];

    // ── the three invariants, evaluated independently ──────────────────────
    const blankFirstFrame = m.firstFrameNonBlank === false;
    // Focal coverage answers whether the first product frame appeared. Later
    // checkpoints may contain a detail panel, cart or other UI state, so their
    // modal screenshot colour is not a valid blank-frame reference.
    const firstFrameCheckpoint = trace.checkpoints.find(
      (c) => c.id === "cp-first-frame" || c.state === "first-frame",
    );
    const minCoverage = typeof firstFrameCheckpoint?.focalCoverage === "number"
      ? firstFrameCheckpoint.focalCoverage
      : null;
    // Edge drift is a stability measure only between repeated captures of the
    // same app state. Different states can have different valid layouts.
    const drift = trace.checkpoints
      .slice(1)
      .filter((c, index) => c.state === trace.checkpoints[index].state)
      .map((c) => c.alphaEdgeDrift)
      .filter(/** @returns {v is number} */ (v) => typeof v === "number");
    const maxDrift = drift.length ? Math.max(...drift) : null;

    let pVisual = 0.9;
    if (blankFirstFrame) { pVisual = 0.02; rationale.push("first frame was blank."); }
    if (minCoverage !== null && minCoverage < manifest.invariants.visual.minFocalCoverage) {
      pVisual = Math.min(pVisual, 0.08);
      rationale.push(`focal coverage fell to ${minCoverage.toFixed(3)} (min ${manifest.invariants.visual.minFocalCoverage}).`);
    }
    if (maxDrift !== null && maxDrift > manifest.invariants.visual.maxAlphaEdgeDrift) {
      pVisual = Math.min(pVisual, 0.2);
      rationale.push(`alpha-edge drift ${maxDrift.toFixed(3)} exceeded ${manifest.invariants.visual.maxAlphaEdgeDrift}.`);
    }
    if (m.firstFrameNonBlank === null && trace.checkpoints.length === 0) pVisual = 0.5;

    const ordering = validateStateOrdering(trace.states, manifest);
    const p95 = m.p95InteractionMs;
    const p95Limit = Math.min(b.p95InteractionMs, manifest.invariants.interaction.p95TapResponseMs);
    let pInteraction = 0.9;
    if (!ordering.ok) {
      pInteraction = 0.03;
      rationale.push(
        `illegal state transition ${ordering.firstIllegal?.from} -> ${ordering.firstIllegal?.to} ` +
          `at index ${ordering.firstIllegal?.index}.`,
      );
    }
    if (p95 !== null && p95 > p95Limit) {
      pInteraction = Math.min(pInteraction, p95 > p95Limit * 2 ? 0.05 : 0.25);
      rationale.push(`p95 interaction ${Math.round(p95)}ms over the ${p95Limit}ms limit.`);
    }
    if (m.droppedFrameRatio !== null && m.droppedFrameRatio > b.maxDroppedFrameRatio) {
      pInteraction = Math.min(pInteraction, 0.2);
      rationale.push(`dropped-frame ratio ${m.droppedFrameRatio.toFixed(3)} over ${b.maxDroppedFrameRatio}.`);
    }
    if (m.interactionCount === 0) {
      pInteraction = Math.min(pInteraction, 0.4);
      rationale.push("no interactions were recorded; interaction invariant cannot be fully confirmed.");
    }

    let pBusiness = m.reachedEndState ? 0.96 : 0.03;
    if (m.reachedEndState && m.stepsToEndState !== null &&
        m.stepsToEndState > manifest.invariants.business.maxStepsToEndState) {
      pBusiness = 0.3;
      rationale.push(`reached checkout in ${m.stepsToEndState} steps, over the declared maximum.`);
    }
    if (!m.reachedEndState) rationale.push("session never reached the checkout-complete end state.");

    // ── budget breaches ────────────────────────────────────────────────────
    /** @type {string[]} */
    const breaches = [];
    if (m.firstFrameMs !== null && m.firstFrameMs > b.firstFrameMs) breaches.push(`firstFrame ${Math.round(m.firstFrameMs)}>${b.firstFrameMs}ms`);
    if (m.timeToInteractiveMs !== null && m.timeToInteractiveMs > b.timeToInteractiveMs) breaches.push(`TTI ${Math.round(m.timeToInteractiveMs)}>${b.timeToInteractiveMs}ms`);
    if (p95 !== null && p95 > p95Limit) breaches.push(`p95 ${Math.round(p95)}>${p95Limit}ms`);
    if (m.droppedFrameRatio !== null && m.droppedFrameRatio > b.maxDroppedFrameRatio) breaches.push("droppedFrames");
    if (m.transferBytes > b.maxTransferBytes) breaches.push(`transfer ${m.transferBytes}>${b.maxTransferBytes}B`);
    if (m.jsHeapUsedMB !== null && m.jsHeapUsedMB > b.maxJsHeapMB) breaches.push(`heap ${Math.round(m.jsHeapUsedMB)}>${b.maxJsHeapMB}MB`);
    if (breaches.length) rationale.push(`budget breaches: ${breaches.join(", ")}.`);

    const errorEvents = trace.events.filter((e) => e.kind === "error");
    // A trace that ends mid-flow with no error of its own is a dead harness,
    // not a product defect: every genuine failure in the vocabulary either
    // reaches a terminal state or leaves error events behind. Terminality is
    // read off the manifest's own transition graph (states with no outgoing
    // edge, plus the end state and "error" explicitly), so this works for the
    // generic manifest's vocabulary too — not just Orbital's. The truncated
    // fixture is the only scenario shaped this way, which is exactly why it
    // exists.
    const transitions = manifest.invariants.interaction.allowedTransitions ?? [];
    const hasOutgoing = new Set(transitions.map((t) => t[0]));
    const lastState = trace.states.length ? trace.states[trace.states.length - 1] : null;
    const endedMidFlow =
      !m.reachedEndState &&
      errorEvents.length === 0 &&
      lastState !== null &&
      lastState !== manifest.invariants.business.endState &&
      lastState !== "error" &&
      hasOutgoing.has(lastState);
    const incomplete =
      trace.states.length < 3 ||
      endedMidFlow ||
      (m.firstFrameMs === null && m.timeToInteractiveMs === null && !m.reachedEndState && errorEvents.length === 0);

    // ── outcome (choice) ───────────────────────────────────────────────────
    const hardFail = pBusiness < 0.5 || pVisual < 0.1 || !ordering.ok;
    const softFail = breaches.length > 0 || pInteraction < 0.5 || pVisual < 0.5;
    /** @type {Record<string, number>} */
    const outcomeScores = {
      pass: incomplete ? -3 : hardFail ? -6 : softFail ? -2.2 : 3.2,
      "degraded-but-acceptable": incomplete ? -3 : hardFail ? -3 : softFail ? 2.6 : -1.2,
      // An incomplete trace must not be called a failure no matter how broken
      // it looks: "never reached checkout" is also what a dead harness looks
      // like, and scoring it 3.4 here would manufacture product bugs out of
      // infrastructure flakiness (and block releases for it in the gate).
      fail: incomplete ? 0.5 : hardFail ? 3.4 : softFail ? -0.6 : -5,
      inconclusive: incomplete ? 3.0 : -4.5,
    };
    // A served fallback tier that still meets every budget and invariant is
    // exactly what "degraded-but-acceptable" is for.
    if (!hardFail && !softFail && trace.servedTier && trace.servedTier !== "high") {
      outcomeScores["degraded-but-acceptable"] += 1.1;
      outcomeScores.pass += 0.2;
    }
    const outcomeDist = softmax(outcomeScores, 0.7);
    const outcome = /** @type {any} */ (argmax(outcomeScores));

    // ── rootCause (choice) ─────────────────────────────────────────────────
    /** @type {Record<string, number>} */
    const causeScores = Object.fromEntries(ROOT_CAUSE_OPTIONS.map((c) => [c, 0]));
    if (outcome === "pass") {
      causeScores.unknown += 3;
    } else {
      const networkPressure =
        (trace.capabilityBucket.network === "poor" ? 1.6 : 0) +
        (m.assetFailures > 0 ? 1.4 : 0) +
        (m.firstFrameMs !== null && m.firstFrameMs > b.firstFrameMs ? 1.2 : 0);
      causeScores.network += networkPressure;
      if (trace.capability.cameraPermission !== "granted" && trace.servedPath === "camera-xr") {
        causeScores["permission-denied"] += 3.2;
      }
      if (trace.capability.cameraPermission === "denied") causeScores["permission-denied"] += 1.4;
      if (trace.capability.webglVersion === 0) causeScores["codec-unsupported"] += 1.2;
      if (errorEvents.some((e) => String(e.attributes.code ?? "").includes("codec"))) {
        causeScores["codec-unsupported"] += 2.6;
      }
      if (m.droppedFrameRatio !== null && m.droppedFrameRatio > b.maxDroppedFrameRatio) {
        causeScores["render-stall"] += 2.0;
      }
      if (p95 !== null && p95 > p95Limit) causeScores["render-stall"] += 1.5;
      if (m.jsHeapUsedMB !== null && m.jsHeapUsedMB > b.maxJsHeapMB) causeScores.memory += 2.8;
      if ((trace.capability.deviceMemoryGB ?? 8) <= 2 && m.droppedFrameRatio !== null && m.droppedFrameRatio > 0.3) {
        causeScores.memory += 1.0;
      }
      if (!ordering.ok) causeScores["manifest-bug"] += 3.0;
      if (trace.servedTier && !tierRenderable(trace.capability, manifest, trace.servedTier)) {
        causeScores["manifest-bug"] += 2.5;
        rationale.push(`served tier '${trace.servedTier}' is not renderable on this capability state.`);
      }
      if (Object.values(causeScores).every((v) => v === 0)) causeScores.unknown += 2;
    }
    const causeDist = softmax(causeScores, 0.7);
    const rootCause = /** @type {RootCause} */ (argmax(causeScores));

    // ── releaseBlocking (score) ────────────────────────────────────────────
    let severity = 0;
    if (outcome === "degraded-but-acceptable") severity = 1;
    if (outcome === "inconclusive") severity = 1.5;
    if (outcome === "fail") severity = 3;
    if (pBusiness < 0.5) severity = 4;
    if (blankFirstFrame) severity = Math.max(severity, 4);
    if (!ordering.ok) severity = Math.max(severity, 3.5);
    if (breaches.length >= 3) severity = Math.max(severity, 3);
    /** @type {Record<string, number>} */
    const sevScores = {};
    SEVERITY_LEVELS.forEach((level, idx) => {
      sevScores[level] = -2.2 * Math.abs(idx - severity);
    });
    const sevDist = softmax(sevScores, 0.8);

    const distValues = [
      confidenceOfChoice(outcomeDist),
      confidenceOfChoice(causeDist),
      confidenceOfNoul(pVisual),
      confidenceOfNoul(pInteraction),
      confidenceOfNoul(pBusiness),
    ];

    // ── comfort (score) and the XR-refusal fallback (noul) ─────────────────
    //
    // Both read `evaluateComfort`, which is the same arithmetic the Atlas score
    // grades. That is the point: the rule engine's comfort answer is a
    // *restatement* of measurements, and Jev's is an interpretation of them.
    // When the two disagree, the disagreement is about meaning rather than
    // about numbers, which is the only kind of disagreement worth reading.
    const comfort = evaluateComfort(trace, manifest);
    const pacing = comfort.dimensions.sustainedPacing;
    const respond = comfort.dimensions.responsiveness;
    const fallback = comfort.dimensions.xrFallback;

    // Worst of the two continuous dimensions drives the level: a session that
    // paces perfectly and ignores your finger is not comfortable.
    const comfortRatios = [pacing.ratio, respond.ratio].filter(
      /** @returns {r is number} */ (r) => typeof r === "number",
    );
    const worstRatio = comfortRatios.length ? Math.max(...comfortRatios) : null;
    // ratio 0.5 → 0, 1.0 → 1, 1.5 → 2, 2.0 → 3, 2.5+ → 4. Linear in ratio
    // because the underlying quantity is a frame time and doubling a frame
    // time really does roughly double how bad it feels.
    const comfortLevel =
      worstRatio === null ? 1.6 : clamp((worstRatio - 0.5) * 2, 0, COMFORT_LEVELS.length - 1);
    /** @type {Record<string, number>} */
    const comfortScores = {};
    COMFORT_LEVELS.forEach((level, idx) => {
      // Flatter than the severity curve when there is no frame evidence: an
      // engine with nothing to go on should look uncertain, not opinionated.
      comfortScores[level] = (worstRatio === null ? -0.9 : -2.2) * Math.abs(idx - comfortLevel);
    });
    const comfortDist = softmax(comfortScores, 0.8);
    if (worstRatio === null) {
      rationale.push("no frame-time or input-latency evidence; comfort is a guess.");
    } else if (!pacing.held || !respond.held) {
      rationale.push(`comfort: ${comfort.findings.join(" ")}`);
    }

    // `xrFallback.held` is three-valued. `null` means XR was never attempted,
    // which is not a failure and not a pass — 0.5, and the guard reads the low
    // confidence correctly.
    const pFallback =
      fallback.held === null ? 0.5 : fallback.held ? 0.93 : 0.05;
    if (fallback.held === false) rationale.push(`xr fallback: ${fallback.basis}`);

    // ── incident recall (noul × k) ─────────────────────────────────────────
    const incidents = ctx.incidents ?? [];
    /** @type {IncidentEvidence} */
    const evidence = {
      blankFirstFrame,
      minCoverage,
      transferBytes: m.transferBytes,
      assetFailures: m.assetFailures,
      framesRendered: m.framesRendered,
      xrAttempted: (trace.xrSessionEvents ?? []).length > 0,
      xrFallbackHeld: fallback.held,
      pacingRatio: pacing.ratio,
    };
    /** @type {Record<string, { pTrue: number }>} */
    const incidentAnswers = {};
    /** @type {string[]} */
    const unmatchable = [];
    incidents.forEach((inc, idx) => {
      const matcher = KNOWN_INCIDENT_MATCHERS[inc.id];
      if (matcher) {
        incidentAnswers[incidentQuestionKey(idx)] = { pTrue: round6(matcher(evidence)) };
      } else {
        incidentAnswers[incidentQuestionKey(idx)] = { pTrue: 0.5 };
        unmatchable.push(inc.id);
      }
    });
    if (unmatchable.length) {
      rationale.push(
        `no hand-written matcher for ${unmatchable.join(", ")}; the rule engine ` +
          "cannot recognise an incident it was not written against.",
      );
    }

    return {
      outcome: { value: outcome, distribution: outcomeDist },
      rootCause: { value: rootCause, distribution: causeDist },
      releaseBlocking: {
        score: expectedScore(sevDist, SEVERITY_LEVELS),
        levels: [...SEVERITY_LEVELS],
        distribution: sevDist,
      },
      visualInvariantHeld: { pTrue: round6(pVisual) },
      interactionInvariantHeld: { pTrue: round6(pInteraction) },
      businessInvariantHeld: { pTrue: round6(pBusiness) },
      comfortRisk: {
        score: expectedScore(comfortDist, COMFORT_LEVELS),
        levels: [...COMFORT_LEVELS],
        distribution: comfortDist,
      },
      accessibleFallback: { pTrue: round6(pFallback) },
      incidentMatches: incidentAnswers,
      // Deliberately unchanged: the six original answers still set the
      // engine's confidence. The fan-out questions are additive information,
      // and letting a 0.5 on an unmatchable incident drag the whole verdict's
      // confidence below the guard floor would make adding an incident to the
      // store silently degrade every future verdict.
      confidence: round6(Math.min(...distValues)),
      engine: this.name,
      rationale,
    };
  }

  /**
   * Pre-launch static assessment over measured asset weight.
   *
   * Pure arithmetic on bytes-versus-budget: the ratio of total known weight to
   * `maxTransferBytes` picks the tier, a sigmoid centred on the budget gives
   * P(fits), and the blowBudget score is the ratio mapped onto the 0..4
   * rubric. Unknown bytes are treated as weight, not headroom — they pull the
   * tier down and the risk up through the effective ratio, and the rationale
   * says by how much rather than silently absorbing them.
   *
   * @param {import("../../types/atlas.js").PreflightState} state
   * @param {DecisionContext} ctx
   * @returns {Promise<import("../../types/atlas.js").PreflightAssessment>}
   */
  async preflightAssess(state, ctx) {
    const budget = ctx.manifest.budgets.maxTransferBytes;
    const known = Math.max(0, state.totalBytes);
    const unknown = Math.max(0, state.unknownBytes);
    // Unknowns count at half weight: unmeasured is usually overhead (headers,
    // small files), but assuming zero would bless pages nobody measured.
    const effective = known + 0.5 * unknown;
    const ratio = effective / budget;
    /** @type {string[]} */
    const rationale = [
      `measured ${fmtBytes(known)} known + ${fmtBytes(unknown)} unknown across ${state.assetCount} assets against a ${fmtBytes(budget)} transfer budget (effective ratio ${ratio.toFixed(2)}).`,
    ];
    if (unknown > 0) {
      rationale.push(
        `${fmtBytes(unknown)} could not be sized and counts at half weight — the assessment is conservative by construction.`,
      );
    }

    /** @type {Record<string, number>} */
    const scores = {
      high: round6(1.0 - 2.5 * ratio),
      mid: round6(0.7 - 1.2 * ratio),
      low: round6(0.4 - 0.4 * ratio),
      "static-fallback": round6(-0.5 + 0.4 * ratio),
    };
    const dist = softmax(scores, 0.55);
    const tier = /** @type {ServeTier} */ (argmax(scores));

    const blow = clamp((ratio - 0.25) / 1.5, 0, 1) * 4;
    /** @type {Record<string, number>} */
    const blowScores = {};
    RISK_LEVELS.forEach((level, i) => {
      blowScores[level] = -Math.abs(i - blow) * 2;
    });
    const blowDist = softmax(blowScores, 0.8);

    const pFits = round6(1 / (1 + Math.exp(6 * (ratio - 1))));

    return {
      tier,
      tierAnswer: { value: tier, distribution: dist },
      blowBudget: {
        score: round6(blow),
        levels: [...RISK_LEVELS],
        distribution: blowDist,
      },
      transferFits: { pTrue: pFits },
      confidence: confidenceOfChoice(dist),
      engine: this.name,
      rationale,
    };
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** @param {Record<string, number>} scores */
function argmax(scores) {
  return Object.keys(scores).reduce((best, k) => (scores[k] > scores[best] ? k : best), Object.keys(scores)[0]);
}

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** @param {number} bytes */
function fmtBytes(bytes) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)}KB`;
  return `${Math.round(bytes)}B`;
}

/**
 * @param {CapabilitySnapshot} s
 * @param {ExperienceManifest} manifest
 * @param {ServeTier} tier
 */
function missingFor(s, manifest, tier) {
  if (tier === "static-fallback") return [];
  const spec = manifest.tiers.find((t) => t.id === tier);
  if (!spec) return ["unknown tier"];
  const have = satisfiedRequirements(s);
  return spec.requires.filter((r) => !have.has(r));
}

export { OUTCOME_OPTIONS };
