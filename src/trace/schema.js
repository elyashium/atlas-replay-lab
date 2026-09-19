/**
 * Flight-recorder trace schema.
 *
 * OTel-shaped without dragging in OTel: `resource` attributes describe what
 * produced the trace, events carry a name, a kind and a flat attribute bag,
 * and `toOtlpSpans()` below emits a structure an OTLP/JSON collector would
 * accept. The point is that this schema would not look out of place next to a
 * real tracing pipeline if Stage 4 ever needed one.
 *
 * Two deliberate departures from OTel, both for determinism:
 *
 *  - Events carry `tOffsetMs` (a monotonic offset from trace start) rather
 *    than a wall-clock timestamp. A trace recorded at 09:00 and the same trace
 *    replayed at 17:00 must be byte-identical, and wall clocks make that
 *    impossible.
 *  - Timings are quantised before hashing. Nothing about a real browser is
 *    deterministic to the microsecond; pretending otherwise produces a
 *    determinism check that fails for reasons nobody cares about.
 *
 * @typedef {import("../../types/atlas.js").Trace} Trace
 * @typedef {import("../../types/atlas.js").TraceEvent} TraceEvent
 * @typedef {import("../../types/atlas.js").TraceMetrics} TraceMetrics
 * @typedef {import("../../types/atlas.js").ExperienceState} ExperienceState
 */

import { sha256 } from "../util/hash.js";

export const TRACE_SCHEMA_VERSION = 1;

/** Event-time quantisation for the determinism hash, in ms. */
export const TIME_QUANTUM_MS = 8;

/** @type {TraceMetrics} */
export const EMPTY_METRICS = {
  firstFrameMs: null,
  timeToInteractiveMs: null,
  p50InteractionMs: null,
  p95InteractionMs: null,
  interactionCount: 0,
  framesRendered: 0,
  framesDropped: 0,
  droppedFrameRatio: null,
  transferBytes: 0,
  assetFailures: 0,
  jsHeapUsedMB: null,
  reachedEndState: false,
  stepsToEndState: null,
  firstFrameNonBlank: null,
};

/**
 * @param {{
 *   traceId: string;
 *   manifest: import("../../types/atlas.js").ExperienceManifest;
 *   profileId: string;
 *   runKind: Trace["resource"]["atlas.run.kind"];
 *   emulated: boolean;
 *   seed: number;
 *   capability: import("../../types/atlas.js").CapabilitySnapshot;
 *   capabilityBucket: import("../../types/atlas.js").CapabilityBucket;
 * }} init
 * @returns {Trace}
 */
export function newTrace(init) {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    traceId: init.traceId,
    resource: {
      "service.name": "atlas-replay-lab",
      "service.version": "0.1.0",
      "atlas.manifest.id": init.manifest.id,
      "atlas.manifest.version": init.manifest.version,
      "atlas.manifest.hash": init.manifest.contentHash,
      "atlas.profile.id": init.profileId,
      "atlas.run.kind": init.runKind,
      "atlas.emulated": init.emulated,
      "atlas.seed": init.seed,
    },
    capability: init.capability,
    capabilityBucket: init.capabilityBucket,
    decision: null,
    servedTier: null,
    servedPath: null,
    states: [],
    events: [],
    checkpoints: [],
    metrics: { ...EMPTY_METRICS },
    inputClasses: [],
    determinismHash: "",
    startedAtIso: new Date().toISOString(),
    durationMs: 0,
    notes: [],
  };
}

/**
 * Derives metrics from the raw event stream. Kept separate from recording so
 * that a trace captured by the browser and a trace reconstructed from disk go
 * through exactly the same derivation.
 *
 * @param {Trace} trace
 * @param {import("../../types/atlas.js").ExperienceManifest} manifest
 * @returns {TraceMetrics}
 */
