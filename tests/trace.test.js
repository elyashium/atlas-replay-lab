/**
 * Trace assembly, metric derivation, and determinism.
 *
 * The determinism hash is the load-bearing claim of this whole project: replay
 * only proves anything if "the same session" is a decidable question. So these
 * tests are mostly about what the hash must ignore and what it must never
 * ignore — the two halves of ADR-0004.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { orbitalManifest } from "../src/manifest/atlas-orbital.manifest.js";
import { newTrace, deriveMetrics, percentile, round4, TIME_QUANTUM_MS, TRACE_SCHEMA_VERSION } from "../src/trace/schema.js";
import { normalizeTrace, determinismHash, causalHash, firstDivergence } from "../src/trace/normalize.js";
import { assembleTrace, finalizeTrace, applyFirstFrameVisual } from "../src/trace/assemble.js";
import { bucketOf, normalizeSnapshot } from "../src/capability/buckets.js";
import { TRACE_SCENARIOS, buildScenarioTrace } from "../src/decision/fixtures/traces.js";

const manifest = orbitalManifest;

/** @param {any} over */
function blankTrace(over = {}) {
  const capability = normalizeSnapshot({ webglVersion: 2, cameraPermission: "granted", hardwareConcurrency: 8 });
  const t = newTrace({
    traceId: "t-1",
    manifest,
    profileId: "test",
    runKind: "adaptive",
    emulated: true,
    seed: 0x5eed_0001,
    capability,
    capabilityBucket: bucketOf(capability),
  });
  return Object.assign(t, over);
}

/** @param {string} kind @param {string} name @param {number} tOffsetMs @param {any} attributes */
const ev = (kind, name, tOffsetMs, attributes = {}) => ({ kind, name, tOffsetMs, attributes });

/* ── metric derivation ────────────────────────────────────────────────────── */

test("metrics are derived from the event stream, never posted by the page", () => {
  const trace = blankTrace({
    states: ["boot", "probing", "routing", "loading", "first-frame", "interactive", "product-detail", "cart", "checkout-complete"],
    events: [
      ev("lifecycle", "first-frame", 812, { nonBlank: true }),
      ev("lifecycle", "interactive", 1640, {}),
      ev("asset", "asset:core", 300, { bytes: 120_000, ok: true }),
      ev("asset", "asset:tex", 520, { bytes: 380_000, ok: true }),
      ev("asset", "asset:missing", 600, { bytes: 0, ok: false }),
      ev("interaction", "tap", 1800, { latencyMs: 40 }),
      ev("interaction", "tap", 2100, { latencyMs: 90 }),
      ev("interaction", "tap", 2400, { latencyMs: 300 }),
      ev("frame", "frames", 3000, { rendered: 180, dropped: 20, jsHeapUsedMB: 88 }),
    ],
  });

  const m = deriveMetrics(trace, manifest);
  assert.equal(m.firstFrameMs, 812);
  assert.equal(m.timeToInteractiveMs, 1640);
  assert.equal(m.transferBytes, 500_000);
  assert.equal(m.assetFailures, 1);
  assert.equal(m.interactionCount, 3);
  assert.equal(m.framesRendered, 180);
  assert.equal(m.framesDropped, 20);
  assert.equal(m.droppedFrameRatio, 0.1);
  assert.equal(m.jsHeapUsedMB, 88);
  assert.equal(m.reachedEndState, true);
  assert.equal(m.firstFrameNonBlank, true);
  // interactive is at index 5, checkout-complete at index 8.
  assert.equal(m.stepsToEndState, 3);
});

test("an absent measurement reads as null, never as zero", () => {
  // Zero would silently pass every budget check. This distinction is the reason
  // EMPTY_METRICS exists rather than a zero-filled object.
  const m = deriveMetrics(blankTrace(), manifest);
  assert.equal(m.firstFrameMs, null);
  assert.equal(m.timeToInteractiveMs, null);
  assert.equal(m.p95InteractionMs, null);
  assert.equal(m.droppedFrameRatio, null);
  assert.equal(m.jsHeapUsedMB, null);
  assert.equal(m.firstFrameNonBlank, null);
  assert.equal(m.stepsToEndState, null);
  assert.equal(m.reachedEndState, false);
  // Counters, unlike measurements, legitimately start at zero.
  assert.equal(m.transferBytes, 0);
  assert.equal(m.interactionCount, 0);
});

