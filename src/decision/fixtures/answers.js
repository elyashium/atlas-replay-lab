/**
 * Hand-authored Jev answers, keyed by human-readable label.
 *
 * ── ILLUSTRATIVE. NOT CAPTURED FROM A LIVE JEV DEPLOYMENT. ──────────────────
 * Every probability in this file was written by me. None of it came off the
 * wire. It exists so the Jev code path can be exercised end to end — transport,
 * adapters, distribution normalisation, confidence derivation, guard
 * thresholding — without an API key, and so the test suite can assert on that
 * path deterministically.
 *
 * ## Why these deliberately disagree with the rule engine
 *
 * The obvious way to write fixtures is to run the rule engine and copy its
 * answers. That would make `atlas compare` report 100% agreement in fixture
 * mode, and that number would be an artifact of me copying one column into the
 * other — a measurement of nothing, presented as a headline.
 *
 * So the disagreements below are on purpose, and each is a case I actually
 * think is arguable:
 *
 *  - `mid-android-3g` — model says "mid", rules say "low". The contested
 *    network-versus-device call from states.js.
 *  - `packet-loss-4g` — the mirror image: the model reads the healthy headline
 *    downlink and says "mid" while the deterministic engine penalises the
 *    600ms RTT and says "low".
 *  - `stalling-midsession` — model is genuinely split, confidence lands under
 *    the guard's floor, and the guard overrides it. This is the fixture that
 *    proves the guard is load-bearing rather than decorative.
 *  - `fail-memory-pressure` — model is *more permissive* than the rules, and
 *    the guard's fail-closed severity check pulls it back to "fail". A verdict
 *    engine that could only be overridden in the cautious direction would be
 *    worthless.
 *
 * Fixture mode's agreement rate is therefore ~75%, not 100%, and it still means
 * nothing about real Jev. The comparison report labels it accordingly.
 */

/**
 * @typedef {{ choice: string; probabilities: Record<string, number> }} ChoiceAnswer
 * @typedef {{ noul: number }} NoulAnswer
 * @typedef {{ score: number; probabilities: Record<string, number> }} ScoreAnswer
 */

/**
 * Tier-router answers, keyed by `SYNTHETIC_STATES[].id`.
 * @type {Record<string, { tier: ChoiceAnswer; cameraPathSafe: NoulAnswer; firstFrameRisk: ScoreAnswer }>}
 */
