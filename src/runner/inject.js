/**
 * Builds the bootstrap script injected into every page before its own modules
 * run (`Page.addScriptToEvaluateOnNewDocument`).
 *
 * This is the *only* channel through which the runner influences the page. The
 * experience code has no test hooks, no `if (isCiRun)` branches and no
 * knowledge that a runner exists — it reads an optional `__ATLAS__` object and
 * behaves deterministically by default when there is none. Keeping the seam
 * here rather than inside the experience is what makes the traces captured in
 * the matrix the same kind of artefact as a trace captured from a human's
 * session.
 *
 * What the bootstrap does:
 *
 *  - Installs the seeded RNG the scene layout and the mock order id draw from.
 *  - Installs a *separate* seeded stream over `Math.random`, so that if any
 *    code path ever reaches for it, determinism does not quietly break. The two
 *    streams are separate on purpose: a stray `Math.random()` must not shift
 *    the particle layout.
 *  - Hands over the hardware hints the capability probe reads, because a
 *    desktop Chromium cannot report 2GB of RAM and four slow cores no matter
 *    how hard it is throttled. This is the emulation boundary, and it is the
 *    reason every trace from this path is stamped `atlas.emulated: true`.
 *  - Optionally removes WebGL, which is the honest way to emulate a
 *    blocklisted device: `getContext` returns null exactly as it does there.
 *  - Optionally forces a tier, which is how the baseline ("no routing at all")
 *    half of the failure story is produced.
 */

/**
 * @typedef {object} InjectConfig
 * @property {number} seed
 * @property {string} traceId
 * @property {string} profileId
 * @property {"baseline" | "adaptive" | "replay" | "production"} runKind
 * @property {boolean} emulated
 * @property {Record<string, unknown>} [probeOverrides]
 * @property {string | null} [forceTier]
 * @property {boolean} [disableWebgl]
 */

/**
 * @param {InjectConfig} opts
 * @returns {string}
 */
export function buildInjectedScript(opts) {
  const config = {
    seed: opts.seed >>> 0,
    traceId: opts.traceId,
    profileId: opts.profileId,
    runKind: opts.runKind,
    emulated: opts.emulated,
    probeOverrides: opts.probeOverrides ?? {},
    forceTier: opts.forceTier ?? null,
    disableWebgl: Boolean(opts.disableWebgl),
  };

  // JSON.stringify is the only interpolation into the script body. Nothing in
  // the config is a code fragment, and nothing is concatenated unquoted.
  return `(function () {
  "use strict";
  var cfg = ${JSON.stringify(config)};

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var atlas = {
    seed: cfg.seed,
    traceId: cfg.traceId,
    profileId: cfg.profileId,
    runKind: cfg.runKind,
    emulated: cfg.emulated,
    probeOverrides: cfg.probeOverrides,
    forceTier: cfg.forceTier,
    random: mulberry32(cfg.seed)
  };

  try {
    Object.defineProperty(globalThis, "__ATLAS__", {
      value: atlas, writable: false, configurable: false, enumerable: false
    });
  } catch (e) {
    globalThis.__ATLAS__ = atlas;
  }

  // Separate stream, so an accidental Math.random() cannot shift the layout.
  var strayStream = mulberry32((cfg.seed ^ 0x9e3779b9) >>> 0);
  try { Math.random = function () { return strayStream(); }; } catch (e) {}

  globalThis.__atlasCheckpointAck = null;
  globalThis.__atlasDone = false;

  if (cfg.disableWebgl) {
    var original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type) {
      if (typeof type === "string" && type.toLowerCase().indexOf("webgl") !== -1) return null;
      return original.apply(this, arguments);
    };
    // Some probes check for the constructor rather than calling getContext.
    try { delete globalThis.WebGL2RenderingContext; } catch (e) {}
  }
})();`;
}
