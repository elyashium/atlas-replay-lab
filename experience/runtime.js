/**
 * Orbital runtime — the experience state machine.
 *
 * Boot sequence, and why it is shaped this way:
 *
 *   boot → probing → routing → loading → first-frame → [degraded] → interactive
 *
 * `routing` is a real network call to the control plane (`POST /api/decide`),
 * which runs the *same* DecisionEngine instance the CI matrix runs. The page
 * does not contain a tier-selection heuristic at all — if it did, there would
 * be two routers to keep in sync and the whole abstraction would be theatre.
 *
 * The router is called twice. Once at `routing`, from static capability only,
 * because something has to be loaded before anything can be measured. Then
 * again during `first-frame`, with `recentFrameTimeMsP95` populated from real
 * rendered frames. The second call is the one that makes this adaptive rather
 * than a single guess at boot: a device that *looked* capable and then missed
 * its frame budget gets moved down a tier before the user ever touches it.
 *
 * Determinism (see docs/adr/0004): the seeded RNG is injected and drives
 * particle layout and the mock order id, so two runs lay out identically. The
 * clock is NOT faked — the whole point of the trace is real captured timings,
 * and a virtual clock would make every metric in the report fiction. What
 * makes screenshots comparable instead is that checkpoint frames are rendered
 * at a fixed animation phase.
 *
 * @typedef {import("../types/atlas.js").ExperienceManifest} ExperienceManifest
 * @typedef {import("../types/atlas.js").TierSpec} TierSpec
 * @typedef {import("../types/atlas.js").TierDecision} TierDecision
 * @typedef {import("../types/atlas.js").CapabilitySnapshot} CapabilitySnapshot
 */

import { probeCapabilities } from "./capability-probe.js";
import { Recorder } from "./recorder.js";
import { WebglScene } from "./scene-webgl.js";
import { Canvas2dScene } from "./scene-2d.js";

/** Runner-injected controls. Absent when a human just opens the page. */
const ATLAS = /** @type {any} */ (globalThis).__ATLAS__ ?? {};

/** Fixed phase used for every checkpoint frame, so screenshots are comparable. */
const CHECKPOINT_PHASE = 1.75;

/** Default seed, used when the runner has not injected one. */
const DEFAULT_SEED = 0x0b17a1;

/** Deterministic by default, not only under test. */
const random = typeof ATLAS.random === "function" ? ATLAS.random : mulberry32(DEFAULT_SEED);

const el = {
  stage: /** @type {HTMLElement} */ (document.getElementById("stage")),
  camera: /** @type {HTMLVideoElement} */ (document.getElementById("camera")),
  anchor: /** @type {HTMLImageElement} */ (document.getElementById("anchor")),
  poster: /** @type {HTMLImageElement} */ (document.getElementById("poster")),
  layer: /** @type {HTMLCanvasElement} */ (document.getElementById("layer")),
  hudTier: /** @type {HTMLElement} */ (document.getElementById("hud-tier")),
  hudPath: /** @type {HTMLElement} */ (document.getElementById("hud-path")),
  hudEngine: /** @type {HTMLElement} */ (document.getElementById("hud-engine")),
  controls: /** @type {HTMLElement} */ (document.getElementById("controls")),
  panel: /** @type {HTMLElement} */ (document.getElementById("panel")),
  cart: /** @type {HTMLElement} */ (document.getElementById("cart")),
  done: /** @type {HTMLElement} */ (document.getElementById("done")),
  orderId: /** @type {HTMLElement} */ (document.getElementById("order-id")),
  degraded: /** @type {HTMLElement} */ (document.getElementById("degraded-banner")),
  errorPanel: /** @type {HTMLElement} */ (document.getElementById("error-panel")),
  errorDetail: /** @type {HTMLElement} */ (document.getElementById("error-detail")),
};

