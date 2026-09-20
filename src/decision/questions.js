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
 * ## Why every option carries its own `criteria` string
 *
 * TypeSafe's documented design rule is to decompose — ask several small,
 * independent questions rather than one fuzzy one — and to put the labelling
 * effort into per-option criteria rather than into a long preamble. The
 * criteria are the interface: writing them is the same discipline as writing
 * instructions for a human annotator, and it is the only knob there is. Jev is
 * closed-weight and hosted; there is no fine-tune, no adapter, no gradient
 * anywhere in this project. A vague criterion cannot be corrected later by
 * training, so it has to be right here.
 *
 * Two properties are worth preserving if these are ever edited:
 *
 *  - **Mutually exclusive.** Two options whose criteria overlap produce a split
 *    distribution, which the guard reads as low confidence and overrides — the
 *    model gets blamed for an ambiguity the schema created.
 *  - **Decidable from the state actually sent.** A criterion referring to
 *    something absent from the state object is unanswerable; the model can only
 *    guess, and a calibrated model guessing produces a confidently wrong answer
 *    far less often than an uncalibrated one, but still more often than a
 *    question that was answerable in the first place.
 *
 * @typedef {{ type: "choice"; instructions: string; criteria: Record<string, string> }} ChoiceQuestion
 * @typedef {{ type: "score"; instructions: string; levels: string[]; criteria: Record<string, string> }} ScoreQuestion
 * @typedef {{ type: "noul"; instructions: string; criteria: { true: string; false: string } }} NoulQuestion
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
 *
 * One batched call: Jev evaluates all three questions independently and in
 * parallel in a single forward pass, so asking three costs close to what asking
 * one costs. They are three questions rather than one ("what should we serve?")
 * precisely because they have different failure modes — a device can be fast
 * enough for the high tier while its camera path is still unsafe, and collapsing
 * those into one answer would hide that.
 *
 * @param {{ firstFrameMs: number; timeToInteractiveMs: number; p95InteractionMs: number }} budgets
 * @returns {Record<string, Question>}
 */
export function tierQuestions(budgets) {
  return {
    tier: {
      type: "choice",
      instructions:
        "Given this device and network capability snapshot, which quality tier is " +
        "safest to serve as the first render? Prefer the richest tier the device " +
        "can sustain, but treat exceeding the first-frame budget as worse than " +
        "serving a simpler tier. " +
        `Declared budgets: first frame <= ${budgets.firstFrameMs}ms, ` +
        `time-to-interactive <= ${budgets.timeToInteractiveMs}ms, ` +
        `p95 tap response <= ${budgets.p95InteractionMs}ms.`,
      criteria: {
        high:
          "WebGL2 is available, the GPU tier is high, there are at least 4 CPU " +
          "cores and at least 4GB of device memory, and the connection can deliver " +
          `roughly 1.3MB of assets inside the ${budgets.firstFrameMs}ms first-frame budget ` +
          "(effective connection type 4g with healthy downlink and low RTT).",
        mid:
          "WebGL is available at version 1 or 2 but the device or the network " +
          "cannot safely carry the high tier: a mid GPU tier, 2-4 cores, 2-4GB of " +
          "memory, or a 3g-class connection where the high tier's asset payload " +
          "would not arrive in time.",
        low:
          "Rendering is possible but constrained: no usable WebGL, or a weak GPU " +
          "tier, or fewer than 2 cores, or under 2GB of memory, or a slow-2g/2g " +
          "connection. A small animated experience is still expected to run.",
        "static-fallback":
          "Interactive rendering should not be attempted at all: WebGL is absent " +
          "AND the device is severely constrained, or the user has requested " +
          "reduced motion, or observed frame times are already far beyond the " +
          "interaction budget. Serve a non-animated poster instead.",
      },
    },
    cameraPathSafe: {
      type: "noul",
      instructions:
        "Is the camera / WebXR interactive path safe to attempt on this state, " +
        "without a high risk of freeze, crash, or permission failure?",
      criteria: {
        true:
          "Camera permission is already granted, the device has enough memory and " +
          "compute to composite a camera feed under the render layer (roughly 4GB " +
          "and 4 cores or better), and WebGL is available to draw that composite.",
        false:
          "Camera permission is denied, unavailable, or still at prompt; or the " +
          "device lacks the memory, cores or WebGL support to composite a live " +
          "camera feed without stalling the main thread.",
      },
    },
    firstFrameRisk: {
      type: "score",
      instructions:
        "How likely is this device/network state to exceed the experience's " +
        `first-frame budget of ${budgets.firstFrameMs}ms if the 'mid' tier were served? ` +
        "Judge the combination of asset transfer time on this connection and " +
        "decode/render time on this hardware.",
      levels: [...RISK_LEVELS],
      criteria: {
        "very unlikely":
          "Fast connection and capable hardware; the mid tier's assets arrive and " +
          "render with substantial headroom against the budget.",
        unlikely: "Comfortably inside the budget, with modest but real headroom.",
        possible:
          "Roughly at the budget; plausible either way depending on cache state " +
          "and how the connection behaves during the load.",
        likely:
          "Constrained connection or hardware; the budget is expected to be " +
          "exceeded, though not catastrophically.",
        "very likely":
          "Severely constrained (slow-2g/2g, very high RTT, minimal memory or " +
          "cores); the budget is expected to be exceeded by a wide margin.",
      },
    },
  };
}

