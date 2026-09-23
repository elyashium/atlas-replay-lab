/**
 * Generic ingestion: `atlas matrix --url <href>`.
 *
 * Three separate claims are tested here, and they fail in different ways, which
 * is why they are one file rather than three:
 *
 *  - **`parseTargetUrl` is a security boundary**, not input tidying. Atlas
 *    registers a DOM-reading, resource-enumerating probe against every document
 *    the target loads, so the set of accepted schemes is the set of origins that
 *    script is allowed to run in.
 *  - **`servedTier`/`servedPath` change meaning** between the two modes. On
 *    Orbital they are decisions; here they are measurements, and the tests
 *    pin the distinction that makes the measurement honest — weight class from
 *    bytes alone, delivered shape from what rendered, and the disagreement
 *    between the two surfaced rather than reconciled.
 *  - **Classification must not strand the determinism hash.** This one is a
 *    regression test with a real bug behind it; see its own comment.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { genericManifest } from "../src/manifest/generic.manifest.js";
import { validateManifest } from "../src/manifest/validate.js";
import { newTrace } from "../src/trace/schema.js";
import { finalizeTrace } from "../src/trace/assemble.js";
import { determinismHash } from "../src/trace/normalize.js";
import { bucketOf, normalizeSnapshot } from "../src/capability/buckets.js";
import { classifyDelivery, applyDeliveryClassification } from "../src/runner/classify-delivery.js";
import { parseTargetUrl } from "../src/runner/run-matrix.js";
import { GENERIC_PROFILES, XR_PROFILES, PROFILES, profileById } from "../src/runner/profiles.js";
import { xrStubNote, POSE_SCRIPT_ID, buildXrStubScript } from "../src/runner/xr-stub.js";

const manifest = genericManifest;

/* The generic manifest's declared envelopes, so the tests move with it rather
   than pinning today's megabytes. */
const envelope = /** @param {string} id */ (id) => {
  const tier = manifest.tiers.find((t) => t.id === id);
  assert.ok(tier, `the generic manifest should declare a '${id}' tier`);
  return tier.assets.reduce((sum, a) => sum + a.approxBytes, 0);
};

/**
 * A finalized generic trace. `finalizeTrace` is called because
 * `classifyDelivery` reads `trace.metrics`, which only exists once metrics have
 * been derived — the same order the runner uses.
 *
 * @param {{
 *   bytes?: number;
 *   requests?: number;
 *   framesRendered?: number;
 *   xrPhases?: string[];
 *   cameraAcquired?: boolean;
 *   emulated?: boolean;
 * }} [over]
 */
function genericTrace(over = {}) {
  const capability = normalizeSnapshot({ webglVersion: 2, cameraPermission: "granted", hardwareConcurrency: 8 });
  const trace = newTrace({
    traceId: "g-1",
    manifest,
    profileId: "mid-android-4g",
    runKind: "adaptive",
    emulated: over.emulated ?? true,
    seed: 0x0b17a1,
    capability,
    capabilityBucket: bucketOf(capability),
  });

  trace.states = ["boot", "probing", "loading", "first-frame", "interactive", "looking", "session-complete"];
  trace.events = [
    { kind: "lifecycle", name: "first-frame", tOffsetMs: 900, attributes: { nonBlank: true } },
    { kind: "lifecycle", name: "interactive", tOffsetMs: 1800, attributes: {} },
  ];

  // One asset event per request, splitting the byte total evenly. Request count
  // is derived from the number of asset events, so it cannot be set directly.
  const requests = over.requests ?? 4;
  const bytes = over.bytes ?? envelope("high");
  for (let i = 0; i < requests; i++) {
    trace.events.push({
      kind: "asset",
      name: `asset:${i}`,
      tOffsetMs: 200 + i * 100,
      attributes: { bytes: Math.round(bytes / requests), ok: true },
    });
  }

  const framesRendered = over.framesRendered ?? 300;
  trace.events.push({
    kind: "frame",
    name: "frames",
    tOffsetMs: 4000,
    attributes: { rendered: framesRendered, dropped: 6 },
  });

  if (over.cameraAcquired) {
    trace.events.push({ kind: "lifecycle", name: "camera-stream-acquired", tOffsetMs: 1200, attributes: {} });
  }
  for (const phase of over.xrPhases ?? []) {
    trace.xrSessionEvents.push({ tOffsetMs: 2000, mode: "immersive-ar", phase, error: phase === "session-refused" ? "NotAllowedError" : null });
  }

  trace.frameTimes = Array.from({ length: 120 }, (_, i) => 16 + (i % 7));
  trace.durationMs = 5000;
  return finalizeTrace(trace, manifest);
}

