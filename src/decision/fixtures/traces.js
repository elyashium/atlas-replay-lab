/**
 * Synthetic traces for the trace-judge fixtures, the test suite, and
 * `examples/traces/`.
 *
 * ── These are not captured sessions ─────────────────────────────────────────
 * Every trace in this file is hand-authored: the event stream is written by me
 * to exercise a specific failure mode, not recorded from a browser. They are
 * built through the real `newTrace`/`finalizeTrace` path, so they are
 * structurally valid traces with correctly derived metrics and a real
 * determinism hash — but the timings inside them are invented.
 *
 * That distinction is load-bearing and it is why this file exists separately
 * from anything the matrix writes:
 *
 *  - These are legitimate for **fixtures and tests**. A test asserting "a trace
 *    with a 4200ms first frame against a 1200ms budget must be judged a fail"
 *    needs a trace with a 4200ms first frame, and inventing one is the honest
 *    way to get it.
 *  - They are **not** legitimate as evidence. The before/after metrics in the
 *    failure story must come from `artifacts/matrix/`, captured by a real
 *    throttled Chrome. Nothing in this file may be quoted as a measurement, and
 *    `$note` on every emitted file says so.
 *
 * The `expected` block on each scenario is my own judgement of the correct
 * verdict, used the same way `groundTruth` is used in states.js — with the same
 * caveat that agreement with it is agreement with me, not with reality.
 *
 * @typedef {import("../../../types/atlas.js").Trace} Trace
 * @typedef {import("../../../types/atlas.js").TraceEvent} TraceEvent
 * @typedef {import("../../../types/atlas.js").ExperienceManifest} ExperienceManifest
 * @typedef {import("../../../types/atlas.js").ExperienceState} ExperienceState
 */

import { newTrace } from "../../trace/schema.js";
import { finalizeTrace } from "../../trace/assemble.js";
import { quantise } from "../../trace/normalize.js";
import { normalizeSnapshot, bucketOf } from "../../capability/buckets.js";
import { stateById } from "./states.js";

/**
 * Fixed start timestamp for every synthetic trace.
 *
 * `newTrace` stamps `startedAtIso` from the wall clock, which is right for a
 * real capture and wrong for a checked-in fixture: regenerating would produce a
 * diff on every line of every file for no reason. Overridden to a constant so
 * `npm run build:fixtures` is idempotent.
 */
const FIXED_START_ISO = "2026-01-01T00:00:00.000Z";

/** The happy-path state sequence, legal under the manifest's transition list. */
const FULL_FLOW = /** @type {ExperienceState[]} */ ([
  "boot",
  "probing",
  "routing",
  "loading",
  "first-frame",
  "interactive",
  "product-detail",
  "cart",
  "checkout-complete",
]);

/**
 * @typedef {object} TraceScenario
 * @property {string} id
 * @property {string} label
 * @property {string} why                     what this scenario is here to exercise
 * @property {string} stateId                 a SYNTHETIC_STATES id
 * @property {string} profileId
 * @property {Trace["resource"]["atlas.run.kind"]} runKind
 * @property {string} servedTier
 * @property {string} servedPath
 * @property {ExperienceState[]} states
 * @property {object} timings
 * @property {number|null} timings.firstFrameMs
 * @property {number|null} timings.interactiveMs
 * @property {number} timings.durationMs
 * @property {Array<{id: string; bytes: number; ok: boolean; ms: number; critical?: boolean; error?: string}>} assets
 * @property {Array<{class: string; latencyMs: number; at: number}>} interactions
 * @property {Array<{at: number; rendered: number; dropped: number; jsHeapUsedMB: number}>} frames
 * @property {Array<{at: number; name: string; code: string; detail?: string}>} [errors]
 * @property {{focalCoverage: number|null; nonBlank: boolean|null}} firstFrameVisual
 * @property {Array<{id: string; state: ExperienceState; at: number; focalCoverage: number|null; alphaEdgeDrift: number|null}>} checkpoints
 * @property {string[]} [notes]
 * @property {object} expected
 * @property {string} expected.outcome
 * @property {string} expected.rootCause
 * @property {string} expected.releaseBlocking
 * @property {boolean} expected.visual
 * @property {boolean} expected.interaction
 * @property {boolean} expected.business
 * @property {boolean} [contested]
 */