test("a first frame the page could not judge stays null until pixels say otherwise", () => {
  const trace = blankTrace({ events: [ev("lifecycle", "first-frame", 500, { nonBlank: null })] });
  assert.equal(deriveMetrics(trace, manifest).firstFrameNonBlank, null);

  // The runner measures it from the decoded screenshot; below the manifest's
  // focal-coverage floor is a blank frame regardless of the timing.
  const judged = applyFirstFrameVisual(trace, manifest, { nonBlankness: 0.01, focalCoverage: 0.001, edgeEnergy: 0.0 });
  assert.equal(judged.metrics.firstFrameNonBlank, false);
  assert.equal(judged.metrics.firstFrameMs, 500, "judging blankness must not move the timing");
});

test("the heap figure is the most recent one, not the first", () => {
  const trace = blankTrace({
    events: [
      ev("frame", "frames", 1000, { rendered: 60, dropped: 0, jsHeapUsedMB: 40 }),
      ev("frame", "frames", 2000, { rendered: 60, dropped: 0, jsHeapUsedMB: 210 }),
    ],
  });
  assert.equal(deriveMetrics(trace, manifest).jsHeapUsedMB, 210);
});

test("percentile handles the degenerate sizes without throwing", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(percentile([1, 2], 0), 1);
  assert.equal(percentile([1, 2], 1), 2);
  const ten = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const p95 = percentile(ten, 0.95);
  assert.ok(p95 !== null && p95 >= 90 && p95 <= 100, `p95 was ${p95}`);
});

test("round4 keeps four places and does not emit -0", () => {
  assert.equal(round4(0.123456), 0.1235);
  assert.equal(Object.is(round4(-0.00001), -0), false, "-0 serialises as 0 but compares oddly; avoid it");
});

/* ── assembly and coercion ────────────────────────────────────────────────── */

test("assembleTrace never trusts the page's own numbers", () => {
  const trace = assembleTrace(
    {
      traceId: "posted",
      profileId: "low-cpu-3g",
      runKind: "adaptive",
      seed: 42,
      capability: { webglVersion: 2, cameraPermission: "granted", userAgent: "should be dropped" },
      states: ["boot", "probing"],
      events: [ev("lifecycle", "first-frame", 900, { nonBlank: true })],
      // A page claiming its own metrics must have no effect at all.
      metrics: { firstFrameMs: 1, reachedEndState: true },
      determinismHash: "attacker-supplied",
    },
    { manifest },
  );
  assert.equal(trace.metrics.firstFrameMs, 900, "metrics are derived, not accepted");
  assert.equal(trace.metrics.reachedEndState, false);
  assert.notEqual(trace.determinismHash, "attacker-supplied");
  assert.equal(/** @type {any} */ (trace.capability).userAgent, undefined);
});

test("a junk payload assembles into a structurally complete trace", () => {
  // The recorder must survive a malformed POST: an exception here would lose
  // the trace, and a lost trace reads as "no evidence" at the gate.
  for (const junk of [null, undefined, 42, "nope", [], {}]) {
    const trace = assembleTrace(junk, { manifest });
    assert.equal(trace.schemaVersion, TRACE_SCHEMA_VERSION);
    assert.deepEqual(trace.states, []);
    assert.deepEqual(trace.events, []);
    assert.equal(typeof trace.determinismHash, "string");
    assert.ok(trace.traceId.length > 0, "an unidentified trace still gets an id");
  }
});

test("malformed events are dropped rather than poisoning the stream", () => {
  const trace = assembleTrace(
    {
      events: [
        ev("lifecycle", "first-frame", 100, {}),
        { kind: "not-a-kind", name: "x", tOffsetMs: 1 },
        { kind: "lifecycle", tOffsetMs: 1 },
        null,
        "string",
      ],
    },
    { manifest },
  );
  assert.equal(trace.events.length, 1);
  assert.equal(trace.events[0].name, "first-frame");
});

