/**
 * The Atlas score — one number, and the four numbers it came from.
 *
 * ## The number is never the artifact
 *
 * A single 0–100 figure is what gets remembered, screenshotted and argued
 * about, which makes it the most dangerous thing this repo produces. So the
 * rule here is the one the roadmap states plainly — *never just the number*.
 * Every report carries the four sub-scores, the weights that combined them, the
 * measured value and budget behind each, and the version of the policy that
 * produced all of it. A reader who disagrees with the 71 can find the exact
 * arithmetic that made it a 71 and dispute that instead, which is the only
 * form of disagreement worth having.
 *
 * ## Why the score is computed in code, not asked of the judge
 *
 * The trace judge (Jev or the rule engine) answers "what happened here", and
 * its answers are shown beside the score. They do not move it. If they did, a
 * model revision would silently reprice every historical score, and comparing
 * this week's 71 to last quarter's 78 would be meaningless — the exact failure
 * this project exists to argue against. The score is a pure function of
 * (trace, manifest, weights version); the same trace scores the same forever.
 *
 * What the judge is used for instead is **agreement**: when the code score says
 * 84 and the judge says `fail`, that disagreement is surfaced as a finding. One
 * of the two is wrong, and knowing which is wrong is worth more than either
 * number alone.
 *
 * ## Weighted means launder catastrophes, so there are caps
 *
 * The honest objection to any composite is that a high score on three
 * dimensions can bury a zero on the fourth. An experience that looks beautiful,
 * responds instantly, and never lets anyone finish checking out is not a 76.
 * So a small number of failures apply a **hard cap** to the total, applied
 * after the weighted sum and reported by name. Caps only ever lower the score.
 *
 * @typedef {import("../../types/atlas.js").Trace} Trace
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 * @typedef {import("../../types/atlas.js").TraceVerdict} TraceVerdict
 */

import { evaluateComfort } from "./comfort.js";
import { validateStateOrdering } from "../manifest/validate.js";
import { round4 } from "../trace/schema.js";

/**
 * Bumped on any change to weights, curve, or caps below. A score carries this,
 * so two scores can only be compared directly when their versions match — and
 * when they do not, the report says so instead of drawing a misleading trend.
 */
export const SCORE_POLICY_VERSION = 1;

/**
 * How the four dimensions combine.
 *
 * Business is heaviest because the release gate already treats it as absolute
 * (rule 4: "a lower tier is an acceptable degradation; an unreachable checkout
 * is not"), and a score that disagreed with the gate about what matters would
 * just be a second opinion nobody asked for. Comfort is lightest not because it
 * matters least to a user — it may matter most — but because it is the newest
 * and least corroborated of the four, and a new measurement should earn its
 * weight before it gets to dominate.
 *
 * These are the numbers most likely to be argued about. They are arguable here,
 * in one place, versioned, and printed in every report.
 */
export const SCORE_WEIGHTS = Object.freeze({
  business: 0.35,
  visual: 0.25,
  interaction: 0.22,
  comfort: 0.18,
});

/**
 * Hard ceilings applied after the weighted sum. Each names a failure that no
 * amount of excellence elsewhere should be able to average away.
 */
export const SCORE_CAPS = Object.freeze({
  /** The user could not finish. Everything else is decoration. */
  businessFlowBroken: 40,
  /** The first thing the user saw was nothing. */
  blankFirstFrame: 35,
  /** The state machine did something it declares impossible. */
  illegalStateTransition: 45,
  /** Told "no" to XR, the app had nothing to fall back to. */
  noXrFallback: 55,
});

/**
 * Score awarded at exactly the budget. Not 1.0: sitting precisely on a limit is
 * a pass, not an achievement, and leaving headroom above it gives the number
 * somewhere to go when an app is genuinely comfortable rather than merely legal.
 */
const SCORE_AT_BUDGET = 0.8;

/** Decay constant past the budget; ~0.29 at 2× budget, ~0.11 at 3×. */
const OVER_BUDGET_DECAY = 1;

/**
 * @typedef {object} SubScore
 * @property {string} id
 * @property {boolean} applicable
 * @property {number | null} score  0..1, null exactly when inapplicable
 * @property {number} weight        the weight actually used, after renormalising
 * @property {string} basis
 * @property {Array<{ name: string; measured: number | null; budget: number | null; ratio: number | null; score: number | null; note?: string }>} components
 */

