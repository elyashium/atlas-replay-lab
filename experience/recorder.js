/**
 * Privacy-safe flight recorder (page side).
 *
 * Records what happened, never what was shown or typed. Concretely:
 *
 *  - Interactions are recorded as a class label plus a latency. Never
 *    coordinates, never element text, never input values. `tap:add-to-cart`
 *    is the entire record of a tap.
 *  - No camera or audio data touches this module. The camera path renders the
 *    stream straight to a <video> element; no frame is ever read back, drawn
 *    into a canvas, or serialised. There is no code path here that could.
 *  - Times are offsets from the recorder's own t0, never wall clocks.
 *  - Byte counts come from PerformanceResourceTiming, which reports sizes, not
 *    contents.
 *
 * The recorder emits a *partial* trace. The canonical Trace object, its
 * derived metrics and its determinism hash are assembled server-side by
 * src/trace/schema.js, so that a live capture and a replayed capture go
 * through exactly one implementation of the schema rather than two that can
 * drift.
 *
 * @typedef {import("../types/atlas.js").TraceEvent} TraceEvent
 * @typedef {import("../types/atlas.js").TraceEventKind} TraceEventKind
 * @typedef {import("../types/atlas.js").ExperienceState} ExperienceState
 */

const bridge = /** @type {any} */ (globalThis).__atlasBinding ?? null;

export class Recorder {
  /**
   * @param {{ traceId: string; profileId: string; runKind: string; emulated: boolean; seed: number }} init
   */
  constructor(init) {
    this.traceId = init.traceId;
    this.profileId = init.profileId;
    this.runKind = init.runKind;
    this.emulated = init.emulated;
    // Recorded because replay determinism is conditional on it. A replay that
    // ran under a different seed is not a failed replay, it is a different
    // session — and the replay report needs to be able to tell those apart.
    this.seed = init.seed;

    this.t0 = performance.now();
    /** @type {TraceEvent[]} */
    this.events = [];
    /** @type {ExperienceState[]} */
    this.states = [];
    /** @type {Array<{ id: string; state: ExperienceState; tOffsetMs: number; screenshotPath: string | null }>} */
    this.checkpoints = [];
    /** @type {string[]} */
    this.inputClasses = [];
    /** @type {string[]} */
    this.notes = [];

    /** @type {number | null} */
    this._rafHandle = null;
    this._frames = { rendered: 0, dropped: 0 };
    /** @type {number[]} */
    this._frameTimes = [];
    this._lastFrameAt = 0;
    this._targetFrameMs = 1000 / 60;
    /** @type {number | null} */
    this._sampleTimer = null;
  }

  /** ms since the recorder started, rounded to 0.1ms. */
  now() {
    return Math.round((performance.now() - this.t0) * 10) / 10;
  }

  /**
   * @param {string} name
   * @param {TraceEventKind} kind
   * @param {Record<string, string | number | boolean | null>} [attributes]
   */
  event(name, kind, attributes = {}) {
    /** @type {TraceEvent} */
    const e = { tOffsetMs: this.now(), name, kind, attributes };
    this.events.push(e);
    this._bridge({ type: "event", event: e });
    return e;
  }

  /**
   * Records a state transition. The legality of the transition is checked
   * server-side against the manifest's allowedTransitions — the page records
   * what happened, the gate decides whether it was allowed. Keeping those
   * apart is what lets the recorder capture an illegal transition instead of
   * hiding it.
   *
   * @param {ExperienceState} next
   */
  state(next) {
    const from = this.states[this.states.length - 1] ?? null;
    this.states.push(next);
    this.event(`state:${next}`, "state", { from, to: next });
    this._bridge({ type: "state", state: next, tOffsetMs: this.now() });
    return next;
  }

  /**
   * @param {{ assetId: string; kind: string; ok: boolean; bytes: number; critical: boolean; durationMs: number }} a
   */
  asset(a) {
    this.event(`asset:${a.assetId}`, "asset", {
      assetId: a.assetId,
      kind: a.kind,
      ok: a.ok,
      critical: a.critical,
      bytes: Math.round(a.bytes),
      durationMs: Math.round(a.durationMs * 10) / 10,
    });
  }

  /**
   * @param {{ inputClass: string; target: string; latencyMs: number; index: number }} i
   */
  interaction(i) {
    this.inputClasses.push(i.inputClass);
    this.event(`interaction:${i.target}`, "interaction", {
      inputClass: i.inputClass,
      target: i.target,
      index: i.index,
      latencyMs: Math.round(i.latencyMs * 10) / 10,
    });
  }

  /**
   * @param {import("../types/atlas.js").TierDecision} decision
   * @param {number} latencyMs
   */
  decision(decision, latencyMs) {
    this.event("decision:tier", "decision", {
      engine: decision.engine,
      tier: decision.tier,
      path: decision.path,
      confidence: Math.round(decision.confidence * 1e4) / 1e4,
      guardOverridden: Boolean(decision.guard?.overridden),
      latencyMs: Math.round(latencyMs * 10) / 10,
    });
  }

