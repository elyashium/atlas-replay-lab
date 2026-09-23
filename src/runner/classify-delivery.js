/**
 * What did this app actually deliver?
 *
 * For Orbital, `servedTier` and `servedPath` are *decisions*: the router picked
 * them and the experience obeyed. For a `--url` run there is no router in the
 * loop — the visitor's app served whatever it was going to serve — so these two
 * fields have to mean something different, and this module is where that
 * difference lives. Here they are **measurements**: the weight class the app
 * shipped, and the shape it ended up in.
 *
 * ## Why weight class comes from bytes alone
 *
 * Payload size is the one signal that is the same on every device. A 12MB build
 * is 12MB on a flagship and 12MB on a throttled 3G Android; the *consequences*
 * differ wildly, but the delivery does not. Frame time is the opposite: on a
 * `low-cpu-3g` profile a featherweight app can post a 40ms p95, so classifying
 * weight from frame cost would report "this app is heavy" when the true finding
 * is "this device is slow". Keeping the two apart is what lets the report say
 * the sentence that is actually worth saying — *this app delivered its heavy
 * class to a weak device* — instead of collapsing both halves into one number.
 *
 * Render cost is still measured, and returned as `evidence.renderLoad`. It is
 * labelled device-dependent because it is, and the gate and the judge are the
 * ones that get to combine it with the weight class.
 *
 * ## Why a heavy payload that renders nothing is not `static-fallback`
 *
 * `static-fallback` is a legitimate *choice* — a poster instead of a scene. An
 * app that downloads twelve megabytes and then shows a blank page has not made
 * that choice; it has failed. Reporting it as a static fallback would dress a
 * failure up as graceful degradation, so tier stays with what was shipped and
 * path records what was reached. When those two disagree, the disagreement is
 * the finding, and it is emitted as a note.
 *
 * Nothing here asks a model anything. Byte counts, percentiles and threshold
 * comparisons are arithmetic, and arithmetic stays in code
 * (`docs/showcase-roadmap.md`: "Frame counts, p95s, and budget comparisons stay
 * in code; Jev gets semantic judgments + confidence").
 *
 * @typedef {import("../../types/atlas.js").Trace} Trace
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 * @typedef {import("../../types/atlas.js").ServeTier} ServeTier
 * @typedef {import("../../types/atlas.js").PathId} PathId
 */

import { percentile, round4 } from "../trace/schema.js";

/**
 * A canvas smaller than this fraction of the viewport is decoration — a logo, a
 * sparkline, a progress ring — not the experience. Set low on purpose: some
 * apps letterbox heavily on a tall phone viewport.
 */
const LIVE_CANVAS_VIEWPORT_RATIO = 0.05;

/**
 * Below this many rendered frames there was no animation loop worth the name,
 * whatever the DOM says. Two seconds of a 30fps loop.
 */
const LIVE_FRAME_FLOOR = 60;

/**
 * Fraction of the lightest declared envelope below which a payload is a poster
 * rather than a light build. Expressed as a fraction so the number moves with
 * the manifest instead of being pinned to today's megabytes.
 */
const STATIC_ENVELOPE_FRACTION = 0.25;

/**
 * @typedef {object} DeliveryClassification
 * @property {ServeTier} tier     observed delivered weight class
 * @property {PathId} path        observed shape the session ended up in
 * @property {string} tierBasis   one sentence, the arithmetic that decided `tier`
 * @property {string} pathBasis   one sentence, the evidence that decided `path`
 * @property {DeliveryEvidence} evidence
 * @property {string[]} notes     findings worth putting in front of a human
 */

/**
 * @typedef {object} DeliveryEvidence
 * @property {number} transferBytes
 * @property {number} requestCount
 * @property {Array<{ tier: string; envelopeBytes: number }>} envelopes
 * @property {Array<{ from: string; to: string; boundaryBytes: number }>} boundaries
 * @property {string[]} xrPhases
 * @property {boolean} xrSessionStarted
 * @property {boolean} cameraAcquired
 * @property {number | null} visibleCanvasCount
 * @property {number | null} canvasViewportRatio
 * @property {boolean} liveCanvas
 * @property {DeliveryRenderLoad} renderLoad
 */

/**
 * Device-dependent, by construction. Kept in its own object so no caller can
 * mistake it for part of the weight classification.
 *
 * @typedef {object} DeliveryRenderLoad
 * @property {"device-dependent"} kind
 * @property {number} framesRendered
 * @property {number | null} p50FrameTimeMs
 * @property {number | null} p95FrameTimeMs
 * @property {number | null} droppedFrameRatio
 * @property {number} frameSamples
 */

/**
 * @param {Trace} trace  assembled and metric-derived
 * @param {ExperienceManifest} manifest  the generic manifest the run was recorded against
 * @param {Record<string, unknown> | null} [surface]  the probe's final DOM surface read
 * @returns {DeliveryClassification}
 */