/**
 * @typedef {object} AtlasScore
 * @property {"atlas.score"} kind
 * @property {number} policyVersion
 * @property {number | null} score           0-100, null when nothing was measurable
 * @property {string} label
 * @property {Record<string, number>} declaredWeights
 * @property {{ business: SubScore; visual: SubScore; interaction: SubScore; comfort: SubScore }} dimensions
 * @property {string[]} excluded             dimensions dropped for want of evidence
 * @property {Array<{ id: string; ceiling: number; reason: string }>} capsApplied
 * @property {number | null} uncappedScore
 * @property {{ judgeOutcome: string | null; agrees: boolean | null; note: string } | null} agreement
 * @property {import("./comfort.js").ComfortReport} comfort
 */

/**
 * @param {Trace} trace
 * @param {ExperienceManifest} manifest
 * @param {{ verdict?: TraceVerdict | null }} [opts]
 * @returns {AtlasScore}
 */
export function scoreTrace(trace, manifest, opts = {}) {
  const comfortReport = evaluateComfort(trace, manifest);

  const dimensions = {
    business: businessScore(trace, manifest),
    visual: visualScore(trace, manifest),
    interaction: interactionScore(trace, manifest),
    comfort: comfortScore(comfortReport),
  };

  /* ── weighted mean over the dimensions that had evidence ────────────────── */
  const applicable = Object.entries(dimensions).filter(([, d]) => d.applicable);
  const excluded = Object.entries(dimensions).filter(([, d]) => !d.applicable).map(([k]) => k);

  const declaredMass = applicable.reduce(
    (sum, [key]) => sum + SCORE_WEIGHTS[/** @type {keyof typeof SCORE_WEIGHTS} */ (key)],
    0,
  );

  let uncapped = null;
  if (declaredMass > 0) {
    let acc = 0;
    for (const [key, d] of applicable) {
      // Renormalised so the surviving dimensions still sum to 1. A run that
      // could not measure comfort is scored out of what it *did* measure,
      // rather than being docked 18 points for the harness's blind spot.
      const weight = SCORE_WEIGHTS[/** @type {keyof typeof SCORE_WEIGHTS} */ (key)] / declaredMass;
      d.weight = round4(weight);
      acc += weight * /** @type {number} */ (d.score);
    }
    uncapped = acc * 100;
  }
  for (const key of excluded) {
    dimensions[/** @type {keyof typeof dimensions} */ (key)].weight = 0;
  }

  /* ── caps ───────────────────────────────────────────────────────────────── */
  const capsApplied = collectCaps(trace, manifest, comfortReport);
  const ceiling = capsApplied.reduce((min, c) => Math.min(min, c.ceiling), 100);
  const score = uncapped === null ? null : Math.min(uncapped, ceiling);

  return {
    kind: "atlas.score",
    policyVersion: SCORE_POLICY_VERSION,
    score: score === null ? null : Math.round(score),
    label: labelFor(score),
    declaredWeights: { ...SCORE_WEIGHTS },
    dimensions,
    excluded,
    capsApplied,
    uncappedScore: uncapped === null ? null : Math.round(uncapped),
    agreement: agreementWith(opts.verdict ?? null, score),
    comfort: comfortReport,
  };
}

/* ── the four dimensions ─────────────────────────────────────────────────── */

/**
 * Did the user get through. Near-binary by nature, with one graded component:
 * reaching the end state by a longer route than declared is worse than the
 * declared route and much better than not arriving.
 *
 * @param {Trace} trace
 * @param {ExperienceManifest} manifest
 * @returns {SubScore}
 */
function businessScore(trace, manifest) {
  const b = manifest.invariants.business;
  const m = trace.metrics;
  /** @type {SubScore["components"]} */
  const components = [];

  if (!m.reachedEndState) {
    components.push({
      name: "reachedEndState",
      measured: 0,
      budget: 1,
      ratio: null,
      score: 0,
      note: `"${b.endState}" was never entered`,
    });
    return {
      id: "business",
      applicable: true,
      score: 0,
      weight: SCORE_WEIGHTS.business,
      basis: `the session never reached "${b.endState}" — the flow did not complete`,
      components,
    };
  }

  components.push({ name: "reachedEndState", measured: 1, budget: 1, ratio: null, score: 1 });

  const steps = m.stepsToEndState;
  let stepScore = 1;
  if (steps !== null) {
    const ratio = steps / b.maxStepsToEndState;
    stepScore = gradeRatio(ratio);
    components.push({
      name: "stepsToEndState",
      measured: steps,
      budget: b.maxStepsToEndState,
      ratio: round4(ratio),
      score: round4(stepScore),
    });
  }

  const score = round4(0.75 + 0.25 * stepScore);
  return {
    id: "business",
    applicable: true,
    score,
    weight: SCORE_WEIGHTS.business,
    basis:
      steps === null
        ? `reached "${b.endState}"; step count was not recorded`
        : `reached "${b.endState}" in ${steps} step(s) against a declared maximum of ${b.maxStepsToEndState}`,
    components,
  };
}

