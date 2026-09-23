/**
 * Comfort invariants — what the session *felt* like, computed in code.
 *
 * The three questions here are the ones a user answers with their body rather
 * than with a stopwatch: did the motion stay smooth enough not to make them
 * queasy, did the app survive being told "no" to XR, and did it answer their
 * finger. They are deliberately separate from the visual / interaction /
 * business invariants because they fail independently — an experience can hold
 * every declared invariant, complete its business flow, and still be unpleasant
 * to be inside.
 *
 * ## Why none of this asks a model
 *
 * Every number below is a percentile, a sum, or a threshold comparison. The
 * roadmap's rule is explicit — "Frame counts, p95s, and budget comparisons stay
 * in code; Jev gets semantic judgments + confidence" — and it is the right
 * split for a reason beyond taste: a model asked to compute a p95 over 300
 * samples will produce a plausible number, and a plausible number that is wrong
 * is worse here than no number, because the whole report is an argument that
 * these measurements can be trusted. What Jev is asked instead (Slice 2's
 * `comfortRisk`) is the semantic half — *given* these measured numbers, how bad
 * is this for a real person — which is a judgement, not arithmetic.
 *
 * ## The three-valued result, and why `null` is not `false`
 *
 * Each dimension reports `held: true | false | null`, where `null` means the
 * evidence to decide was absent. This matters more than it looks. An app that
 * never attempts XR has not *failed* the XR-fallback invariant, and scoring it
 * zero would punish every non-AR page; scoring it one would hand out a pass for
 * a capability never exercised. Both are lies in opposite directions, so the
 * dimension is excluded from the composite instead, and `src/gate/atlas-score.js`
 * renormalises over what was actually measured and says which dimensions it
 * dropped.
 *
 * @typedef {import("../../types/atlas.js").Trace} Trace
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 */

import { percentile, round4 } from "../trace/schema.js";

/**
 * Bumped whenever a threshold or a formula below changes. Written into every
 * report so that two reports produced months apart can be told apart by
 * something more reliable than their dates — a score that moved because the
 * policy moved is not a regression, and this is how a reader distinguishes the
 * two cases.
 */
export const COMFORT_POLICY_VERSION = 1;

/**
 * The window over which frame pacing has to hold, in milliseconds.
 *
 * Five seconds is chosen for what it excludes as much as for what it includes.
 * A single 250ms hitch — a texture upload, a GC pause — is unpleasant but not
 * sickening, and at 60fps it is one sample in roughly three hundred, far out in
 * the tail where the p95 below cannot see it. A *stretch* of bad frames is what
 * correlates with simulator sickness, and five seconds is long enough that only
 * a real stretch can fill one.
 */
export const COMFORT_WINDOW_MS = 5000;

/**
 * Sustained frames per second below which motion is treated as uncomfortable.
 *
 * 30fps is the floor for flat-screen content, and it is a floor rather than a
 * target. Seated VR comfort guidance from every headset vendor sits at 72–90Hz,
 * and nothing in this repo can assess that: Atlas's XR sessions run against its
 * own injected stub whose frames come from the page's `requestAnimationFrame`,
 * so a "90fps XR session" measured here would be a measurement of the browser's
 * rAF cadence and of nothing else. When the trace is both emulated and on the
 * camera-xr path, that limitation is stated in `note` rather than quietly
 * folded into a pass.
 */
export const SUSTAINED_FPS_FLOOR = 30;

/**
 * Percentile taken inside each window. The 95th percentile of frame *time* is
 * the 5th percentile of frame *rate* — the speed 95% of frames beat — which is
 * the "sustained fps floor" the roadmap asks for, expressed in the units the
 * trace actually records.
 */
const WINDOW_PERCENTILE = 0.95;

/**
 * Minimum samples before a window is believed at all. A "5 second window" made
 * of four 1.3-second frames is not a pacing measurement, it is a stalled tab,
 * and its p95 would read as a catastrophic but perfectly precise number.
 */
const MIN_WINDOW_SAMPLES = 20;

