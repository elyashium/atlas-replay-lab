/**
 * The generic, app-agnostic flight recorder.
 *
 * `experience/recorder.js` records the Orbital demo, which cooperates: it has a
 * state machine, it announces its own transitions, and it posts its own trace.
 * A stranger's deployed WebXR app does none of that. This file records it
 * anyway, from the outside, with zero per-app code.
 *
 * ## How it gets in
 *
 * This is **not** an ES module and is never imported. The runner reads it off
 * disk as text and registers it with `Page.addScriptToEvaluateOnNewDocument`,
 * so it runs before the visitor's own scripts on every document — including
 * ones it navigates to. That is the only reason it can wrap `getContext`,
 * `requestSession` and `console.error` before the app touches them.
 *
 * Registration order, fixed by the runner: bootstrap (`inject.js`) → XR stub
 * (`xr-stub.js`) → this file. It therefore reads `__ATLAS__` for the seed and
 * run identity, and observes whatever `navigator.xr` the stub installed.
 *
 * ## What it records
 *
 *  - Per-frame times from `requestAnimationFrame` (raw series + 500ms
 *    aggregates), which is what Slice 2's comfort floor is computed from.
 *  - XR session lifecycle: request, start, refusal, end — by wrapping
 *    `navigator.xr.requestSession`, so it sees the *app's* attempt, not ours.
 *  - Console errors, uncaught exceptions, unhandled rejections, and WebGL
 *    context loss, as coarse classes with truncated text.
 *  - First non-blank canvas time, by sampling a 32×32 downsample (see below).
 *  - Asset bytes and failures from `PerformanceResourceTiming`, with query
 *    strings stripped — a signed URL is a credential, not a metric.
 *
 * ## Two observer effects, disclosed rather than hidden
 *
 * 1. **`preserveDrawingBuffer` is forced on.** Without it, sampling a WebGL
 *    canvas after the frame has been presented returns a cleared buffer, so
 *    "was anything drawn" is unanswerable from inside the page. Forcing it
 *    costs the app some GPU bandwidth, which means the frame times recorded
 *    here are very slightly pessimistic versus the same app unobserved. Every
 *    run records this as a trace note. The authoritative non-blank measurement
 *    is still the Node-side screenshot (see src/runner/session.js); this one
 *    exists to timestamp the *first* non-blank frame, which a screenshot taken
 *    at a checkpoint cannot.
 *
 * 2. **Canvas sampling stops if a camera stream is ever acquired.** An 8th
 *    Wall-style app composites the camera feed into the same canvas, so
 *    sampling it would be reading camera pixels — the one thing PRIVACY.md
 *    says never happens. `getUserMedia` is wrapped; the first successful video
 *    capture permanently disables sampling and records why. Nothing is
 *    retained either way: the sampler computes one scalar over a 32×32
 *    downsample and drops the buffer in the same tick, the same discipline
 *    `capability-probe.js` uses with the GPU renderer string.
 *
 * ## Capability snapshot
 *
 * The snapshot built here duplicates a handful of one-line reads from
 * `experience/capability-probe.js`, because that file is an ES module the
 * experience imports and this one is a classic script injected into a foreign
 * document — there is no import channel across that boundary. The duplication
 * is bounded on purpose: `normalizeSnapshot` (src/capability/buckets.js)
 * re-derives every field server-side from an allow-list, so drift here can only
 * *lose* a field (which becomes an explicit null the bucketer handles), never
 * smuggle a new one into the trace.
 */