const app = {
  /** @type {ExperienceManifest | null} */ manifest: null,
  /** @type {Recorder | null} */ recorder: null,
  /** @type {CapabilitySnapshot | null} */ capability: null,
  /** @type {TierDecision | null} */ decision: null,
  /** @type {WebglScene | Canvas2dScene | null} */ scene: null,
  /** @type {TierSpec | null} */ tier: null,
  /** @type {string} */ path: "static-safe",
  /** @type {string} */ state: "boot",
  interactionIndex: 0,
  finished: false,
};

main().catch((err) => fail("BOOT_FAILED", err));

async function main() {
  const traceId = String(ATLAS.traceId ?? `live-${Math.floor(random() * 1e12).toString(36)}`);
  app.recorder = new Recorder({
    traceId,
    profileId: String(ATLAS.profileId ?? "local"),
    runKind: String(ATLAS.runKind ?? "production"),
    emulated: Boolean(ATLAS.emulated),
  });

  setState("boot");
  app.recorder.event("boot", "lifecycle", { state: "boot" });

  app.manifest = await fetchJson("api/manifest");

  // ── probing ───────────────────────────────────────────────────────────
  setState("probing");
  const probeStart = performance.now();
  app.capability = await probeCapabilities();
  app.recorder.event("probe-complete", "lifecycle", {
    state: "probing",
    durationMs: Math.round((performance.now() - probeStart) * 10) / 10,
  });

  // ── routing ───────────────────────────────────────────────────────────
  setState("routing");
  app.decision = await decide(app.capability);
  app.path = app.decision.path;
  applyPath(app.path);
  updateHud();

  // ── loading ───────────────────────────────────────────────────────────
  setState("loading");
  const loaded = await loadForTier(app.decision.tier);
  if (!loaded) return; // loadForTier already transitioned to `error`

  // ── first frame ───────────────────────────────────────────────────────
  await enterFirstFrame(loaded);
}

/* ── decision ─────────────────────────────────────────────────────────── */

/**
 * @param {CapabilitySnapshot} state
 * @returns {Promise<TierDecision>}
 */
async function decide(state) {
  const started = performance.now();

  // Baseline mode deliberately bypasses the router and always serves the top
  // tier. This is the "before" half of the failure story in §5.2 item 8 — it
  // is what the experience does when nothing is routing it.
  if (ATLAS.forceTier) {
    /** @type {TierDecision} */
    const forced = {
      tier: ATLAS.forceTier,
      tierAnswer: { value: ATLAS.forceTier, distribution: { [ATLAS.forceTier]: 1 } },
      cameraPathSafe: { pTrue: state.cameraPermission === "granted" ? 1 : 0 },
      firstFrameRisk: { score: 0, levels: [], distribution: {} },
      path: resolvePathLocally(state),
      confidence: 1,
      engine: "BaselineNoRouting",
      rationale: ["baseline run: tier forced, no capability routing"],
    };
    app.recorder?.decision(forced, performance.now() - started);
    return forced;
  }

  try {
    const res = await fetch("api/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, profileId: ATLAS.profileId ?? null }),
    });
    if (!res.ok) throw new Error(`decide returned ${res.status}`);
    const body = await res.json();
    const latency = performance.now() - started;
    app.recorder?.decision(body.decision, latency);
    return body.decision;
  } catch (err) {
    // The control plane being unreachable must never take the experience down.
    // Serve the safest thing that always works and record why.
    app.recorder?.error("DECIDE_UNREACHABLE", false, { message: String(err instanceof Error ? err.message : err) });
    /** @type {TierDecision} */
    const safe = {
      tier: "low",
      tierAnswer: { value: "low", distribution: { low: 1 } },
      cameraPathSafe: { pTrue: 0 },
      firstFrameRisk: { score: 0, levels: [], distribution: {} },
      path: "static-safe",
      confidence: 0,
      engine: "LocalSafeDefault",
      rationale: ["control plane unreachable; served the always-safe path"],
    };
    app.recorder?.decision(safe, performance.now() - started);
    return safe;
  }
}

/**
 * Path resolution is a pure capability function and is duplicated here only
 * for the baseline (un-routed) run, which by definition does not call the
 * control plane. The authoritative implementation is
 * src/capability/buckets.js#resolvePath.
 *
 * @param {CapabilitySnapshot} s
 */
