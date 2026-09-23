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
 * @typedef {{ type: "score"; instructions: string; levels: string[]; criteria: string[] }} ScoreQuestion
 * @typedef {{ type: "noul"; instructions: string; criteria: { true: string; false: string } }} NoulQuestion
 * @typedef {ChoiceQuestion | ScoreQuestion | NoulQuestion} Question
 *
 * Wire note (verified live Sept 2026): a score's `criteria` is an ORDERED ARRAY
 * of level descriptions, index-aligned with `levels` — the API rejects an
 * object there with a 422 (`score.criteria: Input should be a valid list`).
 * `levels` itself carries the short level names the rest of Atlas reasons
 * about; the deployment tolerates and ignores that extra field, so it stays
 * for local use (report rendering, `expectedScore`, fixture readability).
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
 * How a real person's body would report this session. Ordered worst-last, like
 * every other Score scale here.
 *
 * Deliberately visceral rather than technical. The whole point of handing this
 * to a model is that "p95 frame time 46ms over a sustained window" is a fact
 * the code already knows and a reader cannot feel; mapping that fact onto how
 * unpleasant it is to be inside is a judgement, and judgements are what Jev is
 * for. The measured numbers go in the state, never in the question — the model
 * is never asked to compute a percentile, only to interpret one.
 */
export const COMFORT_LEVELS = [
  "comfortable",
  "slightly off",
  "uncomfortable",
  "queasy",
  "unusable",
];

/** Question key for the i-th open incident in a fan-out. */
export const incidentQuestionKey = (/** @type {number} */ i) => `matchesIncident${i}`;

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
      // Index-aligned with `levels`: criteria[0] describes levels[0]. The
      // budget number lives in the criterion text, not just `instructions`,
      // so a per-level description cannot drift from the contract.
      criteria: [
        "Fast connection and capable hardware; the mid tier's assets arrive and " +
          "render with substantial headroom against the budget.",
        "Comfortably inside the budget, with modest but real headroom.",
        "Roughly at the budget; plausible either way depending on cache state " +
          "and how the connection behaves during the load.",
        "Constrained connection or hardware; the budget is expected to be " +
          "exceeded, though not catastrophically.",
        "Severely constrained (slow-2g/2g, very high RTT, minimal memory or " +
          "cores); the budget is expected to be exceeded by a wide margin.",
      ],
    },
  };
}

/**
 * Integration point 2 — the trace judge (§4.2).
 *
 * Eight fixed questions plus one per open incident, all in one call and one
 * forward pass. The three invariant questions are deliberately separate nouls
 * rather than one "did it work" question: the release gate weights them
 * differently, and a session can hold its visual and interaction invariants
 * while failing the business one, which is precisely the case worth catching.
 *
 * ## Why the fan-out is nearly free, and where it is not
 *
 * A batched System One call evaluates every question independently in a single
 * parallel pass, so fourteen questions cost roughly one question's *inference*.
 * What they do cost is input tokens: each criterion string is text on the wire,
 * billed once. That is why the incident set is capped (`OPEN_INCIDENT_CAP`)
 * rather than unbounded, and why the criteria below are written tightly — a
 * paragraph where a sentence would do is a recurring bill.
 *
 * ## The division of labour, restated because it is easy to erode
 *
 * Nothing here asks the model to count, average, or compare a number to a
 * budget. `comfortRisk` is handed a p95 that `src/gate/comfort.js` already
 * computed and asked what it *feels* like; `accessibleFallback` is handed a
 * state sequence and asked whether a person without a camera got anywhere. Both
 * are judgements over evidence. The moment a question here starts with "how
 * many" it has become the wrong tool, and the answer belongs in code.
 *
 * @param {import("../../types/atlas.js").ExperienceManifest} manifest
 * @param {ReadonlyArray<{ id: string; title: string; signature: string; notLike: string }>} [incidents]
 *   Open incidents from `src/gate/incidents.js`, already capped and ordered by
 *   the caller. Defaults to none, so every existing caller keeps the six-question
 *   set it was written against.
 * @returns {Record<string, Question>}
 */
