/**
 * The question set, defined once.
 *
 * Both DecisionEngine implementations answer *these exact questions*: the Jev
 * engine sends them over the wire, and the rule-based engine answers them with
 * arithmetic. That is what makes the §4.4 comparison meaningful — it is not
 * two different problems being compared, it is two engines answering one
 * question set over one state.
 *
 * Shapes follow Jev's three primitives (choice / score / noul). Nothing here
 * can produce free text: Jev has no generation phase and cannot write a
 * sentence, so the schema does not have a slot for one.
 *
 * @typedef {{ type: "choice"; prompt: string; options: string[] }} ChoiceQuestion
 * @typedef {{ type: "score"; prompt: string; levels: string[] }} ScoreQuestion
 * @typedef {{ type: "noul"; prompt: string }} NoulQuestion
 * @typedef {ChoiceQuestion | ScoreQuestion | NoulQuestion} Question
 */

/** @type {readonly string[]} */
export const TIER_OPTIONS = ["high", "mid", "low", "static-fallback"];

/** @type {readonly string[]} */
export const RISK_LEVELS = ["very unlikely", "unlikely", "possible", "likely", "very likely"];

/** @type {readonly string[]} */
export const OUTCOME_OPTIONS = ["pass", "degraded-but-acceptable", "fail", "inconclusive"];

/** @type {readonly string[]} */
export const ROOT_CAUSE_OPTIONS = [
  "network",
  "memory",
  "permission-denied",
  "codec-unsupported",
  "render-stall",
  "manifest-bug",
  "unknown",
];

/** @type {readonly string[]} */
export const SEVERITY_LEVELS = ["not blocking", "minor", "moderate", "major", "hard block"];

/**
 * Integration point 1 — the live tier router (§4.1).
 * One batched call: Jev evaluates all three independently and in parallel.
 *
 * @param {{ firstFrameMs: number; timeToInteractiveMs: number; p95InteractionMs: number }} budgets
 * @returns {Record<string, Question>}
 */
export function tierQuestions(budgets) {
  const budgetLine =
    `Declared budgets: first frame <= ${budgets.firstFrameMs}ms, ` +
    `time-to-interactive <= ${budgets.timeToInteractiveMs}ms, ` +
    `p95 tap response <= ${budgets.p95InteractionMs}ms.`;
  return {
    tier: {
      type: "choice",
      prompt:
        "Which quality tier is safest to serve first, given this device/network " +
        `state and the experience's declared budgets? ${budgetLine} ` +
        '"high" needs WebGL2, "mid" needs WebGL1, "low" needs neither, ' +
        '"static-fallback" means serve a non-animated poster experience.',
      options: [...TIER_OPTIONS],
    },
    cameraPathSafe: {
      type: "noul",
      prompt:
        "Is the camera/WebXR interactive path safe to attempt without a high " +
        "risk of freeze, crash, or permission failure on this state?",
    },
    firstFrameRisk: {
      type: "score",
      prompt:
        "How likely is this state to blow the experience's first-frame budget " +
        `of ${budgets.firstFrameMs}ms on the 'mid' tier?`,
      levels: [...RISK_LEVELS],
    },
  };
}

/**
 * Integration point 2 — the trace judge (§4.2).
 * Six questions, one call, one forward pass.
 *
 * @param {import("../../types/atlas.js").ExperienceManifest} manifest
 * @returns {Record<string, Question>}
 */
export function traceQuestions(manifest) {
  const v = manifest.invariants.visual;
  const i = manifest.invariants.interaction;
  const b = manifest.invariants.business;
  return {
    outcome: {
      type: "choice",
      prompt:
        "Classify this session trace against its declared invariants and budgets. " +
        `Budgets: first frame <= ${manifest.budgets.firstFrameMs}ms, TTI <= ` +
        `${manifest.budgets.timeToInteractiveMs}ms, p95 interaction <= ` +
        `${manifest.budgets.p95InteractionMs}ms, dropped-frame ratio <= ` +
        `${manifest.budgets.maxDroppedFrameRatio}. Choose "inconclusive" only if ` +
        "the trace is too incomplete to judge.",
      options: [...OUTCOME_OPTIONS],
    },
    rootCause: {
      type: "choice",
      prompt: "If not a clean pass, what is the most likely root cause bucket?",
      options: [...ROOT_CAUSE_OPTIONS],
    },
    releaseBlocking: {
      type: "score",
      prompt: "How severe is this failure for release-gating purposes?",
      levels: [...SEVERITY_LEVELS],
    },
    visualInvariantHeld: {
      type: "noul",
      prompt: `Did the declared visual invariant hold throughout this trace? Invariant: ${v.description}`,
    },
    interactionInvariantHeld: {
      type: "noul",
      prompt: `Did the declared interaction invariant hold throughout this trace? Invariant: ${i.description}`,
    },
    businessInvariantHeld: {
      type: "noul",
      prompt:
        "Did the user reach the declared business-invariant end state " +
        `("${b.endState}") without broken state? Invariant: ${b.description}`,
    },
  };
}

/**
 * Softmax over raw scores, used by the rule-based engine to express its own
 * answers as a distribution so the two engines are directly comparable.
 *
 * @param {Record<string, number>} scores
 * @param {number} [temperature]
 * @returns {Record<string, number>}
 */
export function softmax(scores, temperature = 1) {
  const keys = Object.keys(scores);
  const max = Math.max(...keys.map((k) => scores[k]));
  const exps = keys.map((k) => Math.exp((scores[k] - max) / temperature));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  /** @type {Record<string, number>} */
  const out = {};
  keys.forEach((k, idx) => {
    out[k] = round6(exps[idx] / sum);
  });
  return out;
}

/**
 * Confidence of a categorical answer: the probability mass on the winner.
 * Derived locally from the distribution rather than trusting a vendor-supplied
 * scalar, so both engines' confidences mean the same thing.
 *
 * @param {Record<string, number>} dist
 * @returns {number}
 */
export function confidenceOfChoice(dist) {
  const values = Object.values(dist);
  if (!values.length) return 0;
  return round6(Math.max(...values));
}

/**
 * Confidence of a boolean (noul) answer: distance from maximum uncertainty.
 * @param {number} pTrue
 * @returns {number}
 */
export function confidenceOfNoul(pTrue) {
  return round6(Math.abs(pTrue - 0.5) * 2);
}

/**
 * Expected value of an ordinal score from its level distribution.
 * @param {Record<string, number>} dist
 * @param {readonly string[]} levels
 * @returns {number}
 */
export function expectedScore(dist, levels) {
  let sum = 0;
  let mass = 0;
  levels.forEach((level, idx) => {
    const p = dist[level] ?? 0;
    sum += p * idx;
    mass += p;
  });
  return mass > 0 ? round6(sum / mass) : 0;
}

/** @param {number} n */
export function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