/**
 * @typedef {object} ComfortPolicy
 * @property {number} sustainedFpsFloor
 * @property {number} sustainedWindowMs
 * @property {boolean} requireUsableXrFallback
 * @property {number} p95InputToFrameMs
 * @property {"manifest" | "default"} source
 */

/**
 * Resolves the thresholds to grade against.
 *
 * A manifest may declare `invariants.comfort`; when it does not — every trace
 * captured before these invariants existed, and any hand-written manifest that
 * has not caught up — the module constants above apply and `source` says so.
 * This is what makes the block genuinely additive rather than a breaking change
 * wearing an additive costume: nothing that worked before stops working, and
 * the report never silently attributes a default to a customer who never
 * declared it.
 *
 * @param {ExperienceManifest} manifest
 * @returns {ComfortPolicy}
 */
export function comfortPolicy(manifest) {
  const declared = /** @type {any} */ (manifest.invariants).comfort;
  if (!declared) {
    return {
      sustainedFpsFloor: SUSTAINED_FPS_FLOOR,
      sustainedWindowMs: COMFORT_WINDOW_MS,
      requireUsableXrFallback: true,
      p95InputToFrameMs: manifest.invariants.interaction.p95TapResponseMs,
      source: "default",
    };
  }
  return {
    sustainedFpsFloor: numOr(declared.sustainedFpsFloor, SUSTAINED_FPS_FLOOR),
    sustainedWindowMs: numOr(declared.sustainedWindowMs, COMFORT_WINDOW_MS),
    requireUsableXrFallback: declared.requireUsableXrFallback !== false,
    p95InputToFrameMs: numOr(
      declared.p95InputToFrameMs,
      manifest.invariants.interaction.p95TapResponseMs,
    ),
    source: "manifest",
  };
}

