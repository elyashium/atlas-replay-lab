/**
 * The Atlas experience manifest for "Orbital" — an original demo experience.
 *
 * NOT a Flam asset, brand, SDK or integration. See README "No Flam integration".
 *
 * Three quality tiers and three delivery paths (two of them fallbacks from the
 * camera path). The tier decides *how much* to render; the path decides *what
 * kind of* experience is renderable at all given permissions and features.
 *
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 */

import { sha256 } from "../util/hash.js";

/** @type {Omit<ExperienceManifest, "contentHash">} */
const base = {
  schemaVersion: 1,
  id: "orbital",
  version: "1.4.0",
  title: "Orbital — interactive product layer",

  invariants: {
    visual: {
      id: "vis.focal-product-visible",
      description:
        "The focal product layer stays visible and its alpha edges stay stable " +
        "from first frame through checkout; the first frame is never blank.",
      minFocalCoverage: 0.06,
      maxAlphaEdgeDrift: 0.35,
      forbidBlankFirstFrame: true,
    },
    interaction: {
      id: "int.responsive-and-valid",
      description:
        "Taps and swipes stay responsive and every state transition is legal.",
      p95TapResponseMs: 200,
      maxDroppedFrameRatio: 0.2,
      allowedTransitions: [
        ["boot", "probing"],
        ["probing", "routing"],
        ["routing", "loading"],
        ["loading", "first-frame"],
        ["loading", "error"],
        ["first-frame", "interactive"],
        ["first-frame", "degraded"],
        ["interactive", "product-detail"],
        ["interactive", "degraded"],
        ["product-detail", "interactive"],
        ["product-detail", "cart"],
        ["cart", "product-detail"],
        ["cart", "checkout-complete"],
        ["degraded", "interactive"],
        ["degraded", "product-detail"],
        ["degraded", "error"],
      ],
    },
    business: {
      id: "biz.reaches-checkout",
      description:
        "A user can reach the mock checkout-complete state from first " +
        "interaction without entering a broken state.",
      endState: "checkout-complete",
      maxStepsToEndState: 4,
    },
    /**
     * Comfort — see `src/gate/comfort.js`. Additive, and tighter than the
     * generic manifest's because this is our own experience: we know what it
     * draws and what it costs, so there is no excuse for it to stutter. A
     * stranger's app gets the benefit of the doubt; ours does not.
     */
    comfort: {
      id: "cmf.orbital-stays-smooth",
      description:
        "Orbital holds a smooth sustained frame rate through the look-around, " +
        "answers taps inside its interaction budget, and — when XR is refused — " +
        "still completes checkout on the 2D path.",
      sustainedFpsFloor: 50,
      sustainedWindowMs: 5000,
      requireUsableXrFallback: true,
      p95InputToFrameMs: 120,
    },
  },

  budgets: {
    firstFrameMs: 1200,
    timeToInteractiveMs: 2500,
    p95InteractionMs: 200,
    maxDroppedFrameRatio: 0.2,
    maxTransferBytes: 2_200_000,
    maxJsHeapMB: 220,
  },

  tiers: [
    {
      id: "high",
      label: "High — full RGBA layer, 60fps target",
      params: {
        particleCount: 2600,
        textureSize: 1024,
        shaderPasses: 3,
        targetFps: 60,
        perFrameWorkMs: 5.5,
      },
      assets: [
        { id: "tex-hi", url: "assets/generated/orbital-1024.png", kind: "texture", approxBytes: 900_000, critical: true },
        { id: "geo-hi", url: "assets/generated/orbital-geo-high.bin", kind: "geometry", approxBytes: 420_000, critical: true },
      ],
      requires: ["webgl2"],
    },
    {
      id: "mid",
      label: "Mid — reduced particles, 512px texture, 60fps target",
      params: {
        particleCount: 900,
        textureSize: 512,
        shaderPasses: 2,
        targetFps: 60,
        perFrameWorkMs: 2.4,
      },
      assets: [
        { id: "tex-mid", url: "assets/generated/orbital-512.png", kind: "texture", approxBytes: 240_000, critical: true },
        { id: "geo-mid", url: "assets/generated/orbital-geo-mid.bin", kind: "geometry", approxBytes: 96_000, critical: true },
      ],
      requires: ["webgl1"],
    },
    {
      id: "low",
      label: "Low — sprite compositing, 256px texture, 30fps target",
      params: {
        particleCount: 160,
        textureSize: 256,
        shaderPasses: 1,
        targetFps: 30,
        perFrameWorkMs: 0.8,
      },
      assets: [
        { id: "tex-low", url: "assets/generated/orbital-256.png", kind: "texture", approxBytes: 62_000, critical: true },
      ],
      requires: [],
    },
  ],

  fallbackPaths: [
    {
      id: "camera-xr",
      label: "Camera-composited interactive layer",
      requires: ["camera", "webgl1"],
      priority: 0,
      description:
        "Transparent product layer composited over the live camera feed. " +
        "Requires camera permission and a working WebGL context.",
    },
    {
      id: "interactive-2d",
      label: "2D interactive over a static anchor",
      requires: [],
      priority: 1,
      description:
        "Same interaction model and same business end state, composited over a " +
        "static anchor image using Canvas2D. No camera, no WebGL required.",
    },
    {
      id: "static-safe",
      label: "Static-safe poster with DOM interaction",
      requires: [],
      priority: 2,
      description:
        "Poster image plus DOM controls. The business invariant must still " +
        "hold here: the user can still reach checkout.",
    },
  ],

  checkpoints: [
    { id: "cp-first-frame", onState: "first-frame", description: "First painted frame of the product layer." },
    { id: "cp-interactive", onState: "interactive", description: "Experience accepting input." },
    { id: "cp-product-detail", onState: "product-detail", description: "Product detail panel open." },
    { id: "cp-checkout", onState: "checkout-complete", description: "Mock checkout confirmation (business invariant end state)." },
  ],

  privacy: {
    collect: [
      "manifest id/version/hash",
      "capability snapshot (coarse, non-identifying)",
      "capability bucket",
      "asset load timings and byte counts",
      "state transitions",
      "interaction latency (timing only, not coordinates or content)",
      "frame counts and dropped-frame counts",
      "error codes and asset failure counts",
      "redacted input classes (e.g. 'tap:product', never the value)",
    ],
    neverCollect: [
      "raw camera frames",
      "raw audio",
      "raw input text",
      "user agent string",
      "IP address",
      "cookies, storage identifiers or any stable device id",
      "canvas/font/audio fingerprints",
      "precise geolocation",
    ],
    retentionDays: 30,
    redaction: [
      "input-class-only: interactions recorded as a class label plus a latency",
      "coarse-bucketing: capability values bucketed before any aggregation",
      "clock-offsets-only: no wall-clock timestamps inside the event stream",
      "no-free-text: no string field accepts user-authored content",
    ],
    thirdPartyTraceEgress: "off-by-default",
  },
};

/**
 * Content-addresses the manifest. The hash is part of every trace, so a trace
 * can never be replayed against a manifest it was not recorded against.
 *
 * @param {Omit<ExperienceManifest, "contentHash">} m
 * @returns {ExperienceManifest}
 */
export function hashManifest(m) {
  return { ...m, contentHash: sha256(m, 16) };
}

/** @type {ExperienceManifest} */
export const orbitalManifest = hashManifest(base);

/** @type {Omit<ExperienceManifest, "contentHash">} */
export const orbitalManifestBase = base;
