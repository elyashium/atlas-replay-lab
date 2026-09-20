/**
 * Turns the partial trace a page posts into the canonical `Trace`.
 *
 * The page records; the server assembles. That split exists so there is exactly
 * one implementation of the trace schema, one metric derivation, and one
 * determinism hash — a live capture from a throttled Android profile and a
 * replay reconstructed from disk both come through here. If the page assembled
 * its own canonical traces, "replay produced an identical trace" could be true
 * of two different schema versions, which would make the whole determinism
 * claim worthless.
 *
 * This function also treats the payload as untrusted input. It arrives over
 * HTTP from a browser; every field is coerced, allow-listed and bounded before
 * it becomes part of a trace that a decision engine will later read.
 *
 * @typedef {import("../../types/atlas.js").Trace} Trace
 * @typedef {import("../../types/atlas.js").TraceEvent} TraceEvent
 * @typedef {import("../../types/atlas.js").TraceEventKind} TraceEventKind
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 * @typedef {import("../../types/atlas.js").ExperienceState} ExperienceState
 */

import { newTrace, deriveMetrics } from "./schema.js";
import { determinismHash } from "./normalize.js";
import { normalizeSnapshot, bucketOf } from "../capability/buckets.js";

/** Hard ceilings, so a runaway page cannot post an unbounded trace. */
const MAX_EVENTS = 20_000;
const MAX_STATES = 512;
const MAX_CHECKPOINTS = 64;
const MAX_ATTRIBUTE_KEYS = 24;
const MAX_STRING_LEN = 256;

/** @type {TraceEventKind[]} */
const EVENT_KINDS = ["lifecycle", "asset", "state", "interaction", "frame", "decision", "error"];

/** @type {Array<Trace["resource"]["atlas.run.kind"]>} */
const RUN_KINDS = ["baseline", "adaptive", "replay", "production"];

/**
 * @param {unknown} rawPayload  the body of POST /api/trace
 * @param {{ manifest: ExperienceManifest; emulated?: boolean; profileId?: string }} opts
 * @returns {Trace}
 */
export function assembleTrace(rawPayload, opts) {
  const payload = /** @type {Record<string, any>} */ (
    rawPayload && typeof rawPayload === "object" ? rawPayload : {}
  );

  const capability = normalizeSnapshot(payload.capability);
  const trace = newTrace({
    traceId: str(payload.traceId) || `unidentified-${Date.now().toString(36)}`,
    manifest: opts.manifest,
    profileId: str(payload.profileId) || opts.profileId || "unknown",
    runKind: RUN_KINDS.includes(payload.runKind) ? payload.runKind : "production",
    emulated: typeof payload.emulated === "boolean" ? payload.emulated : (opts.emulated ?? true),
    seed: (num(payload.seed) ?? 0) >>> 0,
    capability,
    capabilityBucket: bucketOf(capability),
  });

  trace.decision = decision(payload.decision);
  trace.servedTier = str(payload.servedTier) || null;
  trace.servedPath = str(payload.servedPath) || null;
  trace.states = arr(payload.states, MAX_STATES).map((s) => /** @type {ExperienceState} */ (str(s)));
  trace.events = arr(payload.events, MAX_EVENTS).map(event).filter(Boolean);
  trace.checkpoints = arr(payload.checkpoints, MAX_CHECKPOINTS).map(checkpoint);
  trace.inputClasses = arr(payload.inputClasses, MAX_EVENTS).map((s) => str(s));
  trace.durationMs = num(payload.durationMs) ?? 0;
  trace.notes = arr(payload.notes, 64).map((s) => str(s));

  // The page's own PerformanceResourceTiming total is recorded as a note rather
  // than as the metric. `deriveMetrics` sums the per-asset byte counts the
  // loader observed, which is the number the manifest's transfer budget is
  // written against; a divergence between the two is worth seeing, not hiding.
  const observed = num(payload.observedTransferBytes);
  if (observed !== null) {
    trace.notes.push(`page-reported resource transfer total: ${observed} bytes`);
  }

  return finalizeTrace(trace, opts.manifest);
}

/**
 * Re-derives metrics and re-hashes. Call this after mutating a trace — the
 * runner does, once it has decoded the first-frame screenshot and can fill in
 * the blank-frame measurement the page is deliberately unable to make.
 *
 * @param {Trace} trace
 * @param {ExperienceManifest} manifest
 * @returns {Trace}
 */
export function finalizeTrace(trace, manifest) {
  trace.metrics = deriveMetrics(trace, manifest);
  trace.determinismHash = determinismHash(trace);
  return trace;
}

/**
 * Fills in `first-frame`'s `nonBlank` attribute from a measurement taken on the
 * decoded checkpoint screenshot, then re-derives.
 *
 * The page sets this to null on purpose. Deciding "was the first frame blank"
 * from inside the page would mean reading pixels back out of the canvas, which
 * is the one thing the privacy model says page JavaScript never does — and it
 * would also miss the composited camera and anchor layers underneath, which is
 * exactly where a blank product layer hides.
 *
 * @param {Trace} trace
 * @param {ExperienceManifest} manifest
 * @param {{ nonBlankness: number; focalCoverage: number; edgeEnergy: number }} measured
 * @returns {Trace}
 */