  /**
   * @param {string} code
   * @param {boolean} fatal
   * @param {Record<string, string | number | boolean | null>} [extra]
   */
  error(code, fatal, extra = {}) {
    this.event(`error:${code}`, "error", { code, fatal, ...extra });
  }

  /**
   * Announces a checkpoint. The runner is listening on the bridge and takes
   * the screenshot; the page does not screenshot itself, so no pixel data ever
   * passes through page JavaScript.
   *
   * @param {string} id
   * @param {ExperienceState} state
   */
  async checkpoint(id, state) {
    const tOffsetMs = this.now();
    this.checkpoints.push({ id, state, tOffsetMs, screenshotPath: null });
    this._bridge({ type: "checkpoint", id, state, tOffsetMs });
    if (!bridge) return;
    // Give the runner a moment to capture before the next state mutates the
    // DOM. The runner acknowledges by setting __atlasCheckpointAck.
    await waitFor(() => /** @type {any} */ (globalThis).__atlasCheckpointAck === id, 5000);
  }

  /** @param {number} targetFps */
  startFrameSampling(targetFps) {
    this._targetFrameMs = 1000 / Math.max(1, targetFps);
    this._lastFrameAt = performance.now();

    const tick = () => {
      const now = performance.now();
      const delta = now - this._lastFrameAt;
      this._lastFrameAt = now;
      this._frames.rendered++;
      this._frameTimes.push(delta);
      // A frame budget missed by more than one whole interval means at least
      // one frame the compositor never got. Counting whole missed intervals
      // rather than "was it slow" keeps this comparable to a real dropped
      // frame count.
      if (delta > this._targetFrameMs * 1.5) {
        this._frames.dropped += Math.max(1, Math.round(delta / this._targetFrameMs) - 1);
      }
      this._rafHandle = requestAnimationFrame(tick);
    };
    this._rafHandle = requestAnimationFrame(tick);

    this._sampleTimer = /** @type {any} */ (
      setInterval(() => this._flushFrameSample(), 500)
    );
  }

  stopFrameSampling() {
    if (this._rafHandle !== null) cancelAnimationFrame(this._rafHandle);
    if (this._sampleTimer !== null) clearInterval(this._sampleTimer);
    this._rafHandle = null;
    this._sampleTimer = null;
    this._flushFrameSample();
  }

  /** p95 of recent frame times — fed back into the adaptive re-decision. */
  recentFrameTimeMsP95() {
    if (!this._frameTimes.length) return null;
    const sorted = [...this._frameTimes].slice(-240).sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return Math.round(sorted[idx] * 10) / 10;
  }

  _flushFrameSample() {
    if (!this._frames.rendered && !this._frames.dropped) return;
    const heap = /** @type {any} */ (performance).memory?.usedJSHeapSize;
    this.event("frames", "frame", {
      rendered: this._frames.rendered,
      dropped: this._frames.dropped,
      p95FrameTimeMs: this.recentFrameTimeMsP95(),
      jsHeapUsedMB: typeof heap === "number" ? Math.round((heap / 1048576) * 10) / 10 : null,
    });
    this._frames = { rendered: 0, dropped: 0 };
  }

  /**
   * Reads transferred byte counts from the Resource Timing API. Sizes only —
   * this API does not expose response bodies.
   */
  collectResourceBytes() {
    /** @type {PerformanceResourceTiming[]} */
    const entries = /** @type {any} */ (performance.getEntriesByType("resource"));
    let total = 0;
    for (const entry of entries) {
      // transferSize is 0 for cached responses; the server sends no-store, so
      // a 0 here means a cross-origin opaque timing, which this demo has none of.
      total += entry.transferSize || entry.encodedBodySize || 0;
    }
    return Math.round(total);
  }

  /**
   * @param {{
   *   capability: import("../types/atlas.js").CapabilitySnapshot;
   *   decision: import("../types/atlas.js").TierDecision | null;
   *   servedTier: string | null;
   *   servedPath: string | null;
   * }} final
   */
  toPayload(final) {
    this.stopFrameSampling();
    return {
      traceId: this.traceId,
      profileId: this.profileId,
      runKind: this.runKind,
      emulated: this.emulated,
      seed: this.seed,
      capability: final.capability,
      decision: final.decision,
      servedTier: final.servedTier,
      servedPath: final.servedPath,
      states: this.states,
      events: this.events,
      checkpoints: this.checkpoints,
      inputClasses: this.inputClasses,
      durationMs: this.now(),
      notes: this.notes,
      observedTransferBytes: this.collectResourceBytes(),
    };
  }

  /** @param {unknown} msg */
  _bridge(msg) {
    if (!bridge) return;
    try {
      bridge(JSON.stringify(msg));
    } catch {
      /* The bridge is a debugging affordance for the runner; never fatal. */
    }
  }
}

/**
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 */
function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const started = performance.now();
    const poll = () => {
      if (predicate() || performance.now() - started > timeoutMs) return resolve(undefined);
      setTimeout(poll, 8);
    };
    poll();
  });
}