export const TIER_ANSWERS = {
  "desktop-wifi-strong": {
    tier: { choice: "high", probabilities: { high: 0.93, mid: 0.055, low: 0.01, "static-fallback": 0.005 } },
    cameraPathSafe: { noul: 0.95 },
    firstFrameRisk: {
      score: 0.32,
      probabilities: { "very unlikely": 0.74, unlikely: 0.21, possible: 0.04, likely: 0.008, "very likely": 0.002 },
    },
  },

  "flagship-android-4g": {
    tier: { choice: "high", probabilities: { high: 0.81, mid: 0.16, low: 0.025, "static-fallback": 0.005 } },
    cameraPathSafe: { noul: 0.9 },
    firstFrameRisk: {
      score: 0.71,
      probabilities: { "very unlikely": 0.42, unlikely: 0.46, possible: 0.1, likely: 0.015, "very likely": 0.005 },
    },
  },

  "mid-android-4g": {
    tier: { choice: "mid", probabilities: { high: 0.14, mid: 0.76, low: 0.09, "static-fallback": 0.01 } },
    cameraPathSafe: { noul: 0.78 },
    firstFrameRisk: {
      score: 1.24,
      probabilities: { "very unlikely": 0.14, unlikely: 0.54, possible: 0.28, likely: 0.035, "very likely": 0.005 },
    },
  },

  // Deliberate divergence: the model keeps the mid tier where the cost model
  // drops to low. Both are defensible; states.js marks this contested.
  "mid-android-3g": {
    tier: { choice: "mid", probabilities: { high: 0.02, mid: 0.58, low: 0.38, "static-fallback": 0.02 } },
    cameraPathSafe: { noul: 0.62 },
    firstFrameRisk: {
      score: 2.84,
      probabilities: { "very unlikely": 0.01, unlikely: 0.05, possible: 0.26, likely: 0.49, "very likely": 0.19 },
    },
  },

  "low-cpu-3g": {
    tier: { choice: "low", probabilities: { high: 0.005, mid: 0.075, low: 0.86, "static-fallback": 0.06 } },
    cameraPathSafe: { noul: 0.11 },
    firstFrameRisk: {
      score: 3.54,
      probabilities: { "very unlikely": 0.005, unlikely: 0.015, possible: 0.08, likely: 0.34, "very likely": 0.56 },
    },
  },

  // Deliberate divergence, mirror image of mid-android-3g: here the model is
  // the naive one. It reads the healthy 6Mbps headline downlink and says
  // "mid"; the deterministic engine penalises the 600ms RTT and says "low".
  // Either reading is defensible on its own evidence — that is what makes the
  // case contested — but the fixture exists to disagree with the rules, and it
  // must actually do so.
  "packet-loss-4g": {
    tier: { choice: "mid", probabilities: { high: 0.04, mid: 0.58, low: 0.35, "static-fallback": 0.03 } },
    cameraPathSafe: { noul: 0.58 },
    firstFrameRisk: {
      score: 2.66,
      probabilities: { "very unlikely": 0.01, unlikely: 0.07, possible: 0.31, likely: 0.49, "very likely": 0.12 },
    },
  },

  "camera-denied": {
    tier: { choice: "high", probabilities: { high: 0.86, mid: 0.11, low: 0.025, "static-fallback": 0.005 } },
    cameraPathSafe: { noul: 0.02 },
    firstFrameRisk: {
      score: 0.58,
      probabilities: { "very unlikely": 0.5, unlikely: 0.42, possible: 0.07, likely: 0.008, "very likely": 0.002 },
    },
  },

  "no-webgl": {
    tier: { choice: "low", probabilities: { high: 0.002, mid: 0.018, low: 0.9, "static-fallback": 0.08 } },
    cameraPathSafe: { noul: 0.02 },
    firstFrameRisk: {
      score: 2.1,
      probabilities: { "very unlikely": 0.03, unlikely: 0.16, possible: 0.52, likely: 0.25, "very likely": 0.04 },
    },
  },

  "reduced-motion": {
    tier: { choice: "static-fallback", probabilities: { high: 0.04, mid: 0.05, low: 0.19, "static-fallback": 0.72 } },
    cameraPathSafe: { noul: 0.71 },
    firstFrameRisk: {
      score: 0.44,
      probabilities: { "very unlikely": 0.64, unlikely: 0.29, possible: 0.06, likely: 0.008, "very likely": 0.002 },
    },
  },

  "slow-2g-minimal": {
    tier: { choice: "static-fallback", probabilities: { high: 0.002, mid: 0.008, low: 0.13, "static-fallback": 0.86 } },
    cameraPathSafe: { noul: 0.01 },
    firstFrameRisk: {
      score: 3.88,
      probabilities: { "very unlikely": 0.002, unlikely: 0.008, possible: 0.03, likely: 0.14, "very likely": 0.82 },
    },
  },

  // Missing signal expressed as genuine uncertainty rather than a confident
  // guess. The winning option still clears the guard's floor, but only just.
  "unknown-everything": {
    tier: { choice: "low", probabilities: { high: 0.04, mid: 0.24, low: 0.61, "static-fallback": 0.11 } },
    cameraPathSafe: { noul: 0.34 },
    firstFrameRisk: {
      score: 2.18,
      probabilities: { "very unlikely": 0.04, unlikely: 0.16, possible: 0.45, likely: 0.29, "very likely": 0.06 },
    },
  },

  // Deliberate low confidence: static signals say "high", observed frame time
  // says "low", and the model splits. 0.47 is under DEFAULT_TIER_CONFIDENCE_FLOOR
  // (0.55), so the guard overrides and the rule engine's answer is served.
  "stalling-midsession": {
    tier: { choice: "low", probabilities: { high: 0.41, mid: 0.1, low: 0.47, "static-fallback": 0.02 } },
    cameraPathSafe: { noul: 0.46 },
    firstFrameRisk: {
      score: 1.96,
      probabilities: { "very unlikely": 0.12, unlikely: 0.22, possible: 0.31, likely: 0.26, "very likely": 0.09 },
    },
  },
};

/**
 * Trace-judge answers, keyed by `TRACE_SCENARIOS[].id`.
 * @type {Record<string, {
 *   outcome: ChoiceAnswer;
 *   rootCause: ChoiceAnswer;
 *   releaseBlocking: ScoreAnswer;
 *   visualInvariantHeld: NoulAnswer;
 *   interactionInvariantHeld: NoulAnswer;
 *   businessInvariantHeld: NoulAnswer;
 *   comfortRisk: ScoreAnswer;
 *   accessibleFallback: NoulAnswer;
 * }>}
 */