function resolvePathLocally(s) {
  if (s.cameraPermission === "granted" && s.webglVersion >= 1) return "camera-xr";
  return "interactive-2d";
}

/* ── asset loading ────────────────────────────────────────────────────── */

/**
 * Loads the assets for a tier, degrading rather than failing. A critical
 * asset that will not load gets one retry, then the whole tier steps down.
 * This is the behaviour the packet-loss profile exists to exercise.
 *
 * @param {string} requestedTier
 * @returns {Promise<{ tier: TierSpec; textureImage: HTMLImageElement } | null>}
 */
async function loadForTier(requestedTier) {
  const manifest = /** @type {ExperienceManifest} */ (app.manifest);
  const ladder = ["high", "mid", "low"];
  const startIdx = requestedTier === "static-fallback" ? ladder.length : ladder.indexOf(requestedTier);

  // The static-safe path needs the poster and nothing else.
  if (app.path === "static-safe" || startIdx < 0 || startIdx >= ladder.length) {
    const ok = await loadPoster();
    if (!ok) {
      fail("POSTER_UNAVAILABLE", new Error("the static-safe poster failed to load"));
      return null;
    }
    app.tier = manifest.tiers[manifest.tiers.length - 1];
    return { tier: app.tier, textureImage: el.poster };
  }

  if (app.path === "interactive-2d") {
    // The anchor stands in for the camera feed. Non-critical: if it fails the
    // product layer still composites over the page background.
    await loadImageAsset("anchor", "assets/generated/anchor.png", false).catch(() => null);
  }

  for (let i = startIdx; i < ladder.length; i++) {
    const tier = manifest.tiers.find((t) => t.id === ladder[i]);
    if (!tier) continue;

    const result = await loadTierAssets(tier);
    if (result.ok && result.textureImage) {
      if (i !== startIdx) {
        app.recorder?.event("tier-stepdown-on-asset-failure", "lifecycle", {
          state: "loading",
          from: ladder[startIdx],
          to: tier.id,
          reason: "critical-asset-failed",
        });
      }
      app.tier = tier;
      return { tier, textureImage: result.textureImage };
    }
  }

  // Everything failed. The business invariant still has to hold, so fall all
  // the way through to the static-safe path rather than showing an error.
  app.recorder?.event("fallback-to-static-safe", "lifecycle", {
    state: "loading",
    reason: "all-tiers-failed-to-load",
  });
  app.path = "static-safe";
  applyPath("static-safe");
  const ok = await loadPoster();
  if (!ok) {
    fail("ALL_ASSETS_UNAVAILABLE", new Error("no tier and no poster could be loaded"));
    return null;
  }
  app.tier = manifest.tiers[manifest.tiers.length - 1];
  return { tier: app.tier, textureImage: el.poster };
}

/**
 * @param {TierSpec} tier
 * @returns {Promise<{ ok: boolean; textureImage: HTMLImageElement | null }>}
 */
async function loadTierAssets(tier) {
  /** @type {HTMLImageElement | null} */
  let textureImage = null;
  let ok = true;

  for (const asset of tier.assets) {
    if (asset.kind === "texture") {
      const img = await withRetry(() => loadImageAsset(asset.id, asset.url, asset.critical));
      if (img) textureImage = img;
      else if (asset.critical) ok = false;
    } else {
      const bytes = await withRetry(() => loadBinaryAsset(asset.id, asset.url, asset.critical));
      if (bytes === null && asset.critical) ok = false;
    }
    if (!ok) break;
  }
  return { ok: ok && Boolean(textureImage), textureImage };
}

/**
 * One retry, then give up. Retrying forever on a lossy link is how you turn a
 * degraded experience into a hung one.
 *
 * @template T
 * @param {() => Promise<T | null>} fn
 * @returns {Promise<T | null>}
 */
async function withRetry(fn) {
  const first = await fn().catch(() => null);
  if (first !== null) return first;
  return fn().catch(() => null);
}

