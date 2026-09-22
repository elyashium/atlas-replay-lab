/**
 * A synthetic `navigator.xr`, injected before the page's own scripts run.
 *
 * ## Why this exists at all
 *
 * Headless Chromium exposes no XR device. Without one, `navigator.xr` is
 * absent, `isSessionSupported()` never resolves true, and the three things worth
 * testing about a WebXR experience — does the session start, does it render
 * from a pose, and does refusing it leave a usable page — are all unreachable.
 * The `xr-granted` / `xr-denied` profiles need a device to grant or refuse.
 *
 * IWER and playwright-webxr do this well and are the right answer for most
 * projects. They are the wrong answer for this one: ADR-0002 says zero
 * dependencies, and the injection channel this needs
 * (`Page.addScriptToEvaluateOnNewDocument`) already exists for the bootstrap.
 * So this is hand-written, and small enough to audit in one sitting.
 *
 * ## What it is honestly NOT
 *
 * **This is not a conformant WebXR implementation.** It is a lifecycle and
 * pose harness. Specifically:
 *
 *  - Projection and view matrices are computed from a seeded scripted head
 *    path, not from a headset's optics. Nothing here measures stereo
 *    correctness, IPD, lens distortion, reprojection or real HMD latency.
 *  - There are no input sources: no controllers, no hands, no `select` events.
 *    `inputSources` is a permanently empty live array.
 *  - `XRWebGLLayer` reports `framebuffer: null`, so an app that binds it draws
 *    to the default framebuffer — i.e. the ordinary canvas. That is what makes
 *    the frame observable to a screenshot at all, and it means nothing about
 *    how the app would behave against a real swapchain.
 *  - Frames are driven off the page's own `requestAnimationFrame`, so session
 *    frame rate is the page's frame rate, not a headset's.
 *
 * Every run that injects this records those limits as a trace note. A report
 * that said "XR works" on the strength of this file would be lying, and the
 * note is what stops it.
 *
 * ## Determinism
 *
 * The head path is a pure function of `(seed, frameIndex)` — never of the wall
 * clock — which is what lets replay re-apply the identical pose sequence
 * without the trace having to carry the series. ADR-0004's rule holds: the
 * clock is not faked, only the pose is scripted.
 */

/** Identifier stored in the trace so a replay can prove it used the same path. */
export const POSE_SCRIPT_ID = "seeded-sweep-v1";

/**
 * @typedef {object} XrStubConfig
 * @property {number} seed                        seeds the head path
 * @property {"granted" | "denied"} grant         resolve or refuse `requestSession`
 * @property {string[]} [modes]                   supported session modes
 */

/**
 * @param {XrStubConfig} opts
 * @returns {string}
 */