/** A DOM surface read describing a full-bleed canvas. */
const liveSurface = { visibleCanvasCount: 1, canvasViewportRatio: 0.92 };
/** A DOM surface read describing a page with nothing rendered. */
const deadSurface = { visibleCanvasCount: 0, canvasViewportRatio: 0 };

/* ── the target URL is a security boundary ────────────────────────────────── */

test("parseTargetUrl accepts http and https and nothing else", () => {
  assert.equal(parseTargetUrl("https://example.com/ar").href, "https://example.com/ar");
  assert.equal(parseTargetUrl("http://127.0.0.1:8080/x").protocol, "http:");

  // Each of these would run Atlas's injected probe — which reads the DOM and
  // enumerates resource timing — inside an origin it has no business being in,
  // or would make the "page" a code fragment typed on the command line.
  for (const bad of [
    "file:///C:/Users/someone/secrets.html",
    "javascript:fetch('/x')",
    "data:text/html,<script>1</script>",
    "chrome://settings",
    "about:blank",
  ]) {
    assert.throws(() => parseTargetUrl(bad), /must be http: or https:/, `should refuse ${bad}`);
  }
});

test("parseTargetUrl says what a scheme-less argument is missing", () => {
  // The common typo, and the error has to name the fix rather than print
  // "Invalid URL" — a bare host is what people type from memory.
  assert.throws(() => parseTargetUrl("example.com/ar"), /Include the scheme/);
  assert.throws(() => parseTargetUrl(""), /is not a URL/);
});

/* ── weight class comes from bytes, and only from bytes ───────────────────── */

test("weight class is measured from transfer bytes, not from frame cost", () => {
  // The same 12MB payload on a fast device and on a slow one. Classification
  // must not move: a 12MB build is 12MB everywhere, and letting frame time in
  // would report "this app is heavy" when the finding is "this device is slow".
  const fast = classifyDelivery(genericTrace({ bytes: envelope("high") }), manifest, liveSurface);
  const slow = classifyDelivery(
    genericTrace({ bytes: envelope("high"), framesRendered: 70 }),
    manifest,
    liveSurface,
  );

  assert.equal(fast.tier, "high");
  assert.equal(slow.tier, "high");
  // Render cost is still measured — it is just quarantined, and labelled.
  assert.equal(slow.evidence.renderLoad.kind, "device-dependent");
  assert.ok(slow.evidence.renderLoad.p95FrameTimeMs !== null);
});

test("class boundaries are geometric, so a mid payload is not filed as light", () => {
  // The arithmetic midpoint of 12MB and 1.5MB is 6.75MB, which would file most
  // real WebAR builds as light. The geometric mean of the mid and high
  // envelopes is the boundary that matters here.
  const midHigh = Math.sqrt(envelope("high") * envelope("mid"));
  const justUnder = classifyDelivery(genericTrace({ bytes: Math.round(midHigh * 0.95) }), manifest, liveSurface);
  const justOver = classifyDelivery(genericTrace({ bytes: Math.round(midHigh * 1.05) }), manifest, liveSurface);

  assert.equal(justUnder.tier, "mid");
  assert.equal(justOver.tier, "high");
});

test("zero attributable bytes is reported as unmeasurable, not as a poster", () => {
  // Cross-origin assets without Timing-Allow-Origin are invisible to resource
  // timing, which is by far the most common cause of a 0-byte total on a real
  // app. Calling that a deliberate static fallback would be a measurement
  // artefact dressed up as a finding.
  const result = classifyDelivery(genericTrace({ bytes: 0, requests: 3 }), manifest, liveSurface);

  assert.equal(result.tier, "static-fallback");
  assert.match(result.tierBasis, /could not be measured/);
  assert.ok(
    result.notes.some((n) => /Timing-Allow-Origin/.test(n)),
    "the reason the bytes are invisible has to be in the report, not just the code",
  );
});