/**
 * @param {string} assetId
 * @param {string} url
 * @param {boolean} critical
 * @returns {Promise<HTMLImageElement | null>}
 */
async function loadImageAsset(assetId, url, critical) {
  const started = performance.now();
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const img = await decodeImage(blob);
    app.recorder?.asset({
      assetId,
      kind: "texture",
      ok: true,
      bytes: blob.size,
      critical,
      durationMs: performance.now() - started,
    });
    if (assetId === "anchor") {
      el.anchor.src = img.src;
      return img;
    }
    return img;
  } catch (err) {
    app.recorder?.asset({
      assetId,
      kind: "texture",
      ok: false,
      bytes: 0,
      critical,
      durationMs: performance.now() - started,
    });
    return null;
  }
}

/**
 * @param {string} assetId
 * @param {string} url
 * @param {boolean} critical
 * @returns {Promise<number | null>}
 */
async function loadBinaryAsset(assetId, url, critical) {
  const started = performance.now();
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    app.recorder?.asset({
      assetId,
      kind: "geometry",
      ok: true,
      bytes: buf.byteLength,
      critical,
      durationMs: performance.now() - started,
    });
    return buf.byteLength;
  } catch {
    app.recorder?.asset({ assetId, kind: "geometry", ok: false, bytes: 0, critical, durationMs: performance.now() - started });
    return null;
  }
}

/** @param {Blob} blob @returns {Promise<HTMLImageElement>} */
function decodeImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image decode failed"));
    };
    img.src = url;
  });
}

async function loadPoster() {
  const img = await loadImageAsset("poster", "assets/generated/poster.png", true);
  if (!img) return false;
  el.poster.src = img.src;
  el.poster.hidden = false;
  return true;
}

/* ── first frame, adaptive re-decision, interactive ───────────────────── */

/**
 * @param {{ tier: TierSpec; textureImage: HTMLImageElement }} loaded
 */
async function enterFirstFrame(loaded) {
  const recorder = /** @type {Recorder} */ (app.recorder);

  if (app.path !== "static-safe") {
    if (app.path === "camera-xr") await attachCamera();
    sizeCanvas();
    const built = buildScene(loaded.tier, loaded.textureImage);
    if (!built) return;
    // One deterministic frame at the checkpoint phase, painted before
    // anything animates. This is the frame the visual invariant is about.
    app.scene?.renderFrame(CHECKPOINT_PHASE);
  }

  recorder.event("first-frame", "lifecycle", {
    state: "first-frame",
    tier: loaded.tier.id,
    path: app.path,
    // Blankness is measured from the captured checkpoint PNG on the Node side
    // (src/runner/run-matrix.js), not guessed here — the page never reads
    // pixels back, and the composited result includes layers the page cannot
    // see anyway.
    nonBlank: null,
  });
  setState("first-frame");
  await recorder.checkpoint("cp-first-frame", "first-frame");

  // Sample real frames before deciding whether this device can hold the tier.
  recorder.startFrameSampling(loaded.tier.params.targetFps);
  if (app.path !== "static-safe" && !app.capability?.reducedMotionPreferred) {
    app.scene?.startAnimating(CHECKPOINT_PHASE);
  }
  await sleep(420);

  const downgraded = await maybeDowngrade(loaded);
  if (downgraded === "error") return;

  setState("interactive");
  recorder.event("interactive", "lifecycle", { state: "interactive", tier: app.tier?.id ?? null, path: app.path });
  wireInteractions();
  updateHud();
  await recorder.checkpoint("cp-interactive", "interactive");
}

/**
 * The second router call — the adaptive one. Feeds measured p95 frame time
 * back into the same engine and steps the tier down if it says so.
 *
 * @param {{ tier: TierSpec; textureImage: HTMLImageElement }} loaded
 * @returns {Promise<"kept" | "downgraded" | "error">}
 */