export function deriveMetrics(trace, manifest) {
  const events = trace.events;
  const byName = /** @param {string} n */ (n) => events.find((e) => e.name === n);

  const firstFrame = byName("first-frame");
  const interactive = byName("interactive");

  const latencies = events
    .filter((e) => e.kind === "interaction" && typeof e.attributes.latencyMs === "number")
    .map((e) => Number(e.attributes.latencyMs))
    .sort((a, b) => a - b);

  const frameEvents = events.filter((e) => e.kind === "frame");
  const framesRendered = frameEvents.reduce((s, e) => s + Number(e.attributes.rendered ?? 0), 0);
  const framesDropped = frameEvents.reduce((s, e) => s + Number(e.attributes.dropped ?? 0), 0);

  const assetEvents = events.filter((e) => e.kind === "asset");
  const transferBytes = assetEvents.reduce((s, e) => s + Number(e.attributes.bytes ?? 0), 0);
  const assetFailures = assetEvents.filter((e) => e.attributes.ok === false).length;

  const endState = manifest.invariants.business.endState;
  const endIdx = trace.states.indexOf(endState);
  const interactiveIdx = trace.states.indexOf("interactive");

  const heapEvent = [...events].reverse().find((e) => typeof e.attributes.jsHeapUsedMB === "number");

  return {
    firstFrameMs: firstFrame ? firstFrame.tOffsetMs : null,
    timeToInteractiveMs: interactive ? interactive.tOffsetMs : null,
    p50InteractionMs: percentile(latencies, 0.5),
    p95InteractionMs: percentile(latencies, 0.95),
    interactionCount: latencies.length,
    framesRendered,
    framesDropped,
    droppedFrameRatio:
      framesRendered + framesDropped > 0
        ? round4(framesDropped / (framesRendered + framesDropped))
        : null,
    transferBytes,
    assetFailures,
    jsHeapUsedMB: heapEvent ? Number(heapEvent.attributes.jsHeapUsedMB) : null,
    reachedEndState: endIdx >= 0,
    stepsToEndState: endIdx >= 0 && interactiveIdx >= 0 ? endIdx - interactiveIdx : null,
    firstFrameNonBlank:
      firstFrame && typeof firstFrame.attributes.nonBlank === "boolean"
        ? Boolean(firstFrame.attributes.nonBlank)
        : null,
  };
}

/**
 * @param {number[]} sorted
 * @param {number} q
 * @returns {number | null}
 */
export function percentile(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return round4(sorted[0]);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return round4(sorted[lo] * (1 - frac) + sorted[hi] * frac);
}

/** @param {number} n */
export function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Converts a trace to an OTLP/JSON-shaped payload. Not used by the pipeline —
 * it exists to demonstrate that the schema is genuinely OTel-compatible rather
 * than merely OTel-flavoured, and it is exercised by the test suite.
 *
 * @param {Trace} trace
 * @param {number} [startUnixNano]
 */
export function toOtlpSpans(trace, startUnixNano) {
  const start = startUnixNano ?? BigInt(Date.parse(trace.startedAtIso)) * 1_000_000n;
  const traceIdHex = sha256(trace.traceId, 32);
  return {
    resourceSpans: [
      {
        resource: {
          attributes: Object.entries(trace.resource).map(([key, value]) => ({
            key,
            value: typeof value === "boolean" ? { boolValue: value } : { stringValue: String(value) },
          })),
        },
        scopeSpans: [
          {
            scope: { name: "atlas.flight-recorder", version: "0.1.0" },
            spans: [
              {
                traceId: traceIdHex,
                spanId: sha256(`${trace.traceId}:root`, 16),
                name: `atlas.session/${trace.resource["atlas.profile.id"]}`,
                kind: 1,
                startTimeUnixNano: String(start),
                endTimeUnixNano: String(start + BigInt(Math.round(trace.durationMs)) * 1_000_000n),
                attributes: [
                  { key: "atlas.served.tier", value: { stringValue: String(trace.servedTier) } },
                  { key: "atlas.served.path", value: { stringValue: String(trace.servedPath) } },
                  { key: "atlas.capability.bucket", value: { stringValue: trace.capabilityBucket.id } },
                ],
                events: trace.events.map((e) => ({
                  name: e.name,
                  timeUnixNano: String(start + BigInt(Math.round(e.tOffsetMs)) * 1_000_000n),
                  attributes: [
                    { key: "atlas.kind", value: { stringValue: e.kind } },
                    ...Object.entries(e.attributes).map(([key, value]) => ({
                      key,
                      value:
                        typeof value === "boolean"
                          ? { boolValue: value }
                          : typeof value === "number"
                            ? { doubleValue: value }
                            : { stringValue: String(value) },
                    })),
                  ],
                })),
              },
            ],
          },
        ],
      },
    ],
  };
}