test("nested attributes are dropped, keeping the bag flat", () => {
  // A flat bag is what makes the OTLP export and the normalisation allow-list
  // meaningful; a nested object would slip past both.
  const trace = assembleTrace(
    { events: [ev("interaction", "tap", 10, { latencyMs: 20, nested: { a: 1 }, list: [1, 2], nan: NaN })] },
    { manifest },
  );
  const attrs = trace.events[0].attributes;
  assert.equal(attrs.latencyMs, 20);
  assert.equal("nested" in attrs, false);
  assert.equal("list" in attrs, false);
  assert.equal(attrs.nan, null, "a non-finite number becomes an explicit null");
});

test("oversized inputs are capped instead of exhausting memory", () => {
  const trace = assembleTrace(
    {
      states: Array.from({ length: 5000 }, () => "boot"),
      events: Array.from({ length: 50_000 }, (_, i) => ev("frame", "frames", i, { rendered: 1 })),
      notes: Array.from({ length: 500 }, (_, i) => `note ${i}`),
    },
    { manifest },
  );
  assert.equal(trace.states.length, 512);
  assert.equal(trace.events.length, 20_000);
  assert.ok(trace.notes.length <= 64);
});

test("a long attribute string is truncated, not rejected", () => {
  const trace = assembleTrace(
    { events: [ev("error", "boom", 1, { message: "x".repeat(5000) })] },
    { manifest },
  );
  assert.equal(String(trace.events[0].attributes.message).length, 256);
});

test("an unknown runKind falls back to production rather than inventing one", () => {
  assert.equal(assembleTrace({ runKind: "sneaky" }, { manifest }).resource["atlas.run.kind"], "production");
  assert.equal(assembleTrace({ runKind: "replay" }, { manifest }).resource["atlas.run.kind"], "replay");
});

/* ── determinism ──────────────────────────────────────────────────────────── */

const scenario = /** @type {any} */ (TRACE_SCENARIOS.find((s) => s.id === "pass-high-desktop"));

test("the determinism hash survives a JSON round trip", () => {
  // If it did not, every hash written to disk would differ from the one computed
  // in memory, and replay would report a false divergence on every run.
  const trace = buildScenarioTrace(scenario, manifest);
  const roundTripped = JSON.parse(JSON.stringify(trace));
  assert.equal(determinismHash(roundTripped), determinismHash(trace));
  assert.equal(trace.determinismHash, determinismHash(trace), "finalizeTrace must store the hash it computes");
});

test("the hash ignores wall-clock time, trace identity, and heap", () => {
  // These three differ on every real run. A hash sensitive to them would make
  // "reproduced" unachievable and the replay check decorative.
  const a = buildScenarioTrace(scenario, manifest);
  const b = finalizeTrace(
    Object.assign(JSON.parse(JSON.stringify(a)), {
      traceId: "a-completely-different-id",
      startedAtIso: "2031-01-01T00:00:00.000Z",
      durationMs: a.durationMs + 5000,
    }),
    manifest,
  );
  assert.equal(b.determinismHash, a.determinismHash);
});

test("the hash ignores frame counters but not the events that carry meaning", () => {
  const a = buildScenarioTrace(scenario, manifest);
  const withFrames = JSON.parse(JSON.stringify(a));
  withFrames.events.push({ kind: "frame", name: "frames", tOffsetMs: 9999, attributes: { rendered: 3, dropped: 1 } });
  assert.equal(determinismHash(withFrames), a.determinismHash, "sampled frame counters are performance, not causality");

  const withLifecycle = JSON.parse(JSON.stringify(a));
  withLifecycle.events.push({ kind: "lifecycle", name: "surprise", tOffsetMs: 9999, attributes: {} });
  assert.notEqual(determinismHash(withLifecycle), a.determinismHash);
});

test("the hash is sensitive to reordering, which is the whole point", () => {
  const a = buildScenarioTrace(scenario, manifest);
  const swapped = JSON.parse(JSON.stringify(a));
  [swapped.states[3], swapped.states[4]] = [swapped.states[4], swapped.states[3]];
  assert.notEqual(determinismHash(swapped), a.determinismHash);
});

