/**
 * Manifest validation, state ordering, and fallback selection.
 *
 * These three are grouped because they are the same claim from three angles:
 * the manifest declares a contract, the state ordering check enforces the part
 * of it that is about sequence, and path resolution enforces the part that is
 * about capability. If any one of them drifts, the tier ladder stops meaning
 * what the README says it means.
 *
 * Every mutation test re-hashes the mutated manifest before validating. Without
 * that, every case would fail on the contentHash check first and pass for the
 * wrong reason — which is the classic way a validator test suite ends up
 * asserting nothing at all.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { orbitalManifest, orbitalManifestBase, hashManifest } from "../src/manifest/atlas-orbital.manifest.js";
import {
  validateManifest,
  validateStateOrdering,
  reachableStates,
  shortestPath,
} from "../src/manifest/validate.js";
import { resolvePath, satisfiedRequirements, bucketOf, normalizeSnapshot } from "../src/capability/buckets.js";

/**
 * Clone the un-hashed base, mutate it, re-hash, validate.
 * @param {(m: any) => void} mutate
 */
function validateVariant(mutate) {
  const m = structuredClone(orbitalManifestBase);
  mutate(m);
  return validateManifest(hashManifest(m));
}

/** @param {any} result @param {string} needle */
function hasError(result, needle) {
  return result.issues.some((/** @type {any} */ i) => i.severity === "error" && i.path.includes(needle));
}

/* ── the shipped manifest ─────────────────────────────────────────────────── */

test("the shipped manifest validates with no issues at all", () => {
  const result = validateManifest(orbitalManifest);
  assert.deepEqual(
    result.issues,
    [],
    `expected a clean manifest, got:\n${result.issues.map((i) => `  ${i.severity} ${i.path}: ${i.message}`).join("\n")}`,
  );
  assert.equal(result.ok, true);
});

test("the content hash actually covers the content", () => {
  const tampered = { ...orbitalManifest, budgets: { ...orbitalManifest.budgets, firstFrameMs: 99_999 } };
  const result = validateManifest(tampered);
  assert.equal(result.ok, false);
  assert.ok(hasError(result, "contentHash"), "a changed budget must invalidate the hash");
});

test("a non-object is rejected without throwing", () => {
  for (const bad of [null, undefined, 42, "manifest", []]) {
    const result = validateManifest(bad);
    // An array is an object, so it gets past the type guard and fails on its
    // missing fields instead. Either way it must not be ok and must not throw.
    assert.equal(result.ok, false, `${JSON.stringify(bad)} should not validate`);
  }
});

/* ── the tier ladder ──────────────────────────────────────────────────────── */

test("the quality ladder must strictly decrease in cost", () => {
  const result = validateVariant((m) => {
    m.tiers.find((/** @type {any} */ t) => t.id === "mid").params.particleCount = 5000;
  });
  assert.ok(hasError(result, "particleCount"), "mid must not be more expensive than high");
});

test("per-frame work must strictly decrease too", () => {
  const result = validateVariant((m) => {
    m.tiers.find((/** @type {any} */ t) => t.id === "low").params.perFrameWorkMs = 9;
  });
  assert.ok(hasError(result, "perFrameWorkMs"));
});

test("the low tier must require nothing, so it is always servable", () => {
  const result = validateVariant((m) => {
    m.tiers.find((/** @type {any} */ t) => t.id === "low").requires = ["webgl2"];
  });
  assert.ok(hasError(result, "tiers[low].requires"));
});

test("a tier may not declare more bytes than the transfer budget", () => {
  const result = validateVariant((m) => {
    m.tiers[0].assets[0].approxBytes = 9_000_000;
  });
  assert.ok(hasError(result, "assets"));
});

test("unknown capability requirements are rejected rather than ignored", () => {
  const result = validateVariant((m) => {
    m.tiers[0].requires = ["webgl2", "holodeck"];
  });
  assert.ok(hasError(result, "requires"));
});

/* ── fallback paths ───────────────────────────────────────────────────────── */

test("the lowest-priority fallback path must have no requirements", () => {
  const result = validateVariant((m) => {
    m.fallbackPaths.find((/** @type {any} */ p) => p.id === "static-safe").requires = ["camera"];
  });
  assert.ok(hasError(result, "fallbackPaths"));
});

test("fallback path priorities must be unique", () => {
  const result = validateVariant((m) => {
    m.fallbackPaths[1].priority = 0;
  });
  assert.ok(hasError(result, "fallbackPaths"));
});

/* ── invariants and reachability ──────────────────────────────────────────── */

test("the business end state must be reachable from boot", () => {
  const result = validateVariant((m) => {
    m.invariants.interaction.allowedTransitions = m.invariants.interaction.allowedTransitions.filter(
      (/** @type {any} */ t) => !(t[0] === "cart" && t[1] === "checkout-complete"),
    );
  });
  assert.ok(hasError(result, "endState"));
});