export function traceQuestions(manifest, incidents = []) {
  const v = manifest.invariants.visual;
  const i = manifest.invariants.interaction;
  const b = manifest.invariants.business;
  const bud = manifest.budgets;

  /** @type {Record<string, Question>} */
  const incidentQuestions = {};
  incidents.forEach((inc, idx) => {
    incidentQuestions[incidentQuestionKey(idx)] = {
      type: "noul",
      instructions:
        `Does this session show the same failure as a previously recorded ` +
        `incident: "${inc.title}"? Judge the shape of the failure, not an exact ` +
        `match of numbers — the same bug rarely reproduces with identical ` +
        `measurements. If the session shows no failure at all, this is false.`,
      criteria: {
        true: inc.signature,
        false: inc.notLike,
      },
    };
  });

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
      // Index-aligned with `levels` (see the wire note at the top of this file).
      criteria: [
        "No user-visible problem. Ship it.",
        "A small degradation a user might not notice — a slightly missed timing " +
          "budget, or a non-critical asset absent without visible effect.",
        "A noticeable degradation that still leaves the experience usable and " +
          "the business flow completable: visible stutter, a slow first frame, or " +
          "a lower tier than the device deserved.",
        "The experience is substantially broken for this profile — the flow is " +
          "completable only with difficulty, or the rendering is badly wrong — but " +
          "some users on this profile could still get through.",
        "The experience is unusable on this profile: the business end state is " +
          `unreachable ("${b.endState}" never entered), the first frame is blank, ` +
          "or a critical asset failure prevents rendering entirely.",
      ],
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

    /*
     * Slice 2 additions. Both are about how the session *felt*, which is the
     * half of the report a stakeholder actually reads and the half no assertion
     * in `release-gate.js` can produce.
     */

    comfortRisk: {
      type: "score",
      instructions:
        "The measurements are already in the state: worst sustained-window p95 " +
        "frame time, the frame-rate floor it is judged against, input-to-frame " +
        "latency, and whether the experience was head-tracked or flat-screen. Do " +
        "not recompute them. Judge what a person would report after two minutes " +
        "inside this session. Weigh sustained stutter far more heavily than " +
        "isolated hitches — a single dropped frame is invisible, five seconds of " +
        "irregular pacing is not — and weigh any of it much more heavily when " +
        "the session was head-tracked, because a flat screen that stutters is " +
        "annoying and a headset that stutters makes people ill. If the trace " +
        "carries no frame-time evidence at all, stay near the middle and expect " +
        "the low confidence to be read as the absence of evidence it is.",
      levels: [...COMFORT_LEVELS],
      // Index-aligned with `levels` (see the wire note at the top of this file).
      criteria: [
        "Motion is smooth and input is answered immediately. Nothing about the " +
          "pacing draws attention to itself.",
        "Occasional hitches an attentive user would notice and a casual one would " +
          "not. No sustained roughness; nobody would stop using it over this.",
        "Visibly rough: sustained stretches of irregular pacing, or input that " +
          "lags noticeably behind the finger. Usable, but the experience is " +
          "degraded in a way every user would feel.",
        "Physically unpleasant over a short session — sustained pacing well " +
          "below the declared floor, or badly laggy input, on content that moves. " +
          "A susceptible user would feel it in their stomach.",
        "Cannot reasonably be used: the frame rate collapses for long stretches, " +
          "or input is effectively unanswered. A user would close the tab rather " +
          "than endure it.",
      ],
    },

    accessibleFallback: {
      type: "noul",
      instructions:
        "Consider a visitor who cannot or will not use the immersive path — no " +
        "camera permission, no XR hardware, no controllers, or a refusal at the " +
        "prompt. On the evidence in this trace, did that visitor still get a " +
        "working experience? Judge what the session actually did after the " +
        "immersive path was unavailable, not what the app might have intended.",
      criteria: {
        true:
          "Either no immersive path was needed, or the immersive path was " +
          "unavailable and the session carried on anyway: it kept rendering, " +
          `answered input, and reached "${b.endState}" on a 2D, static or DOM ` +
          "path without entering an error state. A simpler experience that works " +
          "is a pass here.",
        false:
          "The immersive path was unavailable and the session did not recover: " +
          `it entered an error state, stopped rendering, stalled short of ` +
          `"${b.endState}", or left nothing on screen a visitor could act on. ` +
          "Treating the refusal as fatal is the failure this question exists for.",
      },
    },

    ...incidentQuestions,
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

    if (q.type === "score") {
      if (q.levels.length < 2 || q.levels.length > 10) {
        problems.push(`${id}: score must declare 2-10 levels, found ${q.levels.length}`);
      }
      // The wire format takes an ordered array, index-aligned with `levels`.
      if (!Array.isArray(q.criteria)) {
        problems.push(`${id}: score criteria must be an array of level descriptions (the API 422s an object)`);
        continue;
      }
      if (q.criteria.length !== q.levels.length) {
        problems.push(`${id}: score has ${q.levels.length} levels but ${q.criteria.length} criteria`);
      }
      q.levels.forEach((level, i) => {
        if (!(q.criteria[i] ?? "").trim()) problems.push(`${id}: level "${level}" has no criterion`);
      });
      continue;
    }

    const options = Object.keys(q.criteria);
    if (options.length < 2 || options.length > 255) {
      problems.push(`${id}: choice must declare 2-255 options, found ${options.length}`);
    }

    for (const option of options) {
      if (!(q.criteria[option] ?? "").trim()) problems.push(`${id}: option "${option}" has no criterion`);
    }
  }
  return problems;
}