async function maybeDowngrade(loaded) {
  const recorder = /** @type {Recorder} */ (app.recorder);
  if (ATLAS.forceTier) return "kept"; // baseline never adapts — that is the point
  if (app.path === "static-safe") return "kept";

  const measured = recorder.recentFrameTimeMsP95();
  if (measured === null) return "kept";

  /** @type {CapabilitySnapshot} */
  const withFrames = { .../** @type {CapabilitySnapshot} */ (app.capability), recentFrameTimeMsP95: measured };
  const second = await decide(withFrames);
  app.capability = withFrames;

  const ladder = ["high", "mid", "low"];
  const before = ladder.indexOf(loaded.tier.id);
  const after = ladder.indexOf(second.tier);
  if (after <= before || after < 0) {
    app.decision = second;
    return "kept";
  }

  // The engine wants us lower. Rebuild at the lower tier.
  setState("degraded");
  el.degraded.hidden = false;
  recorder.event("tier-downgrade", "lifecycle", {
    state: "degraded",
    from: loaded.tier.id,
    to: second.tier,
    reason: "measured-frame-time",
    observedP95FrameTimeMs: measured,
  });

  const manifest = /** @type {ExperienceManifest} */ (app.manifest);
  const lower = manifest.tiers.find((t) => t.id === second.tier);
  if (!lower) return "kept";

  app.scene?.dispose();
  const result = await loadTierAssets(lower);
  if (!result.ok || !result.textureImage) {
    fail("DOWNGRADE_ASSETS_UNAVAILABLE", new Error(`could not load ${second.tier} assets`));
    return "error";
  }
  app.tier = lower;
  app.decision = second;
  if (!buildScene(lower, result.textureImage)) return "error";
  app.scene?.renderFrame(CHECKPOINT_PHASE);
  if (!app.capability?.reducedMotionPreferred) app.scene?.startAnimating(CHECKPOINT_PHASE);
  updateHud();
  return "downgraded";
}

/**
 * @param {TierSpec} tier
 * @param {HTMLImageElement} textureImage
 * @returns {boolean}
 */
function buildScene(tier, textureImage) {
  const opts = { canvas: el.layer, tier, textureImage, random, dpr: window.devicePixelRatio || 1 };
  try {
    app.scene = new WebglScene().init(opts);
    return true;
  } catch (glErr) {
    // A WebGL context can be refused at any moment (blocklists, GPU process
    // crash, memory pressure) — not only when the probe said so. The 2D path
    // is the same experience, not an error page.
    app.recorder?.error("WEBGL_INIT_FAILED", false, {
      message: String(glErr instanceof Error ? glErr.message : glErr),
    });
    try {
      app.scene = new Canvas2dScene().init(opts);
      app.recorder?.event("scene-fallback-2d", "lifecycle", { state: app.state, reason: "webgl-init-failed" });
      return true;
    } catch (twoDErr) {
      fail("SCENE_UNAVAILABLE", twoDErr);
      return false;
    }
  }
}

async function attachCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false, // never
    });
    // The stream is attached to the <video> element and never touched again.
    // No frame is read back, drawn into a canvas, encoded or transmitted.
    el.camera.srcObject = stream;
    await el.camera.play().catch(() => {});
    app.recorder?.event("camera-attached", "lifecycle", { state: "first-frame" });
  } catch (err) {
    app.recorder?.error("CAMERA_UNAVAILABLE", false, {
      message: String(err instanceof Error ? err.name : err),
    });
    app.path = "interactive-2d";
    applyPath("interactive-2d");
    await loadImageAsset("anchor", "assets/generated/anchor.png", false).catch(() => null);
    updateHud();
  }
}

/* ── interaction ──────────────────────────────────────────────────────── */

function wireInteractions() {
  bind("btn-product", "tap:product", "product", () => go("product-detail"));
  bind("btn-back", "tap:back", "back", () => go("interactive"));
  bind("btn-cart", "tap:add-to-cart", "add-to-cart", () => go("cart"));
  bind("btn-cart-back", "tap:back", "back", () => go("product-detail"));
  bind("btn-checkout", "tap:checkout", "checkout", () => go("checkout-complete"));
}

