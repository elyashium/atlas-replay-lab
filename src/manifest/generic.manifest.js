/**
 * The manifest for an app we did not write.
 *
 * Orbital's manifest is a *contract the experience is built against*: it
 * declares the tiers Orbital serves, the assets it loads, and the transitions
 * its state machine makes. This one cannot be that, because the visitor's app
 * has never heard of us. So it is a different kind of document with the same
 * shape: **a measuring stick**.
 *
 * Read every field here as "what Atlas requires of any web experience", not as
 * "what this app is configured to do":
 *
 *  - **Tiers** are weight classes we *classify observed delivery into*
 *    (`src/runner/classify-delivery.js`), not settings we apply. Nothing in
 *    this file changes what the visitor's app renders. The ladder still has to
 *    descend monotonically because that is what makes "this app delivered its
 *    heavy class to a low-end device" a statement with meaning.
 *  - **Assets** are per-class payload envelopes, not a list of files. A
 *    generic run's real asset events come from `PerformanceResourceTiming`
 *    inside the probe.
 *  - **Fallback paths** are the three shapes any XR-capable experience can end
 *    up in; `classify-delivery.js` decides which one the app actually reached.
 *  - **Transitions** are the generic spine (`docs/showcase-roadmap.md` Slice
 *    1) driven by `probe-generic.js` and `drive-generic.js`. There is no
 *    `routing` state: Atlas routes Orbital, and observes everyone else.
 *
 * ## Two thresholds that are deliberately loose, and why
 *
 * `minFocalCoverage` is 0.02, not Orbital's 0.06. We know what Orbital puts in
 * the middle of the frame; we know nothing about what this app does. 0.02 says
 * only "something was rendered in the central region", which is the strongest
 * claim available without per-app knowledge.
 *
 * `maxAlphaEdgeDrift` is 0.6, not Orbital's 0.35. The generic driver *drags the
 * camera around on purpose* between checkpoints — that is the whole point of
 * the look-around. A tight drift bound would fail every correctly-working 3D
 * app for doing exactly what it is supposed to do. Drift is still bounded,
 * because a silhouette that changes completely between two checkpoints usually
 * means the scene was torn down rather than turned.
 *
 * Both numbers are gate policy, and gate policy is the thing Slice 2 makes
 * customer-editable and version-hashed into the report. They are defaults, not
 * truths.
 *
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 */

import { hashManifest } from "./atlas-orbital.manifest.js";