test("sub-quantum jitter does not change the hash, but a real delay does", () => {
  const a = buildScenarioTrace(scenario, manifest);

  const jittered = JSON.parse(JSON.stringify(a));
  // Nudge every event by less than half a quantum: it must land on the same
  // bucket. Real browsers never reproduce timings to the millisecond, and a
  // hash that demanded it would never match twice.
  for (const e of jittered.events) e.tOffsetMs += TIME_QUANTUM_MS / 2 - 1;
  assert.equal(determinismHash(jittered), a.determinismHash);

  const delayed = JSON.parse(JSON.stringify(a));
  for (const e of delayed.events) e.tOffsetMs += 400;
  assert.notEqual(determinismHash(delayed), a.determinismHash, "a 400ms shift is a real difference");
});

test("causalHash is exactly the timing-blind twin", () => {
  const a = buildScenarioTrace(scenario, manifest);
  const delayed = JSON.parse(JSON.stringify(a));
  for (const e of delayed.events) e.tOffsetMs += 400;
  for (const c of delayed.checkpoints) c.tOffsetMs += 400;

  assert.notEqual(determinismHash(delayed), determinismHash(a), "timing differs");
  assert.equal(causalHash(delayed), causalHash(a), "structure does not");
});

test("causalHash still notices a structural change", () => {
  const a = buildScenarioTrace(scenario, manifest);
  const altered = JSON.parse(JSON.stringify(a));
  altered.servedTier = "low";
  assert.notEqual(causalHash(altered), causalHash(a));
});

test("normalizeTrace keeps only the allow-listed attributes", () => {
  // The privacy boundary again: whatever survives normalisation is what gets
  // hashed, written to disk, and shipped in an example trace.
  const trace = blankTrace({
    events: [ev("interaction", "tap", 100, { latencyMs: 40, targetId: "buy-button", secretUserEmail: "a@b.c" })],
  });
  const n = normalizeTrace(trace);
  assert.equal("secretUserEmail" in n.events[0].attributes, false);
});

test("every scenario trace hashes distinctly", () => {
  // A collision would mean two different failures are indistinguishable to the
  // replay check.
  const seen = new Map();
  for (const s of TRACE_SCENARIOS) {
    const h = determinismHash(buildScenarioTrace(s, manifest));
    assert.equal(seen.has(h), false, `${s.id} hashes identically to ${seen.get(h)}`);
    seen.set(h, s.id);
  }
});

test("building the same scenario twice produces identical bytes", () => {
  for (const s of TRACE_SCENARIOS) {
    assert.deepEqual(buildScenarioTrace(s, manifest), buildScenarioTrace(s, manifest), `${s.id} is not reproducible`);
  }
});

/* ── divergence reporting ─────────────────────────────────────────────────── */

test("firstDivergence returns null for identical traces", () => {
  const a = buildScenarioTrace(scenario, manifest);
  assert.equal(firstDivergence(a, JSON.parse(JSON.stringify(a))), null);
});

test("firstDivergence names the index and the kind", () => {
  const a = buildScenarioTrace(scenario, manifest);
  const b = JSON.parse(JSON.stringify(a));
  b.states[4] = "degraded";
  const d = firstDivergence(a, b);
  assert.ok(d, "a changed state must be reported");
  assert.equal(/** @type {any} */ (d).kind, "states");
  assert.equal(/** @type {any} */ (d).index, 4);
  assert.ok(/** @type {any} */ (d).message.length > 0, "a divergence with no explanation is not useful to a reader");
});

test("firstDivergence reports the earliest difference, not an arbitrary one", () => {
  const a = buildScenarioTrace(scenario, manifest);
  const b = JSON.parse(JSON.stringify(a));
  b.states[2] = "degraded";
  b.states[5] = "degraded";
  assert.equal(/** @type {any} */ (firstDivergence(a, b)).index, 2);
});

test("firstDivergence tolerates traces of different lengths", () => {
  const a = buildScenarioTrace(scenario, manifest);
  const b = JSON.parse(JSON.stringify(a));
  b.states = b.states.slice(0, 3);
  const d = firstDivergence(a, b);
  assert.ok(d, "a truncated trace is a divergence, not a crash");
  assert.equal(/** @type {any} */ (d).kind, "states");
});