/** @type {TraceScenario[]} */
export const TRACE_SCENARIOS = [
  {
    id: "pass-high-desktop",
    label: "Clean pass, high tier, camera path",
    why: "The control. If the judge cannot recognise an unambiguous pass, nothing else it says is worth reading.",
    stateId: "desktop-wifi-strong",
    profileId: "high-end-wifi",
    runKind: "adaptive",
    servedTier: "high",
    servedPath: "camera-xr",
    states: FULL_FLOW,
    timings: { firstFrameMs: 612, interactiveMs: 940, durationMs: 6480 },
    assets: [
      { id: "tex-hi", bytes: 900_000, ok: true, ms: 340, critical: true },
      { id: "geo-hi", bytes: 420_000, ok: true, ms: 180, critical: true },
    ],
    interactions: [
      { class: "tap:product", latencyMs: 34, at: 1480 },
      { class: "tap:add-to-cart", latencyMs: 41, at: 3120 },
      { class: "tap:checkout", latencyMs: 38, at: 5010 },
    ],
    frames: [
      { at: 1200, rendered: 58, dropped: 1, jsHeapUsedMB: 74 },
      { at: 3200, rendered: 119, dropped: 2, jsHeapUsedMB: 88 },
      { at: 5200, rendered: 118, dropped: 1, jsHeapUsedMB: 91 },
    ],
    firstFrameVisual: { focalCoverage: 0.184, nonBlank: true },
    checkpoints: [
      { id: "cp-first-frame", state: "first-frame", at: 612, focalCoverage: 0.184, alphaEdgeDrift: null },
      { id: "cp-interactive", state: "interactive", at: 940, focalCoverage: 0.181, alphaEdgeDrift: 0.041 },
      { id: "cp-product-detail", state: "product-detail", at: 1520, focalCoverage: 0.166, alphaEdgeDrift: 0.128 },
      { id: "cp-checkout", state: "checkout-complete", at: 5060, focalCoverage: 0.142, alphaEdgeDrift: 0.174 },
    ],
    expected: {
      outcome: "pass",
      rootCause: "unknown",
      releaseBlocking: "not blocking",
      visual: true,
      interaction: true,
      business: true,
    },
  },

  {
    id: "fail-baseline-low-cpu-3g",
    label: "Baseline: high tier forced onto low-CPU/3G — the failure story",
    why:
      "The 'before' half of §5.2 item 8. The router is bypassed and the high tier " +
      "is served to a device that cannot carry it; the first frame misses its " +
      "budget by 3.5x, the frame loop collapses, and checkout is never reached.",
    stateId: "low-cpu-3g",
    profileId: "low-cpu-3g",
    runKind: "baseline",
    servedTier: "high",
    servedPath: "interactive-2d",
    states: /** @type {ExperienceState[]} */ ([
      "boot",
      "probing",
      "routing",
      "loading",
      "first-frame",
      "degraded",
    ]),
    timings: { firstFrameMs: 4310, interactiveMs: null, durationMs: 9000 },
    assets: [
      { id: "tex-hi", bytes: 900_000, ok: true, ms: 3620, critical: true },
      { id: "geo-hi", bytes: 420_000, ok: false, ms: 5000, critical: true, error: "net::ERR_TIMED_OUT" },
    ],
    interactions: [{ class: "tap:product", latencyMs: 890, at: 6100 }],
    frames: [
      { at: 5000, rendered: 9, dropped: 21, jsHeapUsedMB: 164 },
      { at: 7000, rendered: 7, dropped: 23, jsHeapUsedMB: 178 },
    ],
    errors: [
      { at: 5000, name: "asset-failed", code: "ERR_TIMED_OUT", detail: "geo-hi exceeded the load deadline" },
      { at: 5040, name: "degraded-entry", code: "CRITICAL_ASSET_MISSING" },
    ],
    firstFrameVisual: { focalCoverage: 0.008, nonBlank: false },
    checkpoints: [
      { id: "cp-first-frame", state: "first-frame", at: 4310, focalCoverage: 0.008, alphaEdgeDrift: null },
    ],
    notes: ["baseline run: the tier router was bypassed and 'high' pinned by the harness"],
    expected: {
      outcome: "fail",
      rootCause: "network",
      releaseBlocking: "hard block",
      visual: false,
      interaction: false,
      business: false,
    },
  },

  {
    id: "pass-adaptive-low-cpu-3g",
    label: "Adaptive: the same profile, routed to the low tier — the fix",
    why:
      "The 'after' half of the failure story. Identical device and network; the " +
      "only difference is that the DecisionEngine chose the tier. Everything the " +
      "baseline breached now holds.",
    stateId: "low-cpu-3g",
    profileId: "low-cpu-3g",
    runKind: "adaptive",
    servedTier: "low",
    servedPath: "interactive-2d",
    states: FULL_FLOW,
    timings: { firstFrameMs: 1042, interactiveMs: 1380, durationMs: 8200 },
    assets: [{ id: "tex-low", bytes: 62_000, ok: true, ms: 742, critical: true }],
    interactions: [
      { class: "tap:product", latencyMs: 148, at: 2100 },
      { class: "tap:add-to-cart", latencyMs: 161, at: 4300 },
      { class: "tap:checkout", latencyMs: 139, at: 6400 },
    ],
    frames: [
      { at: 2000, rendered: 27, dropped: 3, jsHeapUsedMB: 58 },
      { at: 4000, rendered: 28, dropped: 2, jsHeapUsedMB: 63 },
      { at: 6000, rendered: 26, dropped: 4, jsHeapUsedMB: 66 },
    ],
    firstFrameVisual: { focalCoverage: 0.121, nonBlank: true },
    checkpoints: [
      { id: "cp-first-frame", state: "first-frame", at: 1042, focalCoverage: 0.121, alphaEdgeDrift: null },
      { id: "cp-interactive", state: "interactive", at: 1380, focalCoverage: 0.119, alphaEdgeDrift: 0.052 },
      { id: "cp-product-detail", state: "product-detail", at: 2180, focalCoverage: 0.108, alphaEdgeDrift: 0.141 },
      { id: "cp-checkout", state: "checkout-complete", at: 6480, focalCoverage: 0.094, alphaEdgeDrift: 0.188 },
    ],
    expected: {
      outcome: "pass",
      rootCause: "unknown",
      releaseBlocking: "not blocking",
      visual: true,
      interaction: true,
      business: true,
    },
  },

  {
    id: "degraded-packet-loss",
    label: "Reaches checkout, misses timing budgets",
    why:
      "The case the binary pass/fail split gets wrong. The user completed the " +
      "flow; the experience was worse than it should have been. A judge that " +
      "calls this 'fail' blocks a shippable release, and one that calls it " +
      "'pass' hides a real regression.",
    stateId: "packet-loss-4g",
    profileId: "packet-loss",
    runKind: "adaptive",
    servedTier: "mid",
    servedPath: "interactive-2d",
    states: FULL_FLOW,
    timings: { firstFrameMs: 1580, interactiveMs: 2760, durationMs: 11_400 },
    assets: [
      { id: "tex-mid", bytes: 240_000, ok: true, ms: 1210, critical: true },
      { id: "geo-mid", bytes: 96_000, ok: true, ms: 980, critical: true },
    ],
    interactions: [
      { class: "tap:product", latencyMs: 96, at: 3400 },
      { class: "tap:add-to-cart", latencyMs: 214, at: 6100 },
      { class: "tap:checkout", latencyMs: 188, at: 9200 },
    ],
    frames: [
      { at: 3000, rendered: 48, dropped: 8, jsHeapUsedMB: 96 },
      { at: 6000, rendered: 51, dropped: 9, jsHeapUsedMB: 104 },
      { at: 9000, rendered: 49, dropped: 7, jsHeapUsedMB: 108 },
    ],
    firstFrameVisual: { focalCoverage: 0.147, nonBlank: true },
    checkpoints: [
      { id: "cp-first-frame", state: "first-frame", at: 1580, focalCoverage: 0.147, alphaEdgeDrift: null },
      { id: "cp-interactive", state: "interactive", at: 2760, focalCoverage: 0.144, alphaEdgeDrift: 0.061 },
      { id: "cp-product-detail", state: "product-detail", at: 3480, focalCoverage: 0.131, alphaEdgeDrift: 0.152 },
      { id: "cp-checkout", state: "checkout-complete", at: 9280, focalCoverage: 0.118, alphaEdgeDrift: 0.193 },
    ],
    expected: {
      outcome: "degraded-but-acceptable",
      rootCause: "network",
      releaseBlocking: "moderate",
      visual: true,
      interaction: true,
      business: true,
    },
    contested: true,
  },

  {
    id: "pass-camera-denied-fallback",
    label: "Camera denied, 2D fallback carries the flow",
    why:
      "A refused permission is supposed to be survivable — that is the entire " +
      "point of having fallback paths. This must judge as a pass, and the root " +
      "cause question should say permission-denied without that implying failure. " +
      "If the judge conflates 'something notable happened' with 'something broke', " +
      "it shows up here.",
    stateId: "camera-denied",
    profileId: "camera-denied",
    runKind: "adaptive",
    servedTier: "high",
    servedPath: "interactive-2d",
    states: FULL_FLOW,
    timings: { firstFrameMs: 710, interactiveMs: 1090, durationMs: 7100 },
    assets: [
      { id: "tex-hi", bytes: 900_000, ok: true, ms: 402, critical: true },
      { id: "geo-hi", bytes: 420_000, ok: true, ms: 214, critical: true },
    ],
    interactions: [
      { class: "tap:product", latencyMs: 40, at: 1600 },
      { class: "tap:add-to-cart", latencyMs: 44, at: 3400 },
      { class: "tap:checkout", latencyMs: 39, at: 5600 },
    ],
    frames: [
      { at: 1500, rendered: 59, dropped: 1, jsHeapUsedMB: 71 },
      { at: 3500, rendered: 118, dropped: 2, jsHeapUsedMB: 83 },
      { at: 5500, rendered: 117, dropped: 2, jsHeapUsedMB: 86 },
    ],
    errors: [{ at: 320, name: "permission-denied", code: "CAMERA_DENIED" }],
    firstFrameVisual: { focalCoverage: 0.178, nonBlank: true },
    checkpoints: [
      { id: "cp-first-frame", state: "first-frame", at: 710, focalCoverage: 0.178, alphaEdgeDrift: null },
      { id: "cp-interactive", state: "interactive", at: 1090, focalCoverage: 0.176, alphaEdgeDrift: 0.038 },
      { id: "cp-product-detail", state: "product-detail", at: 1680, focalCoverage: 0.162, alphaEdgeDrift: 0.121 },
      { id: "cp-checkout", state: "checkout-complete", at: 5670, focalCoverage: 0.139, alphaEdgeDrift: 0.168 },
    ],
    notes: ["camera permission refused at probe time; routed to the interactive-2d path"],
    expected: {
      outcome: "pass",
      rootCause: "permission-denied",
      releaseBlocking: "not blocking",
      visual: true,
      interaction: true,
      business: true,
    },
  },

  {
    id: "fail-manifest-bug-404",
    label: "Critical asset URL does not resolve",
    why:
      "Distinguishing a configuration fault from an environment fault. The " +
      "network is fast and the device is capable; the asset 404s because the " +
      "manifest points at a file that is not there. A judge that reaches for " +
      "'network' whenever an asset fails will get this wrong.",
    stateId: "flagship-android-4g",
    profileId: "mid-android-4g",
    runKind: "adaptive",
    servedTier: "mid",
    servedPath: "interactive-2d",
    states: /** @type {ExperienceState[]} */ (["boot", "probing", "routing", "loading", "error"]),
    timings: { firstFrameMs: null, interactiveMs: null, durationMs: 3400 },
    assets: [
      { id: "tex-mid", bytes: 240_000, ok: true, ms: 190, critical: true },
      { id: "geo-mid", bytes: 0, ok: false, ms: 42, critical: true, error: "HTTP 404" },
    ],
    interactions: [],
    frames: [],
    errors: [
      { at: 260, name: "asset-failed", code: "HTTP_404", detail: "assets/generated/orbital-geo-mid.bin" },
      { at: 300, name: "fatal", code: "CRITICAL_ASSET_MISSING" },
    ],
    firstFrameVisual: { focalCoverage: null, nonBlank: null },
    checkpoints: [],
    expected: {
      outcome: "fail",
      rootCause: "manifest-bug",
      releaseBlocking: "hard block",
      visual: false,
      interaction: false,
      business: false,
    },
  },

  {
    id: "fail-render-stall",
    label: "Fast network, capable device, main thread stalls",
    why:
      "Root-cause isolation with the network explicitly ruled out. Assets land " +
      "quickly and the heap is calm; the frame loop still collapses and tap " +
      "latency goes past a second. The only bucket left is render-stall.",
    stateId: "stalling-midsession",
    profileId: "high-end-wifi",
    runKind: "adaptive",
    servedTier: "high",
    servedPath: "camera-xr",
    states: /** @type {ExperienceState[]} */ ([
      "boot",
      "probing",
      "routing",
      "loading",
      "first-frame",
      "interactive",
      "degraded",
    ]),
    timings: { firstFrameMs: 680, interactiveMs: 1020, durationMs: 12_000 },
    assets: [
      { id: "tex-hi", bytes: 900_000, ok: true, ms: 268, critical: true },
      { id: "geo-hi", bytes: 420_000, ok: true, ms: 141, critical: true },
    ],
    interactions: [
      { class: "tap:product", latencyMs: 1240, at: 4200 },
      { class: "tap:add-to-cart", latencyMs: 1810, at: 8100 },
    ],
    frames: [
      { at: 3000, rendered: 22, dropped: 38, jsHeapUsedMB: 94 },
      { at: 6000, rendered: 14, dropped: 46, jsHeapUsedMB: 97 },
      { at: 9000, rendered: 11, dropped: 49, jsHeapUsedMB: 99 },
    ],
    errors: [{ at: 9400, name: "degraded-entry", code: "FRAME_BUDGET_COLLAPSE" }],
    firstFrameVisual: { focalCoverage: 0.181, nonBlank: true },
    checkpoints: [
      { id: "cp-first-frame", state: "first-frame", at: 680, focalCoverage: 0.181, alphaEdgeDrift: null },
      { id: "cp-interactive", state: "interactive", at: 1020, focalCoverage: 0.177, alphaEdgeDrift: 0.044 },
    ],
    expected: {
      outcome: "fail",
      rootCause: "render-stall",
      releaseBlocking: "major",
      visual: true,
      interaction: false,
      business: false,
    },
  },

  {
    id: "fail-memory-pressure",
    label: "Heap ceiling breached on a small device",
    why:
      "Memory as the binding constraint, with network fast enough to be ruled " +
      "out. Separates 'the device could not hold it' from 'the device could not " +
      "fetch it' — two very different fixes.",
    stateId: "mid-android-4g",
    profileId: "mid-android-4g",
    runKind: "baseline",
    servedTier: "high",
    servedPath: "camera-xr",
    states: /** @type {ExperienceState[]} */ ([
      "boot",
      "probing",
      "routing",
      "loading",
      "first-frame",
      "interactive",
      "degraded",
      "error",
    ]),
    timings: { firstFrameMs: 1140, interactiveMs: 1720, durationMs: 10_200 },
    assets: [
      { id: "tex-hi", bytes: 900_000, ok: true, ms: 720, critical: true },
      { id: "geo-hi", bytes: 420_000, ok: true, ms: 340, critical: true },
    ],
    interactions: [{ class: "tap:product", latencyMs: 420, at: 3200 }],
    frames: [
      { at: 3000, rendered: 44, dropped: 16, jsHeapUsedMB: 198 },
      { at: 6000, rendered: 31, dropped: 29, jsHeapUsedMB: 241 },
      { at: 9000, rendered: 18, dropped: 42, jsHeapUsedMB: 268 },
    ],
    errors: [{ at: 9600, name: "context-lost", code: "WEBGL_CONTEXT_LOST", detail: "heap ceiling exceeded" }],
    firstFrameVisual: { focalCoverage: 0.169, nonBlank: true },
    checkpoints: [
      { id: "cp-first-frame", state: "first-frame", at: 1140, focalCoverage: 0.169, alphaEdgeDrift: null },
      { id: "cp-interactive", state: "interactive", at: 1720, focalCoverage: 0.164, alphaEdgeDrift: 0.057 },
    ],
    notes: ["baseline run: the tier router was bypassed and 'high' pinned by the harness"],
    expected: {
      outcome: "fail",
      rootCause: "memory",
      releaseBlocking: "hard block",
      visual: true,
      interaction: false,
      business: false,
    },
  },

  {
    id: "fail-codec-unsupported",
    label: "Required texture codec unavailable",
    why:
      "A capability gap rather than a resource limit. Nothing is slow and " +
      "nothing is full; a decode simply cannot happen on this build.",
    stateId: "no-webgl",
    profileId: "no-webgl",
    runKind: "adaptive",
    servedTier: "low",
    servedPath: "interactive-2d",
    states: /** @type {ExperienceState[]} */ (["boot", "probing", "routing", "loading", "error"]),
    timings: { firstFrameMs: null, interactiveMs: null, durationMs: 2900 },
    assets: [{ id: "tex-low", bytes: 62_000, ok: false, ms: 210, critical: true, error: "DECODE_UNSUPPORTED" }],
    interactions: [],
    frames: [],
    errors: [
      { at: 210, name: "decode-failed", code: "DECODE_UNSUPPORTED", detail: "no WebCodecs and no fallback decoder" },
      { at: 240, name: "fatal", code: "CRITICAL_ASSET_MISSING" },
    ],
    firstFrameVisual: { focalCoverage: null, nonBlank: null },
    checkpoints: [],
    expected: {
      outcome: "fail",
      rootCause: "codec-unsupported",
      releaseBlocking: "hard block",
      visual: false,
      interaction: false,
      business: false,
    },
  },

  {
    id: "inconclusive-truncated",
    label: "Harness died mid-session",
    why:
      "The case where the right answer is 'I do not know'. The trace stops " +
      "after loading with no terminal event and no error of its own. A judge " +
      "that reports 'fail' here is manufacturing a product bug out of a broken " +
      "test rig — and a release gate acting on it blocks a release for nothing.",
    stateId: "mid-android-3g",
    profileId: "mid-android-4g",
    runKind: "adaptive",
    servedTier: "mid",
    servedPath: "interactive-2d",
    states: /** @type {ExperienceState[]} */ (["boot", "probing", "routing", "loading"]),
    timings: { firstFrameMs: null, interactiveMs: null, durationMs: 1800 },
    assets: [{ id: "tex-mid", bytes: 240_000, ok: true, ms: 1420, critical: true }],
    interactions: [],
    frames: [],
    firstFrameVisual: { focalCoverage: null, nonBlank: null },
    checkpoints: [],
    notes: ["trace truncated: the runner lost its CDP connection before session end"],
    expected: {
      outcome: "inconclusive",
      rootCause: "unknown",
      releaseBlocking: "minor",
      visual: false,
      interaction: false,
      business: false,
    },
  },
];