export function classifyDelivery(trace, manifest, surface) {
  /** @type {string[]} */
  const notes = [];

  const bytes = trace.metrics.transferBytes;
  const requestCount = trace.events.filter((e) => e.kind === "asset").length;

  const envelopes = envelopesOf(manifest);
  const boundaries = boundariesOf(envelopes);

  const frames = Array.isArray(trace.frameTimes) ? trace.frameTimes : [];
  const sortedFrames = [...frames].sort((a, b) => a - b);
  /** @type {DeliveryRenderLoad} */
  const renderLoad = {
    kind: "device-dependent",
    framesRendered: trace.metrics.framesRendered,
    p50FrameTimeMs: percentile(sortedFrames, 0.5),
    p95FrameTimeMs: percentile(sortedFrames, 0.95),
    droppedFrameRatio: trace.metrics.droppedFrameRatio,
    frameSamples: frames.length,
  };

  const xrPhases = (trace.xrSessionEvents ?? []).map((e) => e.phase);
  const xrSessionStarted = xrPhases.includes("session-start");
  const cameraAcquired = trace.events.some((e) => e.name === "camera-stream-acquired");

  const visibleCanvasCount = numOrNull(surface?.visibleCanvasCount);
  const canvasViewportRatio = numOrNull(surface?.canvasViewportRatio);
  const liveCanvas =
    (visibleCanvasCount ?? 0) > 0 &&
    (canvasViewportRatio ?? 0) >= LIVE_CANVAS_VIEWPORT_RATIO &&
    trace.metrics.framesRendered >= LIVE_FRAME_FLOOR;

  /* ── weight class ─────────────────────────────────────────────────────── */

  const lightest = envelopes[envelopes.length - 1];
  const staticCeiling = Math.round(lightest.envelopeBytes * STATIC_ENVELOPE_FRACTION);

  /** @type {ServeTier} */
  let tier;
  let tierBasis;

  if (bytes <= 0) {
    // Not "the app shipped nothing" — far more often it means cross-origin
    // assets arrived without Timing-Allow-Origin, so their sizes are zero to
    // resource timing. Saying "static-fallback" here would be a measurement
    // artefact dressed as a finding.
    tier = "static-fallback";
    tierBasis = "no transfer bytes were attributable; weight class could not be measured";
    notes.push(
      "transfer total was 0 bytes: either nothing loaded, or the app's assets are " +
        "cross-origin without Timing-Allow-Origin, which makes their sizes invisible " +
        "to resource timing. Weight class here is a floor, not a measurement.",
    );
  } else if (bytes < staticCeiling && !liveCanvas) {
    tier = "static-fallback";
    tierBasis =
      `${fmtBytes(bytes)} with no live canvas, under the ${fmtBytes(staticCeiling)} ` +
      `poster ceiling (${STATIC_ENVELOPE_FRACTION}x the lightest declared envelope)`;
  } else {
    const picked = nearestEnvelope(bytes, envelopes);
    tier = /** @type {ServeTier} */ (picked.tier);
    tierBasis =
      `${fmtBytes(bytes)} across ${requestCount} request(s), nearest the ` +
      `'${picked.tier}' envelope of ${fmtBytes(picked.envelopeBytes)}`;
  }

  /* ── delivered shape ──────────────────────────────────────────────────── */

  /** @type {PathId} */
  let path;
  let pathBasis;

  if (xrSessionStarted || cameraAcquired) {
    path = "camera-xr";
    pathBasis = xrSessionStarted
      ? "an XR session started (observed session-start)"
      : "the app acquired a camera stream";
  } else if (liveCanvas) {
    path = "interactive-2d";
    pathBasis =
      `a live canvas covering ${pct(canvasViewportRatio)} of the viewport rendered ` +
      `${trace.metrics.framesRendered} frames, with no XR session`;
  } else {
    path = "static-safe";
    pathBasis = liveCanvasFailureBasis(visibleCanvasCount, canvasViewportRatio, trace.metrics.framesRendered);
  }

  /* ── the disagreements worth surfacing ────────────────────────────────── */

  if (path === "static-safe" && (tier === "high" || tier === "mid")) {
    notes.push(
      `delivered a '${tier}' weight class (${fmtBytes(bytes)}) but ended on the ` +
        "static-safe path: the payload arrived and nothing of consequence was " +
        "rendered. This is recorded as a heavy delivery that failed, not as a " +
        "graceful static fallback.",
    );
  }
  if (xrPhases.includes("session-refused") && !xrSessionStarted) {
    notes.push(
      `XR entry was refused (${refusalReasons(trace).join("; ") || "no reason reported"}); ` +
        `the app fell back to the '${path}' path.`,
    );
  }
  if (xrSessionStarted && trace.resource["atlas.emulated"]) {
    notes.push(
      "the XR session ran against Atlas's injected navigator.xr stub, not a headset " +
        "or an AR-capable handset. It proves the app's session lifecycle and refusal " +
        "handling run; it proves nothing about tracking quality or real pose latency.",
    );
  }

  return {
    tier,
    path,
    tierBasis,
    pathBasis,
    evidence: {
      transferBytes: bytes,
      requestCount,
      envelopes,
      boundaries,
      xrPhases,
      xrSessionStarted,
      cameraAcquired,
      visibleCanvasCount,
      canvasViewportRatio,
      liveCanvas,
      renderLoad,
    },
    notes,
  };
}