test("maxStepsToEndState must not be smaller than the shortest real path", () => {
  const result = validateVariant((m) => {
    m.invariants.business.maxStepsToEndState = 1;
  });
  assert.ok(hasError(result, "maxStepsToEndState"));
});

test("a blank first frame can never be declared acceptable", () => {
  const result = validateVariant((m) => {
    m.invariants.visual.forbidBlankFirstFrame = false;
  });
  assert.ok(hasError(result, "forbidBlankFirstFrame"));
});

test("a first-frame checkpoint is mandatory — it is what proves the visual invariant", () => {
  const result = validateVariant((m) => {
    m.checkpoints = m.checkpoints.filter((/** @type {any} */ c) => c.onState !== "first-frame");
  });
  assert.ok(hasError(result, "checkpoints"));
});

test("a checkpoint on an unreachable state is rejected", () => {
  const result = validateVariant((m) => {
    m.checkpoints.push({ id: "cp-nowhere", onState: "nowhere", description: "unreachable" });
  });
  assert.ok(hasError(result, "cp-nowhere"));
});

test("interaction budget disagreement warns but does not block", () => {
  const result = validateVariant((m) => {
    m.invariants.interaction.p95TapResponseMs = 350;
  });
  assert.equal(result.ok, true, "a disagreement is worth flagging, not worth refusing to run");
  assert.ok(result.issues.some((/** @type {any} */ i) => i.severity === "warning"));
});

/* ── privacy ──────────────────────────────────────────────────────────────── */

test("the privacy rule must explicitly forbid raw camera and raw audio", () => {
  for (const drop of ["raw camera frames", "raw audio"]) {
    const result = validateVariant((m) => {
      m.privacy.neverCollect = m.privacy.neverCollect.filter((/** @type {any} */ n) => n !== drop);
    });
    assert.ok(hasError(result, "neverCollect"), `dropping "${drop}" must be an error`);
  }
});

test("a field cannot be both collected and never-collected", () => {
  const result = validateVariant((m) => {
    m.privacy.collect.push("raw audio");
  });
  assert.ok(hasError(result, "privacy"));
});

test("retention beyond 90 days is rejected for this project", () => {
  const result = validateVariant((m) => {
    m.privacy.retentionDays = 365;
  });
  assert.ok(hasError(result, "retentionDays"));
});

/* ── graph helpers ────────────────────────────────────────────────────────── */

test("reachableStates walks the whole declared graph", () => {
  const reachable = reachableStates(orbitalManifest.invariants.interaction.allowedTransitions, "boot");
  for (const state of ["probing", "routing", "loading", "first-frame", "interactive", "cart", "checkout-complete", "degraded", "error"]) {
    assert.ok(reachable.has(/** @type {any} */ (state)), `${state} should be reachable from boot`);
  }
  assert.equal(reachable.has(/** @type {any} */ ("nowhere")), false);
});

test("shortestPath returns null when no path exists", () => {
  assert.equal(shortestPath(orbitalManifest.invariants.interaction.allowedTransitions, "checkout-complete", "boot"), null);
});

test("interactive reaches checkout inside the declared step budget", () => {
  const path = shortestPath(orbitalManifest.invariants.interaction.allowedTransitions, "interactive", "checkout-complete");
  assert.ok(path, "there must be a path");
  assert.ok(
    /** @type {string[]} */ (path).length - 1 <= orbitalManifest.invariants.business.maxStepsToEndState,
    `shortest path was ${/** @type {string[]} */ (path).length - 1} steps`,
  );
});

/* ── state ordering ───────────────────────────────────────────────────────── */

test("the happy path is a legal state sequence", () => {
  const states = /** @type {any} */ ([
    "boot", "probing", "routing", "loading", "first-frame", "interactive", "product-detail", "cart", "checkout-complete",
  ]);
  const result = validateStateOrdering(states, orbitalManifest);
  assert.equal(result.ok, true, JSON.stringify(result.firstIllegal));
});

test("a skipped state is caught, with the index of the first illegal hop", () => {
  const states = /** @type {any} */ (["boot", "probing", "routing", "interactive"]);
  const result = validateStateOrdering(states, orbitalManifest);
  assert.equal(result.ok, false);
  assert.deepEqual(result.firstIllegal, { index: 3, from: "routing", to: "interactive" });
});

test("a repeated state is not a transition and is allowed", () => {
  // The recorder can emit the same state twice (a re-render, a resumed tab).
  // Treating that as illegal would produce false failures on real traces.
  const states = /** @type {any} */ (["boot", "boot", "probing", "probing"]);
  assert.equal(validateStateOrdering(states, orbitalManifest).ok, true);
});

test("an empty or single-element sequence is vacuously legal", () => {
  assert.equal(validateStateOrdering(/** @type {any} */ ([]), orbitalManifest).ok, true);
  assert.equal(validateStateOrdering(/** @type {any} */ (["boot"]), orbitalManifest).ok, true);
});