/** @type {Omit<ExperienceManifest, "contentHash">} */
const base = {
  schemaVersion: 1,
  id: "generic-url",
  version: "1.0.0",
  title: "Generic web experience — third-party URL under test",

  invariants: {
    visual: {
      id: "vis.renders-something-stable",
      description:
        "The app renders visible content in the central region by the first " +
        "captured frame and keeps rendering through the look-around; the first " +
        "frame is never blank.",
      minFocalCoverage: 0.02,
      maxAlphaEdgeDrift: 0.6,
      forbidBlankFirstFrame: true,
    },
    interaction: {
      id: "int.responds-to-look",
      description:
        "Drag and tap input is answered within a frame budget, dropped frames " +
        "stay bounded during the look-around, and the session follows the " +
        "generic spine.",
      p95TapResponseMs: 200,
      maxDroppedFrameRatio: 0.2,
      allowedTransitions: [
        ["boot", "probing"],
        ["probing", "loading"],
        ["loading", "first-frame"],
        ["loading", "error"],
        ["first-frame", "interactive"],
        ["first-frame", "degraded"],
        ["interactive", "looking"],
        ["interactive", "degraded"],
        ["looking", "xr-session"],
        ["looking", "session-complete"],
        ["looking", "degraded"],
        ["xr-session", "looking"],
        ["xr-session", "session-complete"],
        ["xr-session", "error"],
        ["degraded", "interactive"],
        ["degraded", "looking"],
        ["degraded", "error"],
      ],
    },
    business: {
      id: "biz.completes-a-session",
      description:
        "The app settles, accepts a look-around, resolves its XR attempt one " +
        "way or the other, and reaches session-complete without entering a " +
        "broken state. This is Atlas's invariant, not the app's: a stranger's " +
        "experience has no checkout, so 'the session did what a session is " +
        "for' is what stands in for one.",
      endState: "session-complete",
      maxStepsToEndState: 3,
    },
  },

  /**
   * Budgets sized for deployed WebAR/WebGL reality rather than for Orbital.
   *
   * A production 8th Wall or PlayCanvas build routinely ships 8–15MB and takes
   * seconds to first paint on a throttled 3G profile. Holding a visitor's app
   * to Orbital's 2.2MB / 1.2s would produce a HOLD on every URL, which is a
   * report nobody can act on. These are the defaults the gate starts from.
   */
  budgets: {
    firstFrameMs: 2500,
    timeToInteractiveMs: 6000,
    p95InteractionMs: 200,
    maxDroppedFrameRatio: 0.2,
    maxTransferBytes: 12_000_000,
    maxJsHeapMB: 600,
  },

  tiers: [
    {
      id: "high",
      label: "Heavy — full-payload immersive class",
      params: {
        particleCount: 2600,
        textureSize: 1024,
        shaderPasses: 3,
        targetFps: 60,
        perFrameWorkMs: 5.5,
      },
      assets: [
        {
          id: "payload-heavy",
          url: "(visitor payload — enumerated at runtime from resource timing)",
          kind: "document",
          approxBytes: 12_000_000,
          critical: true,
        },
      ],
      requires: ["webgl2"],
    },
    {
      id: "mid",
      label: "Moderate — reduced-payload interactive class",
      params: {
        particleCount: 900,
        textureSize: 512,
        shaderPasses: 2,
        targetFps: 60,
        perFrameWorkMs: 2.4,
      },
      assets: [
        {
          id: "payload-moderate",
          url: "(visitor payload — enumerated at runtime from resource timing)",
          kind: "document",
          approxBytes: 5_000_000,
          critical: true,
        },
      ],
      requires: ["webgl1"],
    },
    {
      id: "low",
      label: "Light — poster/DOM class, no GPU requirement",
      params: {
        particleCount: 160,
        textureSize: 256,
        shaderPasses: 1,
        targetFps: 30,
        perFrameWorkMs: 0.8,
      },
      assets: [
        {
          id: "payload-light",
          url: "(visitor payload — enumerated at runtime from resource timing)",
          kind: "document",
          approxBytes: 1_500_000,
          critical: true,
        },
      ],
      requires: [],
    },
  ],

  fallbackPaths: [
    {
      id: "camera-xr",
      label: "Immersive / camera-composited",
      requires: ["camera", "webgl1"],
      priority: 0,
      description:
        "The app entered an XR session, or composited over a camera feed. " +
        "Classified from observed XR lifecycle events, not from anything the " +
        "app declares.",
    },
    {
      id: "interactive-2d",
      label: "Interactive without XR",
      requires: [],
      priority: 1,
      description:
        "A live canvas the look-around moved, with no XR session. This is the " +
        "path most apps land on in the matrix, and the one the " +
        "XR-refusal fallback check reads.",
    },
    {
      id: "static-safe",
      label: "Static or DOM-only",
      requires: [],
      priority: 2,
      description:
        "No live canvas of consequence: a poster, an error page, or a DOM " +
        "fallback. Reaching session-complete here is still a pass — reaching " +
        "nothing at all is not.",
    },
  ],

  checkpoints: [
    { id: "cp-first-frame", onState: "first-frame", description: "First frame the harness could photograph." },
    { id: "cp-interactive", onState: "interactive", description: "Page settled and accepting input." },
    { id: "cp-after-look", onState: "looking", description: "After the seeded look-around gestures." },
    { id: "cp-xr", onState: "xr-session", description: "XR entry resolved (session started or refused)." },
    { id: "cp-final", onState: "session-complete", description: "Session closed (business invariant end state)." },
  ],

  privacy: {
    collect: [
      "manifest id/version/hash",
      "capability snapshot (coarse, non-identifying)",
      "capability bucket",
      "asset paths with query strings and fragments stripped, plus byte counts and durations",
      "state transitions along the generic spine",
      "interaction latency (timing only, not coordinates or content)",
      "frame-time durations, frame counts and dropped-frame counts",
      "XR session lifecycle phases and refusal reasons",
      "error codes with truncated, URL-stripped developer diagnostic text",
      "DOM structure counts (element, canvas, button counts — never text content)",
      "redacted input classes (e.g. 'drag:look', never the coordinates)",
    ],
    neverCollect: [
      "raw camera frames",
      "raw audio",
      "raw input text",
      "page text content, headings or DOM attribute values",
      "camera-composited canvas pixels",
      "asset URL query strings or fragments",
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
      "url-query-stripped: every recorded asset path loses its query and fragment, because a signed asset URL is a credential",
      "error-text-scrubbed: diagnostic strings are truncated to 200 characters with URLs and token-shaped runs replaced; only the error *code* is ever summarised for a model",
      "canvas-scalar-only: the page-side non-blank check computes one variance scalar over a 32x32 downsample and discards the buffer in the same tick, and stops entirely if the app ever acquires a camera stream",
      "structure-only-dom: the surface read counts elements; it never reads their text or attributes",
    ],
    thirdPartyTraceEgress: "off-by-default",
  },
};

/**
 * The manifest a `--url` run is recorded against.
 *
 * Hashed with the same `hashManifest` Orbital uses, so a generic trace carries
 * a `manifestHash` and cannot be replayed against different thresholds than it
 * was captured under — which is the only thing that makes a before/after
 * comparison on a visitor's app honest.
 *
 * @type {ExperienceManifest}
 */
export const genericManifest = hashManifest(base);

/** @type {Omit<ExperienceManifest, "contentHash">} */
export const genericManifestBase = base;