/**
 * Measures interaction latency from the input event to the first frame after
 * the resulting DOM change has been committed. `requestAnimationFrame` inside
 * `requestAnimationFrame` lands after style and layout for the current frame,
 * which is the closest a page can get to "the user saw it".
 *
 * @param {string} id
 * @param {string} inputClass
 * @param {string} target
 * @param {() => void} action
 */
function bind(id, inputClass, target, action) {
  const node = document.getElementById(id);
  if (!node) return;
  node.addEventListener(
    "pointerdown",
    () => {
      const started = performance.now();
      action();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          app.recorder?.interaction({
            inputClass,
            target,
            latencyMs: performance.now() - started,
            index: app.interactionIndex++,
          });
        }),
      );
    },
    { passive: true },
  );
}

/** @param {string} next */
function go(next) {
  el.panel.hidden = next !== "product-detail";
  el.cart.hidden = next !== "cart";
  el.done.hidden = next !== "checkout-complete";
  el.controls.hidden = next !== "interactive";

  setState(next);
  app.recorder?.state(/** @type {any} */ (next));

  if (next === "product-detail") void app.recorder?.checkpoint("cp-product-detail", "product-detail");
  if (next === "checkout-complete") void finishCheckout();
}

async function finishCheckout() {
  // Deterministic mock order id — derived from the seeded RNG, never a clock.
  el.orderId.textContent = `ORB-${Math.floor(random() * 0xffffff).toString(16).toUpperCase().padStart(6, "0")}`;
  await app.recorder?.checkpoint("cp-checkout", "checkout-complete");
  await finish();
}

/* ── teardown ─────────────────────────────────────────────────────────── */

async function finish() {
  if (app.finished) return;
  app.finished = true;
  const recorder = /** @type {Recorder} */ (app.recorder);
  app.scene?.stopAnimating();
  recorder.event("session-end", "lifecycle", { state: app.state });

  const payload = recorder.toPayload({
    capability: /** @type {CapabilitySnapshot} */ (app.capability),
    decision: app.decision,
    servedTier: app.tier?.id ?? null,
    servedPath: app.path,
  });

  try {
    await fetch("api/trace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    /* Losing the trace must not break the experience. */
  }
  /** @type {any} */ (globalThis).__atlasDone = true;
  /** @type {any} */ (globalThis).__atlasPayload = payload;
}

/**
 * @param {string} code
 * @param {unknown} err
 */
function fail(code, err) {
  const message = err instanceof Error ? err.message : String(err);
  app.recorder?.error(code, true, { message });
  setState("error");
  app.recorder?.state("error");
  el.errorPanel.hidden = false;
  el.errorDetail.textContent = message;
  void finish();
}

/* ── small helpers ────────────────────────────────────────────────────── */

/** @param {string} next */
function setState(next) {
  app.state = next;
  el.stage.dataset.state = next;
  // `state` events are pushed by recorder.state(); the lifecycle states before
  // `interactive` push here so the sequence starts at boot.
  if (["boot", "probing", "routing", "loading", "first-frame", "degraded", "interactive"].includes(next)) {
    const last = app.recorder?.states[app.recorder.states.length - 1];
    if (last !== next) app.recorder?.state(/** @type {any} */ (next));
  }
}

/** @param {string} path */
function applyPath(path) {
  el.stage.dataset.path = path;
}

function sizeCanvas() {
  // Cap the backing store at 2x. A 3x DPR phone rendering 2600 sprites into a
  // 9x-area framebuffer is a memory and fill-rate problem, not a fidelity win.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  el.layer.width = Math.round(el.layer.clientWidth * dpr);
  el.layer.height = Math.round(el.layer.clientHeight * dpr);
}

function updateHud() {
  el.hudTier.textContent = `tier ${app.tier?.id ?? app.decision?.tier ?? "—"}`;
  el.hudPath.textContent = `path ${app.path}`;
  el.hudEngine.textContent = app.decision ? app.decision.engine.replace(/DecisionEngine$/, "") : "engine —";
}

/** @param {string} url */
async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Seeded RNG (mulberry32). Used when the runner has not injected one, so the
 * page is deterministic by default rather than only under test.
 * @param {number} seed
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