/**
 * Was there anything to look at, and did it stay there.
 *
 * Reads the same checkpoint measurements the rule engine reads
 * (`src/decision/rule-based.js`), deliberately: two different definitions of
 * "the visual invariant held" living in two files is how a report starts
 * contradicting itself.
 *
 * @param {Trace} trace
 * @param {ExperienceManifest} manifest
 * @returns {SubScore}
 */
function visualScore(trace, manifest) {
  const v = manifest.invariants.visual;
  /** @type {SubScore["components"]} */
  const components = [];
  const parts = [];

  const nonBlank = trace.metrics.firstFrameNonBlank;
  if (nonBlank !== null) {
    components.push({
      name: "firstFrameNonBlank",
      measured: nonBlank ? 1 : 0,
      budget: 1,
      ratio: null,
      score: nonBlank ? 1 : 0,
    });
    parts.push(nonBlank ? 1 : 0);
  }

  const coverages = trace.checkpoints
    .map((c) => c.focalCoverage)
    .filter(/** @returns {x is number} */ (x) => typeof x === "number");
  if (coverages.length) {
    const min = Math.min(...coverages);
    // Higher is better, so the ratio inverts: budget ÷ measured.
    const ratio = min > 0 ? v.minFocalCoverage / min : Infinity;
    const s = gradeRatio(ratio);
    components.push({
      name: "minFocalCoverage",
      measured: round4(min),
      budget: v.minFocalCoverage,
      ratio: Number.isFinite(ratio) ? round4(ratio) : null,
      score: round4(s),
      note: "fraction of the frame carrying the focal subject, at its worst checkpoint",
    });
    parts.push(s);
  }

  const drifts = trace.checkpoints
    .map((c) => c.alphaEdgeDrift)
    .filter(/** @returns {x is number} */ (x) => typeof x === "number");
  if (drifts.length) {
    const max = Math.max(...drifts);
    const ratio = v.maxAlphaEdgeDrift > 0 ? max / v.maxAlphaEdgeDrift : 0;
    const s = gradeRatio(ratio);
    components.push({
      name: "maxAlphaEdgeDrift",
      measured: round4(max),
      budget: v.maxAlphaEdgeDrift,
      ratio: round4(ratio),
      score: round4(s),
      note: "edge-energy change between consecutive checkpoints, at its worst",
    });
    parts.push(s);
  }

  if (!parts.length) {
    return {
      id: "visual",
      applicable: false,
      score: null,
      weight: 0,
      basis: "no checkpoint screenshots were decoded and no first-frame measurement was taken",
      components,
    };
  }

  // Minimum, not mean. A frame that is blank at one checkpoint and perfect at
  // three others is a broken experience, and averaging would report it as a
  // good one. The visual invariant is a claim about every checkpoint.
  const score = Math.min(...parts);
  return {
    id: "visual",
    applicable: true,
    score: round4(score),
    weight: SCORE_WEIGHTS.visual,
    basis: `worst of ${parts.length} visual measurement(s): ${describeWorst(components)}`,
    components,
  };
}

/**
 * Did it obey its own state machine, and did it keep up.
 *
 * @param {Trace} trace
 * @param {ExperienceManifest} manifest
 * @returns {SubScore}
 */