/**
 * Integration point 2 — the trace judge (§4.2).
 *
 * Six questions, one call, one forward pass. The three invariant questions are
 * deliberately separate nouls rather than one "did it work" question: the
 * release gate weights them differently, and a session can hold its visual and
 * interaction invariants while failing the business one, which is precisely the
 * case worth catching.
 *
 * @param {import("../../types/atlas.js").ExperienceManifest} manifest
 * @returns {Record<string, Question>}
 */
export function traceQuestions(manifest) {
  const v = manifest.invariants.visual;
  const i = manifest.invariants.interaction;
  const b = manifest.invariants.business;
  const bud = manifest.budgets;
  return {
    outcome: {
      type: "choice",
      instructions:
        "Classify this captured session trace against the experience's declared " +
        "invariants and budgets. " +
        `Budgets: first frame <= ${bud.firstFrameMs}ms, time-to-interactive <= ` +
        `${bud.timeToInteractiveMs}ms, p95 interaction <= ${bud.p95InteractionMs}ms, ` +
        `dropped-frame ratio <= ${bud.maxDroppedFrameRatio}, transfer <= ` +
        `${bud.maxTransferBytes} bytes, JS heap <= ${bud.maxJsHeapMB}MB.`,
      criteria: {
        pass:
          "Every declared budget was met, the session reached the business end " +
          `state ("${b.endState}"), no critical asset failed, and no visual or ` +
          "interaction invariant was breached.",
        "degraded-but-acceptable":
          "The session reached the business end state and stayed usable, but a " +
          "non-critical budget was missed — for example a lower tier was served " +
          "than ideal, a non-critical asset failed, or a timing budget was " +
          "exceeded by a modest margin without breaking the flow.",
        fail:
          "A hard failure: the business end state was never reached, a critical " +
          "asset failed, the first frame was blank, an illegal state transition " +
          "occurred, or a budget was exceeded by a margin that makes the " +
          "experience unusable.",
        inconclusive:
          "The trace is too incomplete to judge — it is truncated, missing its " +
          "first-frame or interaction events, or the harness itself errored " +
          "before the session finished. Choose this only when the evidence is " +
          "genuinely absent, not when it is merely mixed.",
      },
    },
    rootCause: {
      type: "choice",
      instructions:
        "What is the most likely root-cause bucket for this session's problems? " +
        "If the session was a clean pass, choose the bucket that best describes " +
        "the largest remaining risk, and expect low confidence.",
      criteria: {
        network:
          "Slow or lossy transfer dominates: asset loads timed out or failed with " +
          "network errors, transfer bytes arrived far slower than the budget " +
          "assumed, or the effective connection type is the binding constraint.",
        memory:
          "Memory pressure dominates: JS heap approached or exceeded the declared " +
          "ceiling, or the device's reported memory is too small for the tier served.",
        "permission-denied":
          "A required permission was refused — most commonly camera — forcing a " +
          "path change or blocking the intended experience.",
        "codec-unsupported":
          "A required codec or capability (WebCodecs, a texture format, a video " +
          "format) was unavailable, so an asset could not be decoded.",
        "render-stall":
          "The main thread or GPU stalled: high dropped-frame ratio, p95 " +
          "interaction latency far above budget, or a long gap between frames, " +
          "with no network or memory explanation.",
        "manifest-bug":
          "The experience's own configuration is at fault: a tier declaring " +
          "requirements it does not need, an asset URL that does not resolve, an " +
          "illegal state transition the state machine itself permits, or budgets " +
          "no tier could ever satisfy.",
        unknown:
          "The evidence does not clearly implicate any single bucket above, or " +
          "several are equally supported.",
      },
    },
    releaseBlocking: {
      type: "score",
      instructions:
        "How severe is this session for release-gating purposes? Judge the impact " +
        "on a real user encountering this, not the difficulty of fixing it.",
      levels: [...SEVERITY_LEVELS],
      criteria: {
        "not blocking":
          "No user-visible problem. Ship it.",
        minor:
          "A small degradation a user might not notice — a slightly missed timing " +
          "budget, or a non-critical asset absent without visible effect.",
        moderate:
          "A noticeable degradation that still leaves the experience usable and " +
          "the business flow completable: visible stutter, a slow first frame, or " +
          "a lower tier than the device deserved.",
        major:
          "The experience is substantially broken for this profile — the flow is " +
          "completable only with difficulty, or the rendering is badly wrong — but " +
          "some users on this profile could still get through.",
        "hard block":
          "The experience is unusable on this profile: the business end state is " +
          `unreachable ("${b.endState}" never entered), the first frame is blank, ` +
          "or a critical asset failure prevents rendering entirely.",
      },
    },
    visualInvariantHeld: {
      type: "noul",
      instructions: `Did the declared visual invariant hold throughout this trace? Invariant: ${v.description}`,
      criteria: {
        true:
          `The first frame was non-blank, focal coverage stayed at or above ${v.minFocalCoverage} ` +
          `at every checkpoint, and alpha-edge drift between checkpoints stayed at or below ${v.maxAlphaEdgeDrift}.`,
        false:
          "The first frame was blank, or focal coverage fell below the declared " +
          "minimum at any checkpoint, or alpha-edge drift exceeded the declared " +
          "maximum between checkpoints.",
      },
    },
    interactionInvariantHeld: {
      type: "noul",
      instructions: `Did the declared interaction invariant hold throughout this trace? Invariant: ${i.description}`,
      criteria: {
        true:
          `Every state transition was legal, p95 tap response stayed at or below ${i.p95TapResponseMs}ms, ` +
          `and the dropped-frame ratio stayed at or below ${i.maxDroppedFrameRatio}.`,
        false:
          "An illegal state transition occurred, or p95 tap response exceeded the " +
          "declared limit, or the dropped-frame ratio exceeded the declared maximum.",
      },
    },
    businessInvariantHeld: {
      type: "noul",
      instructions:
        `Did the user reach the declared business end state ("${b.endState}") ` +
        `without broken state? Invariant: ${b.description}`,
      criteria: {
        true:
          `The state sequence contains "${b.endState}", reached in no more than ` +
          `${b.maxStepsToEndState} steps from the interactive state, with no error state in between.`,
        false:
          `The state sequence never reaches "${b.endState}", or reaches it only ` +
          "after more steps than declared, or passes through an error state on the way.",
      },
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

/**
 * Structural check that a question set is well-formed, used by the test suite.
 *
 * It cannot check that criteria are *good* — that is a judgement call — but it
 * can check the mechanical properties that silently degrade answer quality: an
 * option with no criterion, a criterion for an option that does not exist, a
 * score whose levels and criteria disagree, and empty text.
 *
 * @param {Record<string, Question>} questions
 * @returns {string[]} problems, empty when well-formed
 */
export function validateQuestions(questions) {
  /** @type {string[]} */
  const problems = [];
  for (const [id, q] of Object.entries(questions)) {
    if (!q.instructions || !q.instructions.trim()) {
      problems.push(`${id}: empty instructions`);
    }
    if (q.type === "noul") {
      for (const key of ["true", "false"]) {
        if (!(/** @type {Record<string, string>} */ (q.criteria)[key] ?? "").trim()) {
          problems.push(`${id}: noul is missing a "${key}" criterion`);
        }
      }
      continue;
    }

    const expected = q.type === "score" ? q.levels : Object.keys(q.criteria);
    if (q.type === "score") {
      if (q.levels.length < 2 || q.levels.length > 10) {
        problems.push(`${id}: score must declare 2-10 levels, found ${q.levels.length}`);
      }
    } else if (expected.length < 2 || expected.length > 255) {
      problems.push(`${id}: choice must declare 2-255 options, found ${expected.length}`);
    }

    for (const option of expected) {
      if (!(q.criteria[option] ?? "").trim()) problems.push(`${id}: option "${option}" has no criterion`);
    }
    for (const option of Object.keys(q.criteria)) {
      if (!expected.includes(option)) problems.push(`${id}: criterion "${option}" is not a declared option`);
    }
  }
  return problems;
}