(function () {
  "use strict";

  if (globalThis.__atlasGeneric) return;

  var ATLAS = globalThis.__ATLAS__ || {};
  var BINDING = "__atlasBinding";

  /* Ceilings. A 30s session at 60fps is ~1800 frame samples; an art-directed
     WebGL app can pull 300+ resources. Both are bounded here rather than in
     the assembler so the page never builds a payload it cannot serialise. */
  var MAX_FRAME_SAMPLES = 3600;
  var MAX_ASSET_EVENTS = 400;
  var MAX_EVENTS = 6000;
  var MAX_ERRORS = 60;
  var MAX_TEXT = 200;
  var FRAME_FLUSH_MS = 500;
  var TARGET_FRAME_MS = 1000 / 60;

  var t0 = performance.now();

  var rec = {
    states: [],
    events: [],
    checkpoints: [],
    inputClasses: [],
    notes: [],
    frameTimes: [],
    xrSessionEvents: [],
    consoleErrors: [],
    firstNonBlankMs: null,
    firstFrameMs: null,
    frameTimesTruncated: false,
    cameraStreamSeen: false,
    canvasSamplingStopped: null,
    pendingInputClass: null,
    xrSupported: null,
    xrPresent: Boolean(navigator.xr),
    xrStub: Boolean(navigator.xr && navigator.xr.__atlasStub)
  };

  function now() {
    return Math.round((performance.now() - t0) * 100) / 100;
  }

  function clip(value) {
    return String(value === undefined || value === null ? "" : value).slice(0, MAX_TEXT);
  }

  /**
   * Redacts an error string before it is recorded.
   *
   * Error text is the one free-text field a generic trace carries, and it is
   * developer-authored diagnostics rather than user input. But a stack trace
   * can still contain a signed asset URL, and a validation message can still
   * echo something a user typed. So URLs lose their query strings and any long
   * unbroken token-shaped run is replaced before the string is stored. What
   * survives is the part that identifies the *class* of failure, which is all
   * the judge is asked about — and `summariseTraceForJev` ships only the code,
   * never this text.
   */
  function scrubText(value) {
    return clip(
      String(value === undefined || value === null ? "" : value)
        .replace(/([?#])[^\s"')]*/g, "$1<stripped>")
        .replace(/[A-Za-z0-9_\-]{24,}/g, "<token>")
    );
  }

  function push(name, kind, attributes) {
    if (rec.events.length >= MAX_EVENTS) return;
    rec.events.push({ tOffsetMs: now(), name: name, kind: kind, attributes: attributes || {} });
  }

  function note(text) {
    if (rec.notes.length < 48) rec.notes.push(clip(text));
  }

  /* ── the generic spine ────────────────────────────────────────────────── */

  // `lifecycle`, not `state`: the trace normaliser's allow-list keeps
  // `state`/`reason`/`nonBlank` on lifecycle events, and `first-frame`'s
  // `nonBlank` has to survive into the determinism hash (see
  // src/trace/normalize.js). Emitting these as `state` events would silently
  // drop the one attribute the visual invariant reads.
  function mark(state) {
    if (typeof state !== "string" || !state) return;
    if (rec.states[rec.states.length - 1] === state) return;
    rec.states.push(state);
    push(state, "lifecycle", { state: state });
  }

  /* ── frames ───────────────────────────────────────────────────────────── */

  var frames = { rendered: 0, dropped: 0, windowTimes: [], lastTime: null, lastFlush: 0 };

  function onFrame() {
    var t = performance.now();
    if (frames.lastTime !== null) {
      var delta = t - frames.lastTime;
      frames.rendered++;
      frames.windowTimes.push(delta);
      if (rec.frameTimes.length < MAX_FRAME_SAMPLES) {
        rec.frameTimes.push(Math.round(delta * 100) / 100);
      } else {
        rec.frameTimesTruncated = true;
      }
      // A gap of more than 1.5 target frames is counted as whole missed
      // intervals, the same rule experience/recorder.js uses. It is a proxy,
      // not a compositor measurement, and it is the same proxy on both sides
      // so the two are comparable.
      if (delta > TARGET_FRAME_MS * 1.5) {
        frames.dropped += Math.max(1, Math.round(delta / TARGET_FRAME_MS) - 1);
      }
    }
    frames.lastTime = t;

    if (t - t0 - frames.lastFlush >= FRAME_FLUSH_MS) {
      flushFrames();
      frames.lastFlush = t - t0;
    }
    requestAnimationFrame(onFrame);
  }

  function flushFrames() {
    if (!frames.windowTimes.length) return;
    var sorted = frames.windowTimes.slice().sort(function (a, b) { return a - b; });
    push("frames", "frame", {
      rendered: frames.rendered,
      dropped: frames.dropped,
      p95FrameTimeMs: pct(sorted, 0.95),
      jsHeapUsedMB: heapMB()
    });
    frames.windowTimes = [];
    frames.rendered = 0;
    frames.dropped = 0;
  }

  function pct(sorted, q) {
    if (!sorted.length) return null;
    if (sorted.length === 1) return Math.round(sorted[0] * 100) / 100;
    var pos = (sorted.length - 1) * q;
    var lo = Math.floor(pos);
    var hi = Math.ceil(pos);
    var v = sorted[lo] * (1 - (pos - lo)) + sorted[hi] * (pos - lo);
    return Math.round(v * 100) / 100;
  }

  function heapMB() {
    var mem = performance.memory;
    if (!mem || typeof mem.usedJSHeapSize !== "number") return null;
    return Math.round((mem.usedJSHeapSize / 1048576) * 10) / 10;
  }

  /* ── errors ───────────────────────────────────────────────────────────── */

  function recordError(code, text, fatal) {
    if (rec.consoleErrors.length < MAX_ERRORS) {
      rec.consoleErrors.push({ tOffsetMs: now(), code: code, message: clip(text) });
    }
    // `code` and `fatal` are in the normaliser's allow-list for `error` events
    // and therefore causal; the message text is not, because error strings
    // carry line numbers and hashes that legitimately differ between runs.
    push(code, "error", { code: code, fatal: Boolean(fatal), message: clip(text) });
  }

  var nativeConsoleError = console.error ? console.error.bind(console) : null;
  try {
    console.error = function () {
      try {
        recordError("console-error", Array.prototype.join.call(arguments, " "), false);
      } catch (e) { /* recording must never break the page */ }
      if (nativeConsoleError) nativeConsoleError.apply(console, arguments);
    };
  } catch (e) { /* frozen console; the runner also collects Log.entryAdded */ }

  addEventListener("error", function (event) {
    if (event && event.target && event.target !== globalThis && event.target.tagName) {
      // A failed <img>/<script>/<link>, not a thrown exception.
      recordError("resource-error", (event.target.tagName || "") + " failed to load", false);
      return;
    }
    recordError("uncaught-exception", event && event.message, true);
  }, true);

  addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    recordError("unhandled-rejection", reason && reason.message ? reason.message : reason, false);
  });

  /* ── WebGL: context loss, and the forced preserveDrawingBuffer ────────── */

  var canvases = [];

  function watchCanvas(canvas) {
    if (!canvas || canvases.indexOf(canvas) !== -1) return;
    canvases.push(canvas);
    try {
      canvas.addEventListener("webglcontextlost", function () {
        recordError("webgl-context-lost", "WebGL context was lost", true);
      });
      canvas.addEventListener("webglcontextrestored", function () {
        push("webgl-context-restored", "lifecycle", { reason: "webglcontextrestored" });
      });
    } catch (e) { /* not an element we can listen on */ }
  }

  var nativeGetContext = HTMLCanvasElement.prototype.getContext;
  try {
    HTMLCanvasElement.prototype.getContext = function (type, attributes) {
      var isWebgl = typeof type === "string" && type.toLowerCase().indexOf("webgl") !== -1;
      var attrs = attributes;
      if (isWebgl && !rec.cameraStreamSeen) {
        // See the header: without this, "was anything drawn" is unanswerable
        // from inside the page. Recorded as a note on every run.
        attrs = {};
        for (var key in attributes) {
          if (Object.prototype.hasOwnProperty.call(attributes, key)) attrs[key] = attributes[key];
        }
        attrs.preserveDrawingBuffer = true;
      }
      var ctx = nativeGetContext.call(this, type, attrs);
      if (ctx && isWebgl) watchCanvas(this);
      return ctx;
    };
  } catch (e) {
    note("could not wrap getContext; first-non-blank-canvas time is unavailable");
  }

  /* ── camera: the tripwire that disables canvas sampling ───────────────── */

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    var nativeGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    try {
      navigator.mediaDevices.getUserMedia = function (constraints) {
        var wantsVideo = Boolean(constraints && constraints.video);
        return nativeGum(constraints).then(function (stream) {
          if (wantsVideo) {
            rec.cameraStreamSeen = true;
            stopCanvasSampling("a camera stream was acquired by the page");
            push("camera-stream-acquired", "lifecycle", { reason: "getUserMedia" });
          }
          return stream;
        });
      };
    } catch (e) { /* leave the native one in place */ }
  }

  function stopCanvasSampling(reason) {
    if (rec.canvasSamplingStopped) return;
    rec.canvasSamplingStopped = clip(reason);
    note("page-side canvas sampling stopped: " + rec.canvasSamplingStopped);
  }

  /* ── first non-blank canvas ───────────────────────────────────────────── */

  var probeCanvas = null;
  var probeCtx = null;

  function sampleNonBlank() {
    if (rec.firstNonBlankMs !== null || rec.canvasSamplingStopped) return;
    if (!canvases.length) {
      var found = document.getElementsByTagName("canvas");
      for (var i = 0; i < found.length; i++) watchCanvas(found[i]);
      if (!canvases.length) return;
    }
    if (!probeCanvas) {
      probeCanvas = document.createElement("canvas");
      probeCanvas.width = 32;
      probeCanvas.height = 32;
      probeCtx = probeCanvas.getContext("2d", { willReadFrequently: true });
      if (!probeCtx) {
        stopCanvasSampling("no 2D context available for the 32x32 sampler");
        return;
      }
    }
    for (var c = 0; c < canvases.length; c++) {
      var source = canvases[c];
      if (!source.width || !source.height) continue;
      var variance;
      try {
        probeCtx.clearRect(0, 0, 32, 32);
        probeCtx.drawImage(source, 0, 0, 32, 32);
        variance = lumaVariance(probeCtx.getImageData(0, 0, 32, 32).data);
      } catch (e) {
        // Tainted by a cross-origin texture. Not a failure: the Node-side
        // screenshot is the authoritative non-blank measurement.
        stopCanvasSampling("canvas is tainted by cross-origin content");
        return;
      }
      // Only the scalar survives this function; the ImageData reference goes
      // out of scope with it and is never stored or transmitted.
      if (variance > 12) {
        rec.firstNonBlankMs = now();
        push("first-non-blank-canvas", "lifecycle", {
          reason: "luma-variance",
          variance: Math.round(variance * 100) / 100
        });
        return;
      }
    }
  }

  function lumaVariance(data) {
    var sum = 0;
    var sumSq = 0;
    var n = 0;
    for (var i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      var luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += luma;
      sumSq += luma * luma;
      n++;
    }
    if (n < 16) return 0;
    var mean = sum / n;
    return Math.max(0, sumSq / n - mean * mean);
  }

  /* ── XR observation (the app's attempt, not ours) ─────────────────────── */

  function recordXr(phase, detail) {
    rec.xrSessionEvents.push({
      tOffsetMs: now(),
      phase: phase,
      mode: clip(detail && detail.mode),
      error: detail && detail.error ? clip(detail.error) : null
    });
    push("xr-" + phase, "lifecycle", {
      reason: clip((detail && detail.error) || (detail && detail.mode) || phase)
    });
  }

  if (navigator.xr && typeof navigator.xr.requestSession === "function") {
    var nativeRequest = navigator.xr.requestSession.bind(navigator.xr);
    try {
      navigator.xr.requestSession = function (mode, init) {
        recordXr("request", { mode: mode });
        return nativeRequest(mode, init).then(
          function (session) {
            recordXr("session-start", { mode: mode });
            try {
              session.addEventListener("end", function () {
                recordXr("session-end", { mode: mode });
              });
            } catch (e) { /* session without an event target */ }
            return session;
          },
          function (err) {
            recordXr("session-refused", { mode: mode, error: (err && err.name) || "unknown" });
            throw err;
          }
        );
      };
    } catch (e) {
      note("could not wrap navigator.xr.requestSession; XR lifecycle is unobserved");
    }
  } else {
    recordXr("unavailable", { mode: "none" });
  }

  /* ── input latency ────────────────────────────────────────────────────── */

  function onInputStart() {
    var startedAt = now();
    var inputClass = rec.pendingInputClass || "tap:generic";
    rec.pendingInputClass = null;
    // Input-to-next-frame, which is the part of input-to-photon a page can
    // actually see. The rest (compositor + display) is not observable here and
    // is not claimed to be.
    requestAnimationFrame(function () {
      var latency = Math.max(0, now() - startedAt);
      if (rec.inputClasses.length < 512) rec.inputClasses.push(inputClass);
      push("interaction", "interaction", {
        inputClass: inputClass,
        latencyMs: Math.round(latency * 100) / 100
      });
    });
  }

  addEventListener("pointerdown", onInputStart, true);
  addEventListener("touchstart", onInputStart, true);
  addEventListener("mousedown", onInputStart, true);

  /* ── assets, from resource timing ─────────────────────────────────────── */

  function collectAssets() {
    var entries = [];
    try {
      entries = performance.getEntriesByType("resource") || [];
    } catch (e) {
      return 0;
    }
    var total = 0;
    var emitted = 0;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var bytes = entry.transferSize || entry.encodedBodySize || 0;
      total += bytes;
      if (emitted >= MAX_ASSET_EVENTS) continue;
      emitted++;
      // Query and fragment are stripped: a signed asset URL is a credential.
      var url = stripQuery(entry.name);
      push("asset", "asset", {
        assetId: url,
        kind: clip(entry.initiatorType || "other"),
        // Resource timing cannot distinguish a 404 from a 200 without
        // Timing-Allow-Origin, so "ok" means "bytes arrived", and a
        // cross-origin zero here is ambiguous rather than a failure. The
        // runner's Network.loadingFailed handler is the reliable signal.
        ok: bytes > 0 || entry.duration > 0,
        durationMs: Math.round(entry.duration * 100) / 100,
        bytes: bytes
      });
    }
    if (entries.length > MAX_ASSET_EVENTS) {
      note("resource-timing entries truncated at " + MAX_ASSET_EVENTS + " of " + entries.length);
    }
    return total;
  }

  function stripQuery(raw) {
    var url = clip(raw);
    var cut = url.indexOf("?");
    if (cut !== -1) url = url.slice(0, cut) + "?<stripped>";
    cut = url.indexOf("#");
    if (cut !== -1) url = url.slice(0, cut);
    return url;
  }

  /* ── capability snapshot (see the header on the duplication) ──────────── */

  function capability() {
    var overrides = ATLAS.probeOverrides || {};
    var gl = detectWebgl();
    var conn = navigator.connection || null;
    return {
      deviceMemoryGB: pickNumber(overrides.deviceMemoryGB, navigator.deviceMemory),
      hardwareConcurrency: pickNumber(overrides.hardwareConcurrency, navigator.hardwareConcurrency),
      gpuTier: overrides.gpuTier || gl.gpuTier,
      webglVersion: gl.version,
      webgpuAvailable: "gpu" in navigator,
      webcodecsAvailable: typeof globalThis.VideoDecoder === "function",
      cameraPermission: rec.cameraPermission || "prompt",
      effectiveConnectionType: overrides.effectiveConnectionType || readEct(conn),
      downlinkMbps: pickNumber(overrides.downlinkMbps, conn && conn.downlink),
      rttMs: pickNumber(overrides.rttMs, conn && conn.rtt),
      reducedMotionPreferred: matchMedia("(prefers-reduced-motion: reduce)").matches,
      viewport: { width: Math.round(innerWidth), height: Math.round(innerHeight) },
      recentFrameTimeMsP95: pct(rec.frameTimes.slice().sort(function (a, b) { return a - b; }), 0.95)
    };
  }

  function detectWebgl() {
    var canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    var gl = null;
    var version = 0;
    try {
      gl = nativeGetContext.call(canvas, "webgl2");
      if (gl) version = 2;
    } catch (e) { gl = null; }
    if (!gl) {
      try {
        gl = nativeGetContext.call(canvas, "webgl");
        if (gl) version = 1;
      } catch (e) { gl = null; }
    }
    if (!gl) return { version: 0, gpuTier: "none" };
    var maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
    var maxVarying = gl.getParameter(gl.MAX_VARYING_VECTORS) || 0;
    var renderer = "";
    try {
      var ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (ext) renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "").toLowerCase();
    } catch (e) { renderer = ""; }
    var software = /swiftshader|llvmpipe|softwarerasterizer|microsoft basic render/.test(renderer);
    renderer = ""; // dropped before anything can capture it, as in capability-probe.js
    try { var lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext(); } catch (e) {}
    if (software) return { version: version, gpuTier: "low" };
    if (!maxTexture) return { version: version, gpuTier: "unknown" };
    if (maxTexture >= 16384 && maxVarying >= 30) return { version: version, gpuTier: "high" };
    if (maxTexture >= 8192) return { version: version, gpuTier: "mid" };
    return { version: version, gpuTier: "low" };
  }

  function readEct(conn) {
    var ect = conn && conn.effectiveType;
    return ect === "slow-2g" || ect === "2g" || ect === "3g" || ect === "4g" ? ect : "unknown";
  }

  function pickNumber(override, actual) {
    if (typeof override === "number" && isFinite(override)) return override;
    if (typeof actual === "number" && isFinite(actual)) return actual;
    return null;
  }

  /* ── checkpoints, over the same binding the Orbital recorder uses ─────── */

  function checkpoint(id, state) {
    var entry = { id: clip(id), tOffsetMs: now(), state: clip(state) };
    if (rec.checkpoints.length < 64) rec.checkpoints.push(entry);
    var bridge = globalThis[BINDING];
    if (typeof bridge !== "function") return Promise.resolve(false);
    globalThis.__atlasCheckpointAck = null;
    try {
      bridge(JSON.stringify({ type: "checkpoint", id: entry.id, state: entry.state }));
    } catch (e) {
      return Promise.resolve(false);
    }
    // The page blocks until the runner acknowledges, which is what makes the
    // screenshot a photograph of *this* state rather than of whatever came
    // next. Same 5s ceiling as experience/recorder.js.
    return new Promise(function (resolve) {
      var deadline = Date.now() + 5000;
      (function poll() {
        if (globalThis.__atlasCheckpointAck === entry.id) return resolve(true);
        if (Date.now() > deadline) {
          note('checkpoint "' + entry.id + '" was never acknowledged');
          return resolve(false);
        }
        setTimeout(poll, 25);
      })();
    });
  }

  /* ── public surface, driven from Node ─────────────────────────────────── */

  var api = {
    mark: mark,
    note: note,
    checkpoint: checkpoint,

    /** Set immediately before the runner dispatches an input event. */
    expectInput: function (inputClass) {
      rec.pendingInputClass = clip(inputClass) || null;
      return true;
    },

    /** Non-invasive support check; does not request or prompt for anything. */
    probeXrSupport: function (mode) {
      if (!navigator.xr || typeof navigator.xr.isSessionSupported !== "function") {
        rec.xrSupported = false;
        return Promise.resolve(false);
      }
      return navigator.xr.isSessionSupported(mode || "immersive-vr").then(
        function (ok) { rec.xrSupported = Boolean(ok); return Boolean(ok); },
        function () { rec.xrSupported = false; return false; }
      );
    },

    /**
     * Counts what the page put on screen, so "does it render something usable
     * without XR?" is a measurement rather than an impression. Structure only:
     * no text content, no attribute values, no innerHTML is read.
     */
    surface: function () {
      var canvasCount = document.getElementsByTagName("canvas").length;
      var visibleCanvas = 0;
      var canvasPixels = 0;
      var list = document.getElementsByTagName("canvas");
      for (var i = 0; i < list.length; i++) {
        var box = list[i].getBoundingClientRect();
        if (box.width > 8 && box.height > 8) {
          visibleCanvas++;
          canvasPixels += box.width * box.height;
        }
      }
      var body = document.body;
      return {
        canvasCount: canvasCount,
        visibleCanvasCount: visibleCanvas,
        canvasViewportRatio: Math.round((canvasPixels / Math.max(1, innerWidth * innerHeight)) * 1000) / 1000,
        elementCount: document.getElementsByTagName("*").length,
        imageCount: document.getElementsByTagName("img").length,
        videoCount: document.getElementsByTagName("video").length,
        buttonCount: document.querySelectorAll("button,[role=button],a[href]").length,
        bodyScrollHeight: body ? body.scrollHeight : 0,
        readyState: document.readyState,
        firstFrameMs: rec.firstFrameMs,
        xrPresent: rec.xrPresent,
        xrStub: rec.xrStub,
        xrSupported: rec.xrSupported,
        xrSessions: rec.xrSessionEvents.length,
        // Phase names only ("request", "session-start", "session-refused",
        // "session-end", "unavailable"). The driver polls this to decide what
        // the app did with its XR attempt; it is a fixed vocabulary, never
        // page-supplied text.
        xrPhases: rec.xrSessionEvents.map(function (e) { return e.phase; }),
        firstNonBlankMs: rec.firstNonBlankMs,
        errorCount: rec.consoleErrors.length,
        frameSamples: rec.frameTimes.length
      };
    },

    /**
     * Finds the element most likely to start an XR session, by the attributes
     * the platforms actually ship: WebXR's own `xr-*` ids, model-viewer's AR
     * button, 8th Wall's start overlay. Returns a selector the runner can tap,
     * never a synthesised click — the app's own handler has to run.
     */
    findXrTrigger: function () {
      var selectors = [
        "[data-atlas-target=xr]",
        "#ARButton", "#VRButton", ".ar-button", ".vr-button",
        "[slot=ar-button]", "button[slot=ar-button]",
        "#xr-button", ".xr-button", "[data-xr]",
        ".xrweb-start", ".prompt-box-8w button", "#requestButton"
      ];
      for (var i = 0; i < selectors.length; i++) {
        var el = null;
        try { el = document.querySelector(selectors[i]); } catch (e) { el = null; }
        if (!el) continue;
        var box = el.getBoundingClientRect();
        if (box.width < 4 || box.height < 4) continue;
        var style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        return { selector: selectors[i], x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
      return null;
    },

    finish: function () {
      flushFrames();
      globalThis.__atlasDone = true;
      return true;
    },

    /**
     * The payload. Field-for-field the shape `src/trace/assemble.js` accepts,
     * so a generic capture and an Orbital capture become canonical traces
     * through exactly one implementation of the schema.
     */
    payload: function () {
      flushFrames();
      var observed = collectAssets();
      push("session-end", "lifecycle", { state: rec.states[rec.states.length - 1] || "unknown" });

      if (!rec.canvasSamplingStopped) {
        note(
          "preserveDrawingBuffer was forced on for every WebGL context so the first " +
          "non-blank frame could be timestamped from inside the page; frame times are " +
          "therefore very slightly pessimistic versus the same app unobserved"
        );
      }
      if (rec.frameTimesTruncated) {
        note("frame-time series truncated at " + MAX_FRAME_SAMPLES + " samples");
      }
      if (rec.firstNonBlankMs === null && !rec.canvasSamplingStopped) {
        note("no canvas ever reached the non-blank luma threshold from inside the page");
      }

      return {
        traceId: ATLAS.traceId || "generic-" + Date.now().toString(36),
        profileId: ATLAS.profileId || "unknown",
        runKind: ATLAS.runKind || "production",
        emulated: ATLAS.emulated !== false,
        seed: typeof ATLAS.seed === "number" ? ATLAS.seed : 0,
        capability: capability(),
        // No tier router is in the loop on a third-party page: Atlas did not
        // choose what this app served. The runner fills these in from what it
        // *measured* the page deliver (src/runner/classify-delivery.js).
        decision: null,
        servedTier: null,
        servedPath: null,
        states: rec.states,
        events: rec.events,
        checkpoints: rec.checkpoints,
        inputClasses: rec.inputClasses,
        durationMs: now(),
        notes: rec.notes,
        observedTransferBytes: observed,
        frameTimes: rec.frameTimes,
        xrSessionEvents: rec.xrSessionEvents,
        consoleErrors: rec.consoleErrors
      };
    }
  };

  try {
    Object.defineProperty(globalThis, "__atlasGeneric", {
      value: api, writable: false, configurable: false, enumerable: false
    });
  } catch (e) {
    globalThis.__atlasGeneric = api;
  }

  /* ── start ────────────────────────────────────────────────────────────── */

  mark("boot");
  mark("probing");

  // Camera permission, observed without prompting — the same rule as
  // capability-probe.js: a missing Permissions API means "prompt", not
  // "granted".
  rec.cameraPermission = "prompt";
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    rec.cameraPermission = "unavailable";
  } else if (navigator.permissions && navigator.permissions.query) {
    try {
      navigator.permissions.query({ name: "camera" }).then(function (status) {
        if (status && (status.state === "granted" || status.state === "denied" || status.state === "prompt")) {
          rec.cameraPermission = status.state;
        }
      }, function () {});
    } catch (e) { /* not implemented for "camera" here */ }
  }

  requestAnimationFrame(onFrame);
  setInterval(sampleNonBlank, 100);

  mark("loading");

  /* `first-frame` is marked at first *paint*, not at DOMContentLoaded.
     `deriveMetrics` reads the event named "first-frame" as the time-to-first-
     frame metric, and on a heavy WebGL app DOMContentLoaded fires seconds
     before anything reaches the screen — marking it there would report a
     flattering number and, worse, would make the runner photograph a blank
     page for the visual invariant and fail every app in the matrix.

     Order of preference: the browser's own first-contentful-paint entry, then
     the first rAF after `load`. Both are recorded as the `reason` so the report
     can say which one answered. */
  var paintMarked = false;

  function markFirstFrame(reason) {
    if (paintMarked) return;
    paintMarked = true;
    rec.firstFrameMs = now();
    push("first-frame-source", "lifecycle", { reason: reason });
    mark("first-frame");
  }

  if (typeof PerformanceObserver === "function") {
    try {
      new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].name === "first-contentful-paint") markFirstFrame("first-contentful-paint");
        }
      }).observe({ type: "paint", buffered: true });
    } catch (e) { /* paint timing unsupported; the load fallback covers it */ }
  }

  function onLoaded() {
    // One rAF past `load`: the frame that contains whatever `load` unblocked.
    requestAnimationFrame(function () { markFirstFrame("load+raf"); });
  }

  if (document.readyState === "complete") onLoaded();
  else addEventListener("load", onLoaded, { once: true });
})();