/**
 * Builds a structurally valid `Trace` from a scenario.
 *
 * Every event goes through the same `finalizeTrace` the live runner uses, so
 * the metrics on a synthetic trace are *derived*, not declared — if a scenario
 * claims a 4310ms first frame, that number reaches `metrics.firstFrameMs` by
 * the same code path a real capture would take. Writing the metrics directly
 * would make these fixtures agree with the deriver by construction and test
 * nothing.
 *
 * @param {TraceScenario} scenario
 * @param {ExperienceManifest} manifest
 * @returns {Trace}
 */
export function buildScenarioTrace(scenario, manifest) {
  const synthetic = stateById(scenario.stateId);
  const capability = normalizeSnapshot(synthetic.state);

  const trace = newTrace({
    traceId: `synthetic-${scenario.id}`,
    manifest,
    profileId: scenario.profileId,
    runKind: scenario.runKind,
    emulated: true,
    seed: 0x5eed_0001,
    capability,
    capabilityBucket: bucketOf(capability),
  });
  trace.startedAtIso = FIXED_START_ISO;

  /** @type {TraceEvent[]} */
  const events = [];
  // Offsets are quantised on write (see normalize.js `quantise`): the stored
  // trace sits on bucket centres, so the sub-quantum jitter between two
  // captures of the same session cannot flip the determinism hash at an edge.
  // Hand-authored `at` values stay raw and readable; this is where they become
  // canonical.
  /** @param {number} at @param {string} name @param {TraceEvent["kind"]} kind @param {Record<string, any>} [attributes] */
  const push = (at, name, kind, attributes = {}) =>
    events.push({ tOffsetMs: quantise(at), name, kind, attributes });

  push(0, "boot", "lifecycle", { schemaVersion: trace.schemaVersion });
  push(12, "probe-complete", "lifecycle", {
    gpuTier: capability.gpuTier,
    webglVersion: capability.webglVersion,
    effectiveConnectionType: capability.effectiveConnectionType,
  });
  push(18, "tier-selected", "decision", {
    tier: scenario.servedTier,
    path: scenario.servedPath,
    bypassed: scenario.runKind === "baseline",
  });

  // State transitions, spread across the session so ordering is checkable.
  scenario.states.forEach((state, idx) => {
    const at = stateOffset(scenario, idx);
    push(at, `state:${state}`, "state", {
      from: idx === 0 ? null : scenario.states[idx - 1],
      to: state,
      index: idx,
    });
  });

  for (const asset of scenario.assets) {
    push(asset.ms, `asset:${asset.id}`, "asset", {
      id: asset.id,
      bytes: asset.bytes,
      ok: asset.ok,
      critical: asset.critical ?? true,
      durationMs: asset.ms,
      ...(asset.error ? { error: asset.error } : {}),
    });
  }

  if (scenario.timings.firstFrameMs !== null) {
    push(scenario.timings.firstFrameMs, "first-frame", "lifecycle", {
      nonBlank: scenario.firstFrameVisual.nonBlank,
      focalCoverage: scenario.firstFrameVisual.focalCoverage,
      tier: scenario.servedTier,
    });
  }
  if (scenario.timings.interactiveMs !== null) {
    push(scenario.timings.interactiveMs, "interactive", "lifecycle", { path: scenario.servedPath });
  }

  for (const it of scenario.interactions) {
    // The class label is the whole record: no coordinates, no target text, no
    // value. See PRIVACY.md — `inputClasses` is the redaction boundary.
    push(it.at, `interaction:${it.class}`, "interaction", {
      class: it.class,
      latencyMs: it.latencyMs,
    });
  }

  for (const f of scenario.frames) {
    push(f.at, "frame-sample", "frame", {
      rendered: f.rendered,
      dropped: f.dropped,
      jsHeapUsedMB: f.jsHeapUsedMB,
    });
  }

  for (const err of scenario.errors ?? []) {
    push(err.at, err.name, "error", { code: err.code, ...(err.detail ? { detail: err.detail } : {}) });
  }

  push(scenario.timings.durationMs, "session-end", "lifecycle", {
    reason: scenario.states.at(-1) === "error" ? "fatal" : "complete",
  });

  trace.events = events.sort((a, b) => a.tOffsetMs - b.tOffsetMs);
  trace.states = [...scenario.states];
  trace.servedTier = /** @type {any} */ (scenario.servedTier);
  trace.servedPath = /** @type {any} */ (scenario.servedPath);
  trace.inputClasses = scenario.interactions.map((i) => i.class);
  trace.durationMs = scenario.timings.durationMs;
  trace.notes = [
    "SYNTHETIC: hand-authored fixture, not a captured session. Timings are invented.",
    ...(scenario.notes ?? []),
  ];
  trace.checkpoints = scenario.checkpoints.map((c) => ({
    id: c.id,
    state: c.state,
    tOffsetMs: quantise(c.at),
    screenshotPath: null,
    focalCoverage: c.focalCoverage,
    alphaEdgeDrift: c.alphaEdgeDrift,
  }));

  return finalizeTrace(trace, manifest);
}

/**
 * Spreads state transitions across the session duration. Real transitions are
 * driven by the page; these only need to be monotonic and inside the session.
 *
 * @param {TraceScenario} s
 * @param {number} idx
 */
function stateOffset(s, idx) {
  const anchors = /** @type {Record<string, number | null>} */ ({
    "first-frame": s.timings.firstFrameMs,
    interactive: s.timings.interactiveMs,
  });
  const anchored = anchors[s.states[idx]];
  if (typeof anchored === "number") return anchored;
  const span = Math.max(1, s.states.length - 1);
  return Math.round((s.timings.durationMs * idx) / span * 0.72) + idx;
}

/**
 * @param {ExperienceManifest} manifest
 * @returns {Array<{ scenario: TraceScenario; trace: Trace }>}
 */
export function buildAllScenarioTraces(manifest) {
  return TRACE_SCENARIOS.map((scenario) => ({ scenario, trace: buildScenarioTrace(scenario, manifest) }));
}

/** @param {string} id */
export function scenarioById(id) {
  const found = TRACE_SCENARIOS.find((s) => s.id === id);
  if (!found) throw new Error(`unknown trace scenario "${id}"`);
  return found;
}