/**
 * Writes the classification onto the trace and appends its notes.
 *
 * Deliberately does not re-hash: `servedTier`, `servedPath` and `notes` are all
 * outside `normalizeTrace`'s field set, so nothing here can move
 * `determinismHash`. The caller re-derives metrics when it has other reasons to
 * (`finalizeTrace`), not because of this.
 *
 * @param {Trace} trace
 * @param {ExperienceManifest} manifest
 * @param {Record<string, unknown> | null} [surface]
 * @returns {DeliveryClassification}
 */
export function applyDeliveryClassification(trace, manifest, surface) {
  const result = classifyDelivery(trace, manifest, surface);
  trace.servedTier = result.tier;
  trace.servedPath = result.path;
  trace.notes.push(`observed delivery: tier '${result.tier}' — ${result.tierBasis}`);
  trace.notes.push(`observed path: '${result.path}' — ${result.pathBasis}`);
  for (const n of result.notes) trace.notes.push(n);
  return result;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/**
 * Each tier's total declared payload, heaviest first. Read off the manifest so
 * that editing the envelopes — which is gate policy, and which Slice 2 makes
 * customer-editable — moves the classification with it.
 *
 * @param {ExperienceManifest} manifest
 */
function envelopesOf(manifest) {
  return manifest.tiers
    .map((t) => ({
      tier: t.id,
      envelopeBytes: t.assets.reduce((sum, a) => sum + a.approxBytes, 0),
    }))
    .filter((e) => e.envelopeBytes > 0)
    .sort((a, b) => b.envelopeBytes - a.envelopeBytes);
}

/**
 * Class boundaries sit at the *geometric* mean of two adjacent envelopes, not
 * the arithmetic one. Payload sizes are log-distributed — the interesting
 * question is "is this twice the light build or half the heavy one", not "how
 * many megabytes from each" — and an arithmetic midpoint between 1.5MB and 12MB
 * lands at 6.75MB, which would file most real WebAR builds as light.
 *
 * @param {Array<{ tier: string; envelopeBytes: number }>} envelopes
 */
function boundariesOf(envelopes) {
  /** @type {Array<{ from: string; to: string; boundaryBytes: number }>} */
  const out = [];
  for (let i = 0; i < envelopes.length - 1; i++) {
    out.push({
      from: envelopes[i].tier,
      to: envelopes[i + 1].tier,
      boundaryBytes: Math.round(Math.sqrt(envelopes[i].envelopeBytes * envelopes[i + 1].envelopeBytes)),
    });
  }
  return out;
}

/**
 * @param {number} bytes
 * @param {Array<{ tier: string; envelopeBytes: number }>} envelopes
 */
function nearestEnvelope(bytes, envelopes) {
  let best = envelopes[0];
  let bestDistance = Infinity;
  for (const e of envelopes) {
    const distance = Math.abs(Math.log(bytes) - Math.log(e.envelopeBytes));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = e;
    }
  }
  return best;
}

/**
 * @param {Trace} trace
 * @returns {string[]}
 */
function refusalReasons(trace) {
  return (trace.xrSessionEvents ?? [])
    .filter((e) => e.phase === "session-refused" && e.error)
    .map((e) => `${e.mode}: ${e.error}`);
}

/**
 * Says *which* of the three live-canvas conditions failed. "No live canvas" is
 * not actionable; "a canvas existed but covered 1% of the viewport" is.
 *
 * @param {number | null} visibleCanvasCount
 * @param {number | null} canvasViewportRatio
 * @param {number} framesRendered
 */
function liveCanvasFailureBasis(visibleCanvasCount, canvasViewportRatio, framesRendered) {
  if (visibleCanvasCount === null) return "no DOM surface read was available to look for a canvas";
  if (visibleCanvasCount === 0) return "no canvas larger than 8x8 was present at the end of the session";
  if ((canvasViewportRatio ?? 0) < LIVE_CANVAS_VIEWPORT_RATIO) {
    return (
      `${visibleCanvasCount} canvas(es) present but covering only ${pct(canvasViewportRatio)} of ` +
      `the viewport, under the ${pct(LIVE_CANVAS_VIEWPORT_RATIO)} threshold for a primary surface`
    );
  }
  return `a canvas was present but only ${framesRendered} frames rendered, under the ${LIVE_FRAME_FLOOR}-frame floor`;
}

/** @param {unknown} v */
function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** @param {number} bytes */
function fmtBytes(bytes) {
  if (bytes >= 1_000_000) return `${round4(bytes / 1_000_000).toFixed(2)}MB`;
  if (bytes >= 1000) return `${Math.round(bytes / 1000)}KB`;
  return `${bytes}B`;
}

/** @param {number | null} ratio */
function pct(ratio) {
  return ratio === null ? "an unknown share" : `${Math.round(ratio * 100)}%`;
}