test("a light payload with nothing rendered is a poster", () => {
  const result = classifyDelivery(
    genericTrace({ bytes: 80_000, framesRendered: 0 }),
    manifest,
    deadSurface,
  );
  assert.equal(result.tier, "static-fallback");
  assert.equal(result.path, "static-safe");
});

/* ── delivered shape, and the disagreement worth surfacing ────────────────── */

test("a heavy payload that renders nothing is a failed heavy delivery, not a fallback", () => {
  // The distinction the whole module exists for. `static-safe` is a legitimate
  // choice; downloading twelve megabytes and showing a blank page is not a
  // choice, and reporting it as graceful degradation would launder a failure.
  const result = classifyDelivery(
    genericTrace({ bytes: envelope("high"), framesRendered: 2 }),
    manifest,
    deadSurface,
  );

  assert.equal(result.tier, "high", "the bytes arrived, so the weight class stands");
  assert.equal(result.path, "static-safe", "and nothing of consequence rendered");
  assert.ok(
    result.notes.some((n) => /heavy delivery that failed/.test(n)),
    "the disagreement between tier and path must be stated",
  );
});

test("the path says which of the three live-canvas conditions failed", () => {
  // "No live canvas" is not actionable. "A canvas existed but covered 1% of the
  // viewport" tells someone what to go and look at.
  const tiny = classifyDelivery(
    genericTrace({ framesRendered: 400 }),
    manifest,
    { visibleCanvasCount: 2, canvasViewportRatio: 0.01 },
  );
  assert.equal(tiny.path, "static-safe");
  assert.match(tiny.pathBasis, /2 canvas\(es\) present/);
  assert.match(tiny.pathBasis, /1%/);

  const stalled = classifyDelivery(genericTrace({ framesRendered: 12 }), manifest, liveSurface);
  assert.equal(stalled.path, "static-safe");
  assert.match(stalled.pathBasis, /12 frames rendered/);

  const absent = classifyDelivery(genericTrace(), manifest, null);
  assert.equal(absent.path, "static-safe");
  assert.match(absent.pathBasis, /no DOM surface read/);
});

test("an XR session or a camera stream puts the session on the camera-xr path", () => {
  const xr = classifyDelivery(genericTrace({ xrPhases: ["session-start"] }), manifest, liveSurface);
  assert.equal(xr.path, "camera-xr");
  assert.equal(xr.evidence.xrSessionStarted, true);

  const cam = classifyDelivery(genericTrace({ cameraAcquired: true }), manifest, liveSurface);
  assert.equal(cam.path, "camera-xr");
  assert.match(cam.pathBasis, /camera stream/);
});

test("an XR session on an emulated run always carries the stub disclaimer", () => {
  // Non-negotiable: a scripted pose is a scripted pose, and a report that said
  // "XR works" on the strength of one would be lying.
  const result = classifyDelivery(genericTrace({ xrPhases: ["session-start"] }), manifest, liveSurface);
  assert.ok(
    result.notes.some((n) => /injected navigator.xr stub/.test(n)),
    "every emulated XR session must disclose the stub",
  );

  // …and not on a real-device run, where the disclaimer would be false.
  const real = classifyDelivery(
    genericTrace({ xrPhases: ["session-start"], emulated: false }),
    manifest,
    liveSurface,
  );
  assert.ok(!real.notes.some((n) => /injected navigator.xr stub/.test(n)));
});

test("a refused XR session records the refusal and where the app landed", () => {
  const result = classifyDelivery(
    genericTrace({ xrPhases: ["session-requested", "session-refused"] }),
    manifest,
    liveSurface,
  );
  assert.equal(result.path, "interactive-2d", "a refusal that falls back to 2D is the good outcome");
  assert.ok(result.notes.some((n) => /XR entry was refused .*NotAllowedError/.test(n)));
});

/* ── the hash must not be stranded ────────────────────────────────────────── */