test("the degraded branch is legal — it is a designed outcome, not a bug", () => {
  const states = /** @type {any} */ (["boot", "probing", "routing", "loading", "first-frame", "degraded", "product-detail", "cart", "checkout-complete"]);
  assert.equal(validateStateOrdering(states, orbitalManifest).ok, true);
});

/* ── fallback selection ───────────────────────────────────────────────────── */

/** @param {Partial<import("../types/atlas.js").CapabilitySnapshot>} over */
const snap = (over) => normalizeSnapshot({ webglVersion: 2, cameraPermission: "granted", ...over });

test("a capable device with camera permission gets the camera path", () => {
  assert.equal(resolvePath(snap({}), orbitalManifest, "high"), "camera-xr");
});

test("a denied camera falls back to 2D, not all the way to static", () => {
  // The interesting property: one missing capability costs one step down the
  // ladder, not a collapse to the floor.
  assert.equal(resolvePath(snap({ cameraPermission: "denied" }), orbitalManifest, "mid"), "interactive-2d");
});

test("no WebGL falls back to 2D even with the camera granted", () => {
  assert.equal(resolvePath(snap({ webglVersion: 0 }), orbitalManifest, "low"), "interactive-2d");
});

test("the static-fallback tier always resolves to the static-safe path", () => {
  // Even on hardware that could do better: static-fallback is a decision about
  // risk, and honouring it must not depend on what the device can do.
  assert.equal(resolvePath(snap({}), orbitalManifest, "static-fallback"), "static-safe");
});

test("satisfiedRequirements reflects exactly the declared capability vocabulary", () => {
  const full = satisfiedRequirements(snap({ webgpuAvailable: true, webcodecsAvailable: true }));
  assert.deepEqual([...full].sort(), ["camera", "motion", "webcodecs", "webgl1", "webgl2", "webgpu"]);

  const none = satisfiedRequirements(
    normalizeSnapshot({ webglVersion: 0, cameraPermission: "denied", reducedMotionPreferred: true }),
  );
  assert.deepEqual([...none], []);
});

test("reduced-motion drops the motion capability", () => {
  assert.equal(satisfiedRequirements(snap({ reducedMotionPreferred: true })).has("motion"), false);
});

/* ── bucketing ────────────────────────────────────────────────────────────── */

test("buckets are coarse enough to be non-identifying", () => {
  const strong = bucketOf(normalizeSnapshot({
    deviceMemoryGB: 16, hardwareConcurrency: 16, webglVersion: 2, gpuTier: "high",
    effectiveConnectionType: "4g", downlinkMbps: 30, rttMs: 20, cameraPermission: "granted",
  }));
  assert.deepEqual(strong, {
    compute: "strong", network: "good", graphics: "accelerated", camera: "usable",
    id: "strong/good/accelerated/usable",
  });

  const weak = bucketOf(normalizeSnapshot({
    deviceMemoryGB: 2, hardwareConcurrency: 4, webglVersion: 1, gpuTier: "low",
    effectiveConnectionType: "3g", downlinkMbps: 1.2, rttMs: 400, cameraPermission: "denied",
  }));
  assert.equal(weak.id, "weak/poor/basic/blocked");
});

test("a device that reports nothing still buckets, using documented defaults", () => {
  const bucket = bucketOf(normalizeSnapshot({}));
  assert.equal(bucket.compute, "weak", "4 cores is the low end of the default");
  assert.equal(bucket.graphics, "none");
  assert.equal(bucket.camera, "blocked");
});

test("normalizeSnapshot drops fields the schema did not ask for", () => {
  // This is the privacy boundary, not a tidiness preference: whatever survives
  // here is what can be shipped to a third-party API by the Jev engine.
  const normalised = normalizeSnapshot(/** @type {any} */ ({
    deviceMemoryGB: 8,
    userAgent: "Mozilla/5.0 (very identifying)",
    ipAddress: "203.0.113.7",
    canvasFingerprint: "abc123",
  }));
  assert.equal("userAgent" in normalised, false);
  assert.equal("ipAddress" in normalised, false);
  assert.equal("canvasFingerprint" in normalised, false);
  assert.equal(normalised.deviceMemoryGB, 8);
});

test("normalizeSnapshot coerces junk to safe defaults instead of trusting it", () => {
  const normalised = normalizeSnapshot(/** @type {any} */ ({
    deviceMemoryGB: "eight",
    webglVersion: 99,
    gpuTier: "ultra",
    cameraPermission: "maybe",
    effectiveConnectionType: "6g",
    viewport: { width: 1280.6, height: "tall" },
  }));
  assert.equal(normalised.deviceMemoryGB, null);
  assert.equal(normalised.webglVersion, 0, "an unknown WebGL version must read as none, never as more");
  assert.equal(normalised.gpuTier, "unknown");
  assert.equal(normalised.cameraPermission, "unavailable");
  assert.equal(normalised.effectiveConnectionType, "unknown");
  assert.deepEqual(normalised.viewport, { width: 1281, height: 0 });
});