export const TRACE_ANSWERS = {
  "pass-high-desktop": {
    outcome: {
      choice: "pass",
      probabilities: { pass: 0.94, "degraded-but-acceptable": 0.05, fail: 0.006, inconclusive: 0.004 },
    },
    // A clean pass has no root cause. The question still has to be answered, so
    // the mass spreads across "unknown" and the nearest standing risk — exactly
    // the low-confidence shape the question's own instructions predict.
    rootCause: {
      choice: "unknown",
      probabilities: {
        network: 0.11, memory: 0.07, "permission-denied": 0.03, "codec-unsupported": 0.02,
        "render-stall": 0.09, "manifest-bug": 0.02, unknown: 0.66,
      },
    },
    releaseBlocking: {
      score: 0.14,
      probabilities: { "not blocking": 0.88, minor: 0.1, moderate: 0.015, major: 0.004, "hard block": 0.001 },
    },
    visualInvariantHeld: { noul: 0.97 },
    interactionInvariantHeld: { noul: 0.96 },
    businessInvariantHeld: { noul: 0.99 },
    comfortRisk: {
      score: 0.13,
      probabilities: { comfortable: 0.9, "slightly off": 0.08, uncomfortable: 0.015, queasy: 0.004, unusable: 0.001 },
    },
    accessibleFallback: { noul: 0.95 },
  },

  "fail-baseline-low-cpu-3g": {
    outcome: {
      choice: "fail",
      probabilities: { pass: 0.002, "degraded-but-acceptable": 0.018, fail: 0.96, inconclusive: 0.02 },
    },
    rootCause: {
      choice: "network",
      probabilities: {
        network: 0.72, memory: 0.08, "permission-denied": 0.005, "codec-unsupported": 0.01,
        "render-stall": 0.15, "manifest-bug": 0.02, unknown: 0.015,
      },
    },
    releaseBlocking: {
      score: 3.83,
      probabilities: { "not blocking": 0.002, minor: 0.008, moderate: 0.03, major: 0.1, "hard block": 0.86 },
    },
    visualInvariantHeld: { noul: 0.02 },
    interactionInvariantHeld: { noul: 0.04 },
    businessInvariantHeld: { noul: 0.01 },
    comfortRisk: {
      score: 2.63,
      probabilities: { comfortable: 0.02, "slightly off": 0.08, uncomfortable: 0.3, queasy: 0.45, unusable: 0.15 },
    },
    accessibleFallback: { noul: 0.85 },
  },

  "pass-adaptive-low-cpu-3g": {
    outcome: {
      choice: "pass",
      probabilities: { pass: 0.84, "degraded-but-acceptable": 0.14, fail: 0.012, inconclusive: 0.008 },
    },
    rootCause: {
      choice: "unknown",
      probabilities: {
        network: 0.21, memory: 0.04, "permission-denied": 0.02, "codec-unsupported": 0.02,
        "render-stall": 0.09, "manifest-bug": 0.02, unknown: 0.6,
      },
    },
    releaseBlocking: {
      score: 0.38,
      probabilities: { "not blocking": 0.68, minor: 0.27, moderate: 0.04, major: 0.008, "hard block": 0.002 },
    },
    visualInvariantHeld: { noul: 0.93 },
    interactionInvariantHeld: { noul: 0.91 },
    businessInvariantHeld: { noul: 0.98 },
    comfortRisk: {
      score: 0.9,
      probabilities: { comfortable: 0.35, "slightly off": 0.45, uncomfortable: 0.16, queasy: 0.03, unusable: 0.01 },
    },
    accessibleFallback: { noul: 0.93 },
  },

  "degraded-packet-loss": {
    outcome: {
      choice: "degraded-but-acceptable",
      probabilities: { pass: 0.13, "degraded-but-acceptable": 0.78, fail: 0.07, inconclusive: 0.02 },
    },
    rootCause: {
      choice: "network",
      probabilities: {
        network: 0.79, memory: 0.02, "permission-denied": 0.005, "codec-unsupported": 0.005,
        "render-stall": 0.14, "manifest-bug": 0.01, unknown: 0.03,
      },
    },
    releaseBlocking: {
      score: 1.82,
      probabilities: { "not blocking": 0.06, minor: 0.29, moderate: 0.49, major: 0.14, "hard block": 0.02 },
    },
    visualInvariantHeld: { noul: 0.9 },
    interactionInvariantHeld: { noul: 0.72 },
    businessInvariantHeld: { noul: 0.97 },
    comfortRisk: {
      score: 1.78,
      probabilities: { comfortable: 0.08, "slightly off": 0.3, uncomfortable: 0.42, queasy: 0.16, unusable: 0.04 },
    },
    accessibleFallback: { noul: 0.88 },
  },

  "pass-camera-denied-fallback": {
    outcome: {
      choice: "pass",
      probabilities: { pass: 0.88, "degraded-but-acceptable": 0.1, fail: 0.014, inconclusive: 0.006 },
    },
    // Confidently permission-denied, and confidently not blocking. The two
    // answers are independent, which is the whole reason they are two questions.
    rootCause: {
      choice: "permission-denied",
      probabilities: {
        network: 0.02, memory: 0.01, "permission-denied": 0.87, "codec-unsupported": 0.01,
        "render-stall": 0.02, "manifest-bug": 0.01, unknown: 0.06,
      },
    },
    releaseBlocking: {
      score: 0.22,
      probabilities: { "not blocking": 0.81, minor: 0.16, moderate: 0.024, major: 0.005, "hard block": 0.001 },
    },
    visualInvariantHeld: { noul: 0.96 },
    interactionInvariantHeld: { noul: 0.95 },
    businessInvariantHeld: { noul: 0.98 },
    // The fallback success story: camera refused, 2D path smooth, nothing to
    // feel. Comfort confident and the fallback answer is the most certain in
    // this file — a model unsure here would be unsure everywhere.
    comfortRisk: {
      score: 0.23,
      probabilities: { comfortable: 0.82, "slightly off": 0.14, uncomfortable: 0.03, queasy: 0.008, unusable: 0.002 },
    },
    accessibleFallback: { noul: 0.97 },
  },

  "fail-manifest-bug-404": {
    outcome: {
      choice: "fail",
      probabilities: { pass: 0.002, "degraded-but-acceptable": 0.008, fail: 0.95, inconclusive: 0.04 },
    },
    rootCause: {
      choice: "manifest-bug",
      probabilities: {
        network: 0.16, memory: 0.005, "permission-denied": 0.005, "codec-unsupported": 0.02,
        "render-stall": 0.01, "manifest-bug": 0.78, unknown: 0.02,
      },
    },
    releaseBlocking: {
      score: 3.86,
      probabilities: { "not blocking": 0.002, minor: 0.008, moderate: 0.02, major: 0.09, "hard block": 0.88 },
    },
    visualInvariantHeld: { noul: 0.01 },
    interactionInvariantHeld: { noul: 0.03 },
    businessInvariantHeld: { noul: 0.005 },
    // Broken assets break every path including the fallback — the one scenario
    // where the fallback answer is confidently false.
    comfortRisk: {
      score: 3.6,
      probabilities: { comfortable: 0.005, "slightly off": 0.015, uncomfortable: 0.06, queasy: 0.22, unusable: 0.7 },
    },
    accessibleFallback: { noul: 0.1 },
  },

  "fail-render-stall": {
    outcome: {
      choice: "fail",
      probabilities: { pass: 0.005, "degraded-but-acceptable": 0.12, fail: 0.86, inconclusive: 0.015 },
    },
    // Genuinely split between render-stall and memory — a stalling frame loop
    // and a filling heap look similar from a trace. Confidence lands low enough
    // to be visible in the report without tripping the guard.
    rootCause: {
      choice: "render-stall",
      probabilities: {
        network: 0.03, memory: 0.26, "permission-denied": 0.005, "codec-unsupported": 0.005,
        "render-stall": 0.65, "manifest-bug": 0.02, unknown: 0.03,
      },
    },
    releaseBlocking: {
      score: 3.12,
      probabilities: { "not blocking": 0.003, minor: 0.017, moderate: 0.08, major: 0.66, "hard block": 0.24 },
    },
    visualInvariantHeld: { noul: 0.82 },
    interactionInvariantHeld: { noul: 0.03 },
    businessInvariantHeld: { noul: 0.02 },
    // A sustained stall is felt in the stomach before it is seen in the
    // metrics. The 2D path stalls too, so the fallback answer stays bearish.
    comfortRisk: {
      score: 2.82,
      probabilities: { comfortable: 0.01, "slightly off": 0.05, uncomfortable: 0.22, queasy: 0.55, unusable: 0.17 },
    },
    accessibleFallback: { noul: 0.42 },
  },

  // Deliberate divergence in the permissive direction: the model reads a
  // completed first frame and an interactive state and calls this survivable.
  // The rule engine sees an error terminal state and says fail. The guard's
  // fail-closed severity check overrides the model. This fixture exists to
  // prove that override fires.
  "fail-memory-pressure": {
    outcome: {
      choice: "degraded-but-acceptable",
      probabilities: { pass: 0.04, "degraded-but-acceptable": 0.56, fail: 0.38, inconclusive: 0.02 },
    },
    rootCause: {
      choice: "memory",
      probabilities: {
        network: 0.04, memory: 0.74, "permission-denied": 0.005, "codec-unsupported": 0.005,
        "render-stall": 0.18, "manifest-bug": 0.01, unknown: 0.02,
      },
    },
    releaseBlocking: {
      score: 2.74,
      probabilities: { "not blocking": 0.01, minor: 0.06, moderate: 0.31, major: 0.43, "hard block": 0.19 },
    },
    visualInvariantHeld: { noul: 0.78 },
    interactionInvariantHeld: { noul: 0.12 },
    businessInvariantHeld: { noul: 0.06 },
    comfortRisk: {
      score: 2.06,
      probabilities: { comfortable: 0.05, "slightly off": 0.2, uncomfortable: 0.45, queasy: 0.24, unusable: 0.06 },
    },
    accessibleFallback: { noul: 0.6 },
  },

  "fail-codec-unsupported": {
    outcome: {
      choice: "fail",
      probabilities: { pass: 0.002, "degraded-but-acceptable": 0.018, fail: 0.93, inconclusive: 0.05 },
    },
    rootCause: {
      choice: "codec-unsupported",
      probabilities: {
        network: 0.03, memory: 0.005, "permission-denied": 0.005, "codec-unsupported": 0.85,
        "render-stall": 0.01, "manifest-bug": 0.07, unknown: 0.03,
      },
    },
    releaseBlocking: {
      score: 3.79,
      probabilities: { "not blocking": 0.002, minor: 0.008, moderate: 0.03, major: 0.13, "hard block": 0.83 },
    },
    visualInvariantHeld: { noul: 0.01 },
    interactionInvariantHeld: { noul: 0.02 },
    businessInvariantHeld: { noul: 0.005 },
    comfortRisk: {
      score: 3.51,
      probabilities: { comfortable: 0.005, "slightly off": 0.02, uncomfortable: 0.08, queasy: 0.25, unusable: 0.645 },
    },
    accessibleFallback: { noul: 0.2 },
  },

  "inconclusive-truncated": {
    outcome: {
      choice: "inconclusive",
      probabilities: { pass: 0.01, "degraded-but-acceptable": 0.04, fail: 0.16, inconclusive: 0.79 },
    },
    rootCause: {
      choice: "unknown",
      probabilities: {
        network: 0.22, memory: 0.02, "permission-denied": 0.01, "codec-unsupported": 0.01,
        "render-stall": 0.04, "manifest-bug": 0.02, unknown: 0.68,
      },
    },
    // Low severity on purpose: a dead harness is not a product defect, and
    // scoring it as one would block releases for infrastructure flakiness.
    releaseBlocking: {
      score: 1.04,
      probabilities: { "not blocking": 0.22, minor: 0.55, moderate: 0.19, major: 0.03, "hard block": 0.01 },
    },
    visualInvariantHeld: { noul: 0.24 },
    interactionInvariantHeld: { noul: 0.21 },
    businessInvariantHeld: { noul: 0.05 },
    // No evidence either way: the distribution spreads wide and peaks low, and
    // the fallback answer sits at maximum uncertainty rather than inventing one.
    comfortRisk: {
      score: 1.7,
      probabilities: { comfortable: 0.2, "slightly off": 0.25, uncomfortable: 0.3, queasy: 0.15, unusable: 0.1 },
    },
    accessibleFallback: { noul: 0.5 },
  },
};

/**
 * Preflight answers, keyed by `PREFLIGHT_STATES[].id`.
 *
 * Deliberate divergence, documented so nobody "fixes" it: the rules say "mid"
 * for the canonical page (effective ratio 0.27 against 12MB) and the fixture
 * model says "high" at 0.62 — inside the guard's confidence band but richer
 * than deterministic, so the guarded preflight serves "mid" and records why.
 * That is the preflight equivalent of the `stalling-midsession` tier fixture:
 * proof the richness override is load-bearing.
 *
 * @type {Record<string, {
 *   tier: ChoiceAnswer;
 *   blowBudget: ScoreAnswer;
 *   transferFits: NoulAnswer;
 * }>}
 */
export const PREFLIGHT_ANSWERS = {
  "canonical-midweight": {
    tier: {
      choice: "high",
      probabilities: { high: 0.62, mid: 0.3, low: 0.07, "static-fallback": 0.01 },
    },
    blowBudget: {
      score: 0.35,
      probabilities: { "very unlikely": 0.7, unlikely: 0.24, possible: 0.05, likely: 0.008, "very likely": 0.002 },
    },
    transferFits: { noul: 0.97 },
  },
};