/** @param {unknown} v @param {number} fallback */
function numOr(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * @typedef {object} ComfortDimension
 * @property {string} id
 * @property {boolean} applicable   was there evidence to decide this at all
 * @property {boolean | null} held  null exactly when `applicable` is false
 * @property {number | null} ratio  measured ÷ budget, so `held` ⟺ `ratio <= 1`;
 *   null when the dimension is inapplicable or genuinely binary. The Atlas
 *   score grades this rather than counting passes, because "8% over budget" and
 *   "400% over budget" are both `held: false` and are not the same problem.
 * @property {string} basis         one sentence, the arithmetic that decided it
 * @property {Record<string, unknown>} measured
 * @property {Record<string, unknown>} threshold
 * @property {string} [note]        a caveat a reader must not miss
 */

/**
 * @typedef {object} ComfortReport
 * @property {number} policyVersion
 * @property {ComfortPolicy} policy
 * @property {{ sustainedPacing: ComfortDimension; xrFallback: ComfortDimension; responsiveness: ComfortDimension }} dimensions
 * @property {number} applicableCount
 * @property {number} heldCount
 * @property {string[]} findings  plain-language problems, empty when all clear
 */

/**
 * @param {Trace} trace
 * @param {ExperienceManifest} manifest
 * @returns {ComfortReport}
 */
export function evaluateComfort(trace, manifest) {
  const policy = comfortPolicy(manifest);
  const dimensions = {
    sustainedPacing: sustainedPacing(trace, policy),
    xrFallback: xrFallback(trace, manifest, policy),
    responsiveness: responsiveness(trace, policy),
  };

  const all = Object.values(dimensions);
  /** @type {string[]} */
  const findings = [];
  for (const d of all) {
    if (d.held === false) findings.push(`${d.id}: ${d.basis}`);
  }

  return {
    policyVersion: COMFORT_POLICY_VERSION,
    policy,
    dimensions,
    applicableCount: all.filter((d) => d.applicable).length,
    heldCount: all.filter((d) => d.held === true).length,
    findings,
  };
}

/* ── 1. sustained frame pacing ───────────────────────────────────────────── */

/**
 * The worst five seconds of the session, not the average of all of them.
 *
 * Averaging is the failure mode this is written against: an app that runs at
 * 60fps for fifty seconds and at 8fps for the ten seconds the user is actually
 * interacting reports a fine mean and is horrible to use. The window that hurt
 * is the finding, so the worst window is what gets reported — along with where
 * it started, because "seconds 22–27" is something a developer can go and look
 * at and "p95 was 48ms" is not.
 *
 * @param {Trace} trace
 * @param {ComfortPolicy} policy
 * @returns {ComfortDimension}
 */
function sustainedPacing(trace, policy) {
  const id = "comfort.sustained-pacing";
  const frames = Array.isArray(trace.frameTimes) ? trace.frameTimes : [];
  const ceilingMs = 1000 / policy.sustainedFpsFloor;
  const threshold = {
    sustainedFpsFloor: policy.sustainedFpsFloor,
    frameTimeCeilingMs: round4(ceilingMs),
    windowMs: policy.sustainedWindowMs,
    percentile: WINDOW_PERCENTILE,
    source: policy.source,
  };

  const worst = worstWindow(frames, policy.sustainedWindowMs);
  if (!worst) {
    return {
      id,
      applicable: false,
      held: null,
      ratio: null,
      basis:
        `no ${policy.sustainedWindowMs / 1000}s window of continuous rendering was captured ` +
        `(${frames.length} frame sample(s), ${MIN_WINDOW_SAMPLES} minimum per window)`,
      measured: { frameSamples: frames.length, windows: 0 },
      threshold,
      note:
        "Frame pacing was not assessed. An app that never rendered continuously for " +
        "five seconds has not passed this invariant — there was nothing to pass.",
    };
  }

  const sustainedFps = 1000 / worst.p95;
  const held = worst.p95 <= ceilingMs;

  /** @type {ComfortDimension} */
  const dimension = {
    id,
    applicable: true,
    held,
    ratio: round4(worst.p95 / ceilingMs),
    basis: held
      ? `worst ${round4(worst.spanMs / 1000)}s window held a p95 frame time of ${round4(worst.p95)}ms ` +
        `(${round4(sustainedFps)}fps sustained), inside the ${policy.sustainedFpsFloor}fps floor`
      : `worst ${round4(worst.spanMs / 1000)}s window ran a p95 frame time of ${round4(worst.p95)}ms — ` +
        `${round4(sustainedFps)}fps sustained, under the ${policy.sustainedFpsFloor}fps comfort floor — ` +
        `starting around ${Math.round(worst.startMs)}ms into rendering`,
    measured: {
      frameSamples: frames.length,
      windows: worst.windows,
      worstWindowP95Ms: round4(worst.p95),
      worstWindowSustainedFps: round4(sustainedFps),
      worstWindowStartMs: Math.round(worst.startMs),
      worstWindowSpanMs: Math.round(worst.spanMs),
      worstWindowSamples: worst.samples,
      medianWindowP95Ms: round4(worst.medianWindowP95),
    },
    threshold,
  };

  // The one place a good-looking number here would be misleading, said out loud.
  if (trace.resource["atlas.emulated"] && trace.servedPath === "camera-xr") {
    dimension.note =
      "This session reached the camera-xr path under emulation, so its frames came from " +
      "the page's requestAnimationFrame through Atlas's injected XR stub, not from a real " +
      `XR compositor. The ${policy.sustainedFpsFloor}fps floor applied here is the flat-screen ` +
      "floor; headset comfort guidance (72-90Hz) is not assessable from this run and no " +
      "claim about it is made either way.";
  }
  return dimension;
}

/**
 * Slides a window over a series of frame *durations*.
 *
 * The series carries no timestamps — deliberately, since wall-clock in the
 * event stream is a privacy boundary this project does not cross — so a window
 * is a run of consecutive samples whose durations sum to at least `windowMs`.
 * That makes the window self-timing: five seconds of a stuttering app is fewer
 * samples than five seconds of a smooth one, which is exactly right, because
 * both really are five seconds of a person's life.
 *
 * @param {number[]} frames
 * @param {number} windowMs
 * @returns {{ p95: number; startMs: number; spanMs: number; samples: number; windows: number; medianWindowP95: number } | null}
 */
function worstWindow(frames, windowMs) {
  if (frames.length < MIN_WINDOW_SAMPLES) return null;

  /** p95 of every window, kept so the report can say whether the worst one was typical. */
  const windowP95s = [];
  let worst = null;

  let start = 0;
  let sum = 0;
  let elapsedBeforeStart = 0;

  for (let end = 0; end < frames.length; end++) {
    sum += frames[end];
    // Shrink from the left while the window would still be long enough without
    // its first sample, so each window is the *tightest* run covering windowMs
    // rather than everything since the start of the session.
    while (start < end && sum - frames[start] >= windowMs) {
      sum -= frames[start];
      elapsedBeforeStart += frames[start];
      start++;
    }
    if (sum < windowMs) continue;

    const samples = end - start + 1;
    if (samples < MIN_WINDOW_SAMPLES) continue;

    const slice = frames.slice(start, end + 1).sort((a, b) => a - b);
    const p95 = percentile(slice, WINDOW_PERCENTILE);
    if (p95 === null) continue;

    windowP95s.push(p95);
    if (!worst || p95 > worst.p95) {
      worst = { p95, startMs: elapsedBeforeStart, spanMs: sum, samples };
    }
  }

  if (!worst) return null;
  const sortedP95s = [...windowP95s].sort((a, b) => a - b);
  return {
    ...worst,
    windows: windowP95s.length,
    medianWindowP95: percentile(sortedP95s, 0.5) ?? worst.p95,
  };
}

/* ── 2. XR refusal has to leave something usable ─────────────────────────── */

/**
 * The invariant that matters most and is tested least.
 *
 * Refusing camera or XR permission is not an edge case — it is what a large
 * fraction of real users do, every time, on purpose. An experience whose
 * response to "no" is a blank page has not degraded, it has broken, and it has
 * broken for precisely the users most likely to be cautious about it.
 *
 * This is the one comfort dimension that is strictly structural: it reads the
 * state sequence, not the pixels, because "usable" here means the session still
 * went somewhere a person could act on. `xr-granted` runs and runs that never
 * touch XR are not applicable — see the header on why that is not a pass.
 *
 * @param {Trace} trace
 * @param {ExperienceManifest} manifest
 * @param {ComfortPolicy} policy
 * @returns {ComfortDimension}
 */
function xrFallback(trace, manifest, policy) {
  const id = "comfort.xr-refusal-fallback";
  const endState = manifest.invariants.business.endState;
  const events = trace.xrSessionEvents ?? [];
  const refusals = events.filter((e) => e.phase === "session-refused" || e.phase === "unavailable");
  const started = events.some((e) => e.phase === "session-start");
  const threshold = {
    mustReachState: endState,
    mustAvoidState: "error",
    required: policy.requireUsableXrFallback,
    source: policy.source,
  };

  // A manifest may switch this off — an experience with no XR entry point at all
  // has nothing to assert here. It is off by declaration, never by accident.
  if (!policy.requireUsableXrFallback) {
    return {
      id,
      applicable: false,
      held: null,
      ratio: null,
      basis: "the manifest declares no XR fallback requirement for this experience",
      measured: { xrAttempts: events.length, refusals: refusals.length, sessionStarted: started },
      threshold,
    };
  }

  if (!refusals.length) {
    return {
      id,
      applicable: false,
      held: null,
      ratio: null,
      basis: started
        ? "the XR session started, so the refusal path was never exercised"
        : "no XR or camera session was attempted, so there was no refusal to recover from",
      measured: { xrAttempts: events.length, refusals: 0, sessionStarted: started },
      threshold,
    };
  }

  const firstRefusal = refusals[0];
  const reachedEnd = trace.states.includes(endState);
  const enteredError = trace.states.includes("error");
  // A refusal followed by a real frame is the difference between "handled it"
  // and "stopped". Counted from the whole run rather than post-refusal only:
  // the event stream carries aggregate frame counts, not a per-interval series,
  // and inventing an interval split here would be arithmetic nobody measured.
  const rendered = trace.metrics.framesRendered;
  const held = reachedEnd && !enteredError;

  return {
    id,
    applicable: true,
    held,
    // Genuinely binary: a fallback either left something usable or it did not.
    // There is no "13% unusable", and inventing a ratio here to make the four
    // dimensions look uniform would be a shape imposed on the data.
    ratio: null,
    basis: held
      ? `XR was refused (${describe(firstRefusal)}) and the session still reached "${endState}" ` +
        `without entering an error state, having rendered ${rendered} frame(s)`
      : `XR was refused (${describe(firstRefusal)}) and the session ` +
        (enteredError
          ? "entered an error state afterwards"
          : `never reached "${endState}"`) +
        ` — a refused permission left the user with nothing usable`,
    measured: {
      xrAttempts: events.length,
      refusals: refusals.length,
      sessionStarted: started,
      firstRefusalAtMs: firstRefusal.tOffsetMs,
      firstRefusalReason: firstRefusal.error ?? null,
      reachedEndState: reachedEnd,
      enteredErrorState: enteredError,
      framesRendered: rendered,
      finalState: trace.states[trace.states.length - 1] ?? null,
    },
    threshold,
    note: trace.resource["atlas.emulated"]
      ? "The refusal itself was produced by Atlas's injected XR stub rejecting requestSession. " +
        "A rejected promise is a rejected promise — this exercises the app's real recovery path " +
        "— but no claim is made here about real-device permission UI."
      : undefined,
  };
}

/** @param {{ phase: string; mode: string; error: string | null }} e */
function describe(e) {
  return e.error ? `${e.mode}: ${e.error}` : `${e.mode}: ${e.phase}`;
}

/* ── 3. did it answer the finger ─────────────────────────────────────────── */

/**
 * Input responsiveness, against the manifest's declared tap budget.
 *
 * **What this number is, precisely.** The page records the interval between the
 * input event and the next `requestAnimationFrame` callback. That is the
 * app's own reaction time — event dispatch, handler, and the wait for the next
 * frame opportunity — and it is a **lower bound on input-to-photon**: paint,
 * composite and the display's own scanout all happen after the rAF callback and
 * are not in it. The real figure a user perceives is larger, by roughly a frame
 * plus the display pipeline.
 *
 * It is reported as a lower bound rather than dressed up as input-to-photon
 * because the gap is not small and the honest version is still useful: an app
 * that blows the budget on this measurement has definitely blown it on the real
 * one, since the real one is strictly larger.
 *
 * @param {Trace} trace
 * @param {ComfortPolicy} policy
 * @returns {ComfortDimension}
 */
function responsiveness(trace, policy) {
  const id = "comfort.input-responsiveness";
  const budgetMs = policy.p95InputToFrameMs;
  const p95 = trace.metrics.p95InteractionMs;
  const count = trace.metrics.interactionCount;
  const threshold = { p95BudgetMs: budgetMs, source: policy.source };
  const measurementNote =
    "Measured input-event to next animation-frame callback: a lower bound on true " +
    "input-to-photon, which additionally includes paint, composite and display scanout.";

  if (p95 === null || count === 0) {
    return {
      id,
      applicable: false,
      held: null,
      ratio: null,
      basis: "no input latency samples were recorded in this session",
      measured: { interactionCount: count, p95InteractionMs: null },
      threshold,
      note: measurementNote,
    };
  }

  const held = p95 <= budgetMs;
  return {
    id,
    applicable: true,
    held,
    ratio: budgetMs > 0 ? round4(p95 / budgetMs) : null,
    basis: held
      ? `p95 input response was ${round4(p95)}ms across ${count} interaction(s), inside the ${budgetMs}ms budget`
      : `p95 input response was ${round4(p95)}ms across ${count} interaction(s), over the ${budgetMs}ms budget ` +
        `by ${round4(p95 - budgetMs)}ms — and that is before paint and composite`,
    measured: {
      interactionCount: count,
      p50InteractionMs: trace.metrics.p50InteractionMs,
      p95InteractionMs: round4(p95),
      overBudgetByMs: held ? 0 : round4(p95 - budgetMs),
    },
    threshold,
    note: measurementNote,
  };
}