export function buildXrStubScript(opts) {
  const config = {
    seed: opts.seed >>> 0,
    grant: opts.grant,
    modes: opts.modes ?? ["immersive-vr", "immersive-ar", "inline"],
    poseScript: POSE_SCRIPT_ID,
  };

  // As in inject.js: JSON.stringify is the only interpolation, and nothing in
  // the config is a code fragment.
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

  // Three draws from the seeded stream fix the sweep: the path is then a pure
  // function of frame index, so replay reproduces it without storing poses.
  var rnd = mulberry32(cfg.seed);
  var yawSpan = 0.6 + rnd() * 0.8;     // radians swept left-right
  var pitchSpan = 0.15 + rnd() * 0.2;  // radians swept up-down
  var phase = rnd() * Math.PI * 2;

  var bus = {
    poseScript: cfg.poseScript,
    seed: cfg.seed,
    grant: cfg.grant,
    framesDelivered: 0,
    sessionsRequested: 0,
    sessionsStarted: 0,
    sessionsRefused: 0,
    sessionsEnded: 0
  };
  try {
    Object.defineProperty(globalThis, "__atlasXrStub", {
      value: bus, writable: false, configurable: false, enumerable: false
    });
  } catch (e) {
    globalThis.__atlasXrStub = bus;
  }

  /* ── matrix helpers (column-major, as WebGL and WebXR both want) ─────── */

  function identity() {
    return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  }

  function fromYawPitch(yaw, pitch, y) {
    var cy = Math.cos(yaw), sy = Math.sin(yaw);
    var cp = Math.cos(pitch), sp = Math.sin(pitch);
    // Rotation Y * Rotation X, translation (0, y, 0).
    return new Float32Array([
      cy, 0, -sy, 0,
      sy * sp, cp, cy * sp, 0,
      sy * cp, -sp, cy * cp, 0,
      0, y, 0, 1
    ]);
  }

  function perspective(fovY, aspect, near, far) {
    var f = 1 / Math.tan(fovY / 2);
    var nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0
    ]);
  }

  function rigidTransform(matrix, position, orientation) {
    return {
      matrix: matrix,
      position: position,
      orientation: orientation,
      inverse: { matrix: matrix, position: position, orientation: orientation }
    };
  }

  /* ── the scripted head path ──────────────────────────────────────────── */

  // Deliberately frame-index driven, never Date.now() or performance.now().
  function poseForFrame(i) {
    var t = i / 90;
    var yaw = Math.sin(t + phase) * yawSpan;
    var pitch = Math.sin(t * 0.61 + phase) * pitchSpan;
    var height = 1.6;
    return {
      yaw: yaw,
      pitch: pitch,
      matrix: fromYawPitch(yaw, pitch, height),
      position: { x: 0, y: height, z: 0, w: 1 },
      orientation: { x: Math.sin(pitch / 2), y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }
    };
  }

  /* ── minimal XRWebGLLayer ────────────────────────────────────────────── */

  if (typeof globalThis.XRWebGLLayer !== "function") {
    globalThis.XRWebGLLayer = function XRWebGLLayer(session, gl, layerInit) {
      var canvas = (gl && gl.canvas) || {};
      this.context = gl;
      this.antialias = !(layerInit && layerInit.antialias === false);
      this.ignoreDepthValues = false;
      this.fixedFoveation = 0;
      // null = default framebuffer. See the header: this is what makes the
      // session's output land on the ordinary canvas and therefore in a
      // screenshot, and it is not how a real swapchain behaves.
      this.framebuffer = null;
      this.framebufferWidth = canvas.width || 1280;
      this.framebufferHeight = canvas.height || 720;
    };
    globalThis.XRWebGLLayer.prototype.getViewport = function (view) {
      return { x: 0, y: 0, width: this.framebufferWidth, height: this.framebufferHeight };
    };
  }

  /* ── the session ─────────────────────────────────────────────────────── */

  function makeReferenceSpace(type) {
    var space = {
      type: type,
      addEventListener: function () {},
      removeEventListener: function () {},
      dispatchEvent: function () { return true; }
    };
    space.getOffsetReferenceSpace = function () { return space; };
    return space;
  }

  function makeSession(mode) {
    /** @type {Record<string, Function[]>} */
    var listeners = {};
    var frameIndex = 0;
    var ended = false;
    var renderState = { baseLayer: null, depthNear: 0.1, depthFar: 1000, inlineVerticalFieldOfView: null };
    var pending = null;

    var session = {
      mode: mode,
      environmentBlendMode: mode === "immersive-ar" ? "additive" : "opaque",
      interactionMode: "world-space",
      visibilityState: "visible",
      inputSources: [],
      enabledFeatures: ["viewer", "local", "local-floor"],
      isSystemKeyboardSupported: false,
      renderState: renderState,
      domOverlayState: null
    };

    function emit(type, detail) {
      var event = detail || {};
      event.type = type;
      event.session = session;
      var list = listeners[type] || [];
      for (var i = 0; i < list.length; i++) {
        try { list[i].call(session, event); } catch (e) {}
      }
      var handler = session["on" + type];
      if (typeof handler === "function") {
        try { handler.call(session, event); } catch (e) {}
      }
    }

    session.addEventListener = function (type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    };
    session.removeEventListener = function (type, fn) {
      var list = listeners[type] || [];
      var at = list.indexOf(fn);
      if (at !== -1) list.splice(at, 1);
    };
    session.dispatchEvent = function (event) { emit(event && event.type, event); return true; };

    session.updateRenderState = function (state) {
      if (!state) return;
      for (var key in state) {
        if (Object.prototype.hasOwnProperty.call(state, key)) renderState[key] = state[key];
      }
    };

    session.requestReferenceSpace = function (type) {
      if (ended) return Promise.reject(new Error("session has ended"));
      return Promise.resolve(makeReferenceSpace(type || "local"));
    };

    session.requestAnimationFrame = function (callback) {
      if (ended) return 0;
      var index = frameIndex++;
      pending = requestAnimationFrame(function (time) {
        if (ended) return;
        bus.framesDelivered++;
        callback(time, makeFrame(index, time));
      });
      return pending;
    };

    session.cancelAnimationFrame = function (handle) {
      try { cancelAnimationFrame(handle); } catch (e) {}
    };

    session.end = function () {
      if (ended) return Promise.resolve();
      ended = true;
      bus.sessionsEnded++;
      if (pending !== null) { try { cancelAnimationFrame(pending); } catch (e) {} }
      return Promise.resolve().then(function () { emit("end", {}); });
    };

    function makeFrame(index, time) {
      var pose = poseForFrame(index);
      var layer = renderState.baseLayer;
      var width = (layer && layer.framebufferWidth) || window.innerWidth || 1280;
      var height = (layer && layer.framebufferHeight) || window.innerHeight || 720;
      var projection = perspective(
        (mode === "inline" ? 50 : 100) * Math.PI / 180,
        width / Math.max(1, height),
        renderState.depthNear,
        renderState.depthFar
      );
      var transform = rigidTransform(pose.matrix, pose.position, pose.orientation);
      var viewerPose = {
        transform: transform,
        emulatedPosition: true,
        linearVelocity: null,
        angularVelocity: null,
        views: [{
          eye: "none",
          projectionMatrix: projection,
          transform: transform,
          recommendedViewportScale: 1,
          requestViewportScale: function () {},
          isFirstPersonObserver: false
        }]
      };
      return {
        session: session,
        predictedDisplayTime: time,
        trackedAnchors: null,
        detectedPlanes: null,
        getViewerPose: function () { return viewerPose; },
        getPose: function () { return { transform: transform, emulatedPosition: true }; },
        getDepthInformation: function () { return null; },
        fillPoses: function () { return false; },
        fillJointRadii: function () { return false; },
        getHitTestResults: function () { return []; },
        getHitTestResultsForTransientInput: function () { return []; },
        // Non-standard, and clearly marked as ours: the probe reads this to
        // record that a pose-driven frame really was delivered.
        __atlasPose: { index: index, yaw: pose.yaw, pitch: pose.pitch, script: cfg.poseScript }
      };
    }

    return session;
  }

  /* ── the XRSystem ────────────────────────────────────────────────────── */

  var xr = {
    __atlasStub: true,
    addEventListener: function () {},
    removeEventListener: function () {},
    dispatchEvent: function () { return true; },
    isSessionSupported: function (mode) {
      return Promise.resolve(cfg.modes.indexOf(mode) !== -1);
    },
    requestSession: function (mode, init) {
      bus.sessionsRequested++;
      if (cfg.modes.indexOf(mode) === -1) {
        bus.sessionsRefused++;
        return Promise.reject(makeError("NotSupportedError", 'mode "' + mode + '" is not supported'));
      }
      if (cfg.grant === "denied") {
        bus.sessionsRefused++;
        // What a real browser throws when the user (or policy) refuses. The
        // fallback path under test is the one this rejection triggers.
        return Promise.reject(makeError("NotAllowedError", "XR session request was denied"));
      }
      bus.sessionsStarted++;
      return Promise.resolve(makeSession(mode));
    },
    offerSession: function (mode, init) {
      return xr.requestSession(mode, init);
    }
  };

  function makeError(name, message) {
    try { return new DOMException(message, name); } catch (e) {}
    var err = new Error(message);
    err.name = name;
    return err;
  }

  try {
    Object.defineProperty(navigator, "xr", {
      value: xr, writable: false, configurable: true, enumerable: true
    });
  } catch (e) {
    try { navigator.xr = xr; } catch (e2) {}
  }
})();`;
}

/**
 * The disclosure that accompanies every trace captured with the stub injected.
 *
 * Kept next to the implementation rather than in the runner so that changing
 * what the stub does forces a look at what the trace claims about it.
 *
 * @param {"granted" | "denied"} grant
 * @returns {string}
 */
export function xrStubNote(grant) {
  return (
    `WebXR was emulated by Atlas's own injected stub (pose script "${POSE_SCRIPT_ID}", ` +
    `session request ${grant}). No headset, no real XR runtime, no controllers or hand ` +
    `input, and no stereo/optics correctness is exercised. This tests session ` +
    `lifecycle, pose-driven rendering and session-refusal fallback only.`
  );
}