function interactionScore(trace, manifest) {
  const i = manifest.invariants.interaction;
  const b = manifest.budgets;
  const m = trace.metrics;
  /** @type {SubScore["components"]} */
  const components = [];
  const parts = [];

  const ordering = validateStateOrdering(trace.states, manifest);
  components.push({
    name: "stateOrdering",
    measured: ordering.ok ? 1 : 0,
    budget: 1,
    ratio: null,
    score: ordering.ok ? 1 : 0,
    note: ordering.ok
      ? undefined
      : `illegal transition ${ordering.firstIllegal?.from} -> ${ordering.firstIllegal?.to} ` +
        `at index ${ordering.firstIllegal?.index}`,
  });
  parts.push(ordering.ok ? 1 : 0);

  const p95Limit = Math.min(b.p95InteractionMs, i.p95TapResponseMs);
  if (m.p95InteractionMs !== null && m.interactionCount > 0) {
    const ratio = m.p95InteractionMs / p95Limit;
    const s = gradeRatio(ratio);
    components.push({
      name: "p95InteractionMs",
      measured: round4(m.p95InteractionMs),
      budget: p95Limit,
      ratio: round4(ratio),
      score: round4(s),
      note: `across ${m.interactionCount} interaction(s)`,
    });
    parts.push(s);
  }

  if (m.droppedFrameRatio !== null) {
    const budget = i.maxDroppedFrameRatio;
    const ratio = budget > 0 ? m.droppedFrameRatio / budget : 0;
    const s = gradeRatio(ratio);
    components.push({
      name: "droppedFrameRatio",
      measured: round4(m.droppedFrameRatio),
      budget,
      ratio: round4(ratio),
      score: round4(s),
    });
    parts.push(s);
  }

  // Mean rather than minimum here: unlike the visual invariant, these are
  // genuinely independent qualities of the session, and a slightly-over-budget
  // p95 should not erase a clean state machine. The illegal-transition case,
  // which *should* dominate, is handled by a cap instead of by the mean.
  const score = parts.reduce((a, x) => a + x, 0) / parts.length;
  return {
    id: "interaction",
    applicable: true,
    score: round4(score),
    weight: SCORE_WEIGHTS.interaction,
    basis: ordering.ok
      ? `state ordering legal; ${components.length - 1} timing measurement(s) averaged`
      : `illegal state transition observed — see the cap`,
    components,
  };
}

/**
 * Comfort, graded from the ratios `src/gate/comfort.js` already computed.
 *
 * @param {import("./comfort.js").ComfortReport} report
 * @returns {SubScore}
 */
function comfortScore(report) {
  /** @type {SubScore["components"]} */
  const components = [];
  const parts = [];

  for (const dim of Object.values(report.dimensions)) {
    if (!dim.applicable) {
      components.push({
        name: dim.id,
        measured: null,
        budget: null,
        ratio: null,
        score: null,
        note: dim.basis,
      });
      continue;
    }
    // A binary dimension (XR fallback) has no ratio and scores 0 or 1; a graded
    // one is put through the same curve as every other budget in this file.
    const s = dim.ratio === null ? (dim.held ? 1 : 0) : gradeRatio(dim.ratio);
    components.push({
      name: dim.id,
      measured: null,
      budget: null,
      ratio: dim.ratio,
      score: round4(s),
      note: dim.basis,
    });
    parts.push(s);
  }

  if (!parts.length) {
    return {
      id: "comfort",
      applicable: false,
      score: null,
      weight: 0,
      basis: "no comfort dimension had enough evidence to assess",
      components,
    };
  }

  const score = parts.reduce((a, x) => a + x, 0) / parts.length;
  return {
    id: "comfort",
    applicable: true,
    score: round4(score),
    weight: SCORE_WEIGHTS.comfort,
    basis: `${report.heldCount}/${report.applicableCount} comfort invariant(s) held, graded by margin`,
    components,
  };
}

/* ── caps ────────────────────────────────────────────────────────────────── */

/**
 * @param {Trace} trace
 * @param {ExperienceManifest} manifest
 * @param {import("./comfort.js").ComfortReport} comfort
 * @returns {Array<{ id: string; ceiling: number; reason: string }>}
 */