test("applying a classification re-hashes the trace", () => {
  // Regression test. `servedTier` and `servedPath` are inside
  // `normalizeTrace`'s field set, so writing them after `finalizeTrace` has run
  // leaves a `determinismHash` computed over `servedTier: null` sitting on a
  // trace whose servedTier is "high". The first replay of that trace would
  // recompute the hash honestly, disagree, and report a divergence that never
  // happened — which is worse than having no replay at all, because it makes
  // the project's one load-bearing claim unfalsifiable.
  const trace = genericTrace({ bytes: envelope("high") });
  const before = trace.determinismHash;
  assert.notEqual(before, "", "the fixture should arrive already finalized");

  const result = applyDeliveryClassification(trace, manifest, liveSurface);

  assert.equal(trace.servedTier, result.tier);
  assert.equal(trace.servedPath, result.path);
  assert.notEqual(trace.determinismHash, before, "writing causal fields must move the hash");
  assert.equal(
    trace.determinismHash,
    determinismHash(trace),
    "the stored hash must match what a replay would recompute",
  );
});

test("classification explains itself in the trace notes", () => {
  // The report quotes these. A tier with no stated basis is a number someone
  // has to take on trust, which is the opposite of the point.
  const trace = genericTrace({ bytes: envelope("mid") });
  applyDeliveryClassification(trace, manifest, liveSurface);

  assert.ok(trace.notes.some((n) => n.startsWith("observed delivery: tier 'mid' —")));
  assert.ok(trace.notes.some((n) => n.startsWith("observed path: 'interactive-2d' —")));
});

/* ── the manifest and the profile set ────────────────────────────────────── */

test("the generic manifest validates and declares the checkpoints the driver captures", () => {
  const validation = validateManifest(manifest);
  assert.equal(
    validation.ok,
    true,
    validation.issues.filter((i) => i.severity === "error").map((i) => `${i.path}: ${i.message}`).join("; "),
  );

  // The driver announces these by name; a manifest that does not declare them
  // would make every capture report "screenshot for unknown checkpoint".
  for (const id of ["cp-first-frame", "cp-interactive", "cp-after-look", "cp-xr", "cp-final"]) {
    assert.ok(manifest.checkpoints.some((c) => c.id === id), `missing checkpoint ${id}`);
  }
});

test("the generic manifest's visual thresholds are looser than Orbital's, deliberately", () => {
  // We know what Orbital draws and can demand 6% focal coverage of it. We know
  // nothing about a stranger's app, and the driver drags the viewport around on
  // purpose, so holding it to Orbital's numbers would manufacture failures.
  assert.ok(manifest.invariants.visual.minFocalCoverage < 0.06);
  assert.ok(manifest.invariants.visual.maxAlphaEdgeDrift > 0.35);
});

test("the XR pair is opt-in for Orbital and default for --url", () => {
  // Adding two profiles to Orbital's six would change every stored baseline and
  // the gate's pass/fail denominator, for an experience with no XR entry point.
  assert.equal(PROFILES.length, 6);
  assert.ok(!PROFILES.some((p) => p.id.startsWith("xr-")));
  for (const p of XR_PROFILES) {
    assert.ok(GENERIC_PROFILES.some((g) => g.id === p.id), `${p.id} should be in the --url default set`);
    assert.ok(profileById(p.id), `${p.id} should be nameable via --profile`);
  }
});

test("xr-denied blocks a release and xr-granted does not", () => {
  // The asymmetry is the point. A refusal is an ordinary browser response that
  // needs no stub fidelity to be real — the promise rejects, and the app either
  // recovers to something usable or it does not. A *successful* session against
  // a synthetic device supports no claim strong enough to hold a release on.
  assert.equal(profileById("xr-denied").critical, true);
  assert.equal(profileById("xr-granted").critical, false);
});

test("the XR stub discloses itself in a note that names the pose script", () => {
  for (const grant of /** @type {const} */ (["granted", "denied"])) {
    const note = xrStubNote(grant);
    assert.match(note, /stub|synthetic|injected/i);
    const script = buildXrStubScript({ seed: 0x0b17a1, grant });
    assert.ok(script.includes(POSE_SCRIPT_ID), "the injected script should carry its pose-script id");
  }
});