export function applyFirstFrameVisual(trace, manifest, measured) {
  const firstFrame = trace.events.find((e) => e.name === "first-frame");
  if (firstFrame) {
    const threshold = manifest.invariants.visual.minFocalCoverage;
    firstFrame.attributes.nonBlank = measured.focalCoverage >= threshold;
    firstFrame.attributes.focalCoverage = round4(measured.focalCoverage);
    firstFrame.attributes.nonBlankness = round4(measured.nonBlankness);
    firstFrame.attributes.edgeEnergy = round4(measured.edgeEnergy);
  }
  return finalizeTrace(trace, manifest);
}

/* ── coercion ─────────────────────────────────────────────────────────── */

/**
 * @param {unknown} raw
 * @returns {TraceEvent | null}
 */
function event(raw) {
  if (!raw || typeof raw !== "object") return null;
  const e = /** @type {Record<string, any>} */ (raw);
  const kind = EVENT_KINDS.includes(e.kind) ? e.kind : null;
  const name = str(e.name);
  if (!kind || !name) return null;
  return {
    tOffsetMs: num(e.tOffsetMs) ?? 0,
    name,
    kind,
    attributes: attributes(e.attributes),
  };
}

/**
 * @param {unknown} raw
 * @returns {Record<string, string | number | boolean | null>}
 */
function attributes(raw) {
  /** @type {Record<string, string | number | boolean | null>} */
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count++ >= MAX_ATTRIBUTE_KEYS) break;
    if (value === null) out[key] = null;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "number") out[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === "string") out[key] = value.slice(0, MAX_STRING_LEN);
    // Objects and arrays are dropped: a flat attribute bag is what keeps the
    // OTLP export honest and the normalisation allow-list meaningful.
  }
  return out;
}

/**
 * The page posts a checkpoint's identity and timing; it never posts the visual
 * measurements. Those are filled in by the runner from the decoded screenshot
 * (see src/runner/session.js). They are initialised to null here so that a
 * trace is structurally complete the moment it is assembled — a consumer
 * reading `focalCoverage` gets an explicit "not measured" rather than
 * `undefined`, which would silently disable the visual invariant it gates.
 *
 * @param {unknown} raw
 * @returns {import("../../types/atlas.js").TraceCheckpoint}
 */
function checkpoint(raw) {
  const c = /** @type {Record<string, any>} */ (raw && typeof raw === "object" ? raw : {});
  return {
    id: str(c.id),
    state: /** @type {ExperienceState} */ (str(c.state)),
    tOffsetMs: num(c.tOffsetMs) ?? 0,
    screenshotPath: str(c.screenshotPath) || null,
    focalCoverage: num(c.focalCoverage),
    alphaEdgeDrift: num(c.alphaEdgeDrift),
  };
}

/**
 * A posted decision is reconstructed field by field rather than trusted
 * wholesale. The three answer objects mirror Jev's three question primitives
 * (choice / noul / score) and are the shape every engine must produce, so they
 * are rebuilt structurally — a decision that arrives missing its distribution
 * gets an explicit empty one instead of an `undefined` that would later blow up
 * a calibration bucket.
 *
 * @param {unknown} raw
 * @returns {Trace["decision"]}
 */
function decision(raw) {
  if (!raw || typeof raw !== "object") return null;
  const d = /** @type {Record<string, any>} */ (raw);
  const tier = str(d.tier);
  const path = str(d.path);
  if (!tier || !path) return null;
  return {
    tier: /** @type {any} */ (tier),
    tierAnswer: {
      value: /** @type {any} */ (str(d.tierAnswer?.value) || tier),
      distribution: distribution(d.tierAnswer?.distribution),
    },
    cameraPathSafe: { pTrue: clamp01(num(d.cameraPathSafe?.pTrue) ?? 0) },
    firstFrameRisk: {
      score: num(d.firstFrameRisk?.score) ?? 0,
      levels: arr(d.firstFrameRisk?.levels, 16).map((s) => str(s)),
      distribution: distribution(d.firstFrameRisk?.distribution),
    },
    path: /** @type {any} */ (path),
    confidence: clamp01(num(d.confidence) ?? 0),
    engine: str(d.engine) || "unknown",
    rationale: arr(d.rationale, 24).map((s) => str(s)),
    guard: guard(d.guard),
  };
}

/**
 * @param {unknown} raw
 * @returns {import("../../types/atlas.js").GuardReport | undefined}
 */
function guard(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const g = /** @type {Record<string, any>} */ (raw);
  /** @type {import("../../types/atlas.js").GuardReport} */
  const report = {
    primaryEngine: str(g.primaryEngine) || "unknown",
    primaryConfidence: clamp01(num(g.primaryConfidence) ?? 0),
    threshold: clamp01(num(g.threshold) ?? 0),
    overridden: Boolean(g.overridden),
    reason: str(g.reason) || "no reason recorded",
  };
  if (str(g.error)) report.error = str(g.error);
  return report;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, number>}
 */
function distribution(raw) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count++ >= 255) break; // Jev's choice ceiling
    const n = num(value);
    if (n !== null) out[key.slice(0, MAX_STRING_LEN)] = clamp01(n);
  }
  return out;
}

/** @param {unknown} v */
function str(v) {
  return typeof v === "string" ? v.slice(0, MAX_STRING_LEN) : "";
}

/** @param {unknown} v */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * @param {unknown} v
 * @param {number} max
 * @returns {any[]}
 */
function arr(v, max) {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

/** @param {number} n */
function clamp01(n) {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** @param {number} n */
function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}