function collectCaps(trace, manifest, comfort) {
  /** @type {Array<{ id: string; ceiling: number; reason: string }>} */
  const caps = [];
  const b = manifest.invariants.business;

  if (!trace.metrics.reachedEndState) {
    caps.push({
      id: "businessFlowBroken",
      ceiling: SCORE_CAPS.businessFlowBroken,
      reason:
        `the session never reached "${b.endState}". No quality elsewhere compensates for a ` +
        "flow a user cannot finish, so the total is capped rather than averaged.",
    });
  }
  if (trace.metrics.firstFrameNonBlank === false) {
    caps.push({
      id: "blankFirstFrame",
      ceiling: SCORE_CAPS.blankFirstFrame,
      reason: "the first frame rendered blank — every timing number for it is met and meaningless.",
    });
  }
  const ordering = validateStateOrdering(trace.states, manifest);
  if (!ordering.ok) {
    caps.push({
      id: "illegalStateTransition",
      ceiling: SCORE_CAPS.illegalStateTransition,
      reason:
        `the state machine performed ${ordering.firstIllegal?.from} -> ${ordering.firstIllegal?.to}, ` +
        "which the manifest declares impossible. Either the app or the manifest is wrong.",
    });
  }
  if (comfort.dimensions.xrFallback.held === false) {
    caps.push({
      id: "noXrFallback",
      ceiling: SCORE_CAPS.noXrFallback,
      reason:
        "XR was refused and the app did not recover to anything usable. This is the outcome for " +
        "every user who declines the permission prompt, which is not a small minority.",
    });
  }
  return caps;
}

/* ── the grading curve ───────────────────────────────────────────────────── */

/**
 * Turns "how far into the budget" into 0..1.
 *
 * `ratio` is measured ÷ budget, so 0 is perfect, 1 is exactly at the limit, 2
 * is double. Deliberately continuous and monotone with no step at the boundary:
 * a curve with a cliff at 1.0 rewards tuning a metric to 0.99 of budget over
 * genuinely improving it, and a score that can be gamed by a constant is not
 * measuring anything.
 *
 *   ratio 0    → 1.00    comfortably better than required
 *   ratio 0.5  → 0.90
 *   ratio 1    → 0.80    exactly at budget: a pass, not a triumph
 *   ratio 2    → 0.29
 *   ratio 3    → 0.11
 *   ratio 4    → 0.04
 *
 * @param {number} ratio
 * @returns {number}
 */
export function gradeRatio(ratio) {
  if (!Number.isFinite(ratio)) return 0;
  if (ratio <= 0) return 1;
  if (ratio <= 1) return 1 - (1 - SCORE_AT_BUDGET) * ratio;
  return Math.max(0, SCORE_AT_BUDGET * Math.exp(-OVER_BUDGET_DECAY * (ratio - 1)));
}

/* ── presentation ────────────────────────────────────────────────────────── */

/** @param {number | null} score */
function labelFor(score) {
  if (score === null) return "not scored";
  if (score >= 90) return "comfortable everywhere measured";
  if (score >= 75) return "solid, with margin to lose";
  if (score >= 60) return "usable but visibly compromised";
  if (score >= 40) return "degraded — real users will notice";
  return "broken on this profile";
}

/** @param {SubScore["components"]} components */
function describeWorst(components) {
  const scored = components.filter((c) => typeof c.score === "number");
  if (!scored.length) return "nothing measured";
  const worst = scored.reduce((a, c) => (/** @type {number} */ (c.score) < /** @type {number} */ (a.score) ? c : a));
  return `${worst.name} scored ${worst.score}`;
}

/**
 * Whether the code-computed score and the judge's verdict tell the same story.
 *
 * This is the one place the model's answer is allowed near the score, and even
 * here it only annotates. A disagreement is not automatically the model being
 * wrong — a judge that calls `fail` on an 84 has usually noticed something the
 * four dimensions do not measure, and that is exactly the case worth reading.
 *
 * @param {TraceVerdict | null} verdict
 * @param {number | null} score
 */
function agreementWith(verdict, score) {
  if (!verdict || score === null) return null;
  const outcome = verdict.outcome.value;

  // Bands chosen to overlap the outcome labels rather than partition them:
  // "degraded-but-acceptable" legitimately spans a wide range of scores.
  /** @type {Record<string, [number, number]>} */
  const bands = {
    pass: [70, 100],
    "degraded-but-acceptable": [40, 90],
    fail: [0, 60],
    inconclusive: [0, 100],
  };
  const band = bands[outcome] ?? [0, 100];
  const agrees = score >= band[0] && score <= band[1];

  return {
    judgeOutcome: outcome,
    agrees,
    note: agrees
      ? `the judge called this "${outcome}", consistent with a score of ${Math.round(score)}.`
      : `the judge called this "${outcome}" while the measured score is ${Math.round(score)}. ` +
        `One of the two is missing something: either the judge is reading evidence the four ` +
        `dimensions do not capture, or it is wrong. Worth a human look before either is trusted.`,
  };
}
