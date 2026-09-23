/**
 * Drives a session against an app nobody wrote for us.
 *
 * `drive.js` walks the Orbital purchase flow by `data-atlas-target`, because
 * Orbital was built with that attribute in it. A stranger's WebXR app has no
 * such contract, no announced states, and no checkout. So this driver stops
 * asking the page what it is and instead does the only three things that are
 * meaningful against any of them:
 *
 *   1. **Wait for it to settle** — and measure how long that took, rather than
 *      assuming a fixed budget.
 *   2. **Look around** — a seeded drag path, which is what a user does to a 3D
 *      scene and what makes the frame-time series worth recording. An app that
 *      holds 60fps while nothing moves has proven nothing.
 *   3. **Try to enter XR** — by tapping the app's *own* trigger, so the app's
 *      own handler runs, and then recording what happened either way. The
 *      refusal path is the interesting one: a session that cannot start must
 *      still leave a usable page (Slice 2's `accessibleFallback`).
 *
 * ## The generic spine
 *
 * `boot → probing → loading → first-frame` come from the probe; this driver
 * adds `interactive → looking → xr-session? → session-complete`. Every one of
 * those is declared in `src/manifest/generic.manifest.js`, so the trace is
 * validated against a contract the same way an Orbital trace is.
 *
 * `session-complete` is the generic business invariant and it is deliberately
 * not free. It is entered only when all three hold:
 *
 *   - `interactive` was reached (the page settled and accepted input),
 *   - the look-around completed without a fatal page error,
 *   - the XR attempt was resolved one way or the other — started, refused, or
 *     honestly recorded as unavailable.
 *
 * A third-party app has no checkout to complete, so that is what "the session
 * did what a session is for" has to mean here. It is our invariant, we own it,
 * and it can fail — which is the only reason it is worth having.
 *
 * ## What it never does
 *
 * No synthesised `click()` on an element's handler, no reaching into app
 * internals, no evaluating anything the page supplies. Input arrives as real
 * CDP input events; everything read back out of the page is a number or a
 * boolean the probe computed. The page is observed, not negotiated with.
 *
 * @typedef {import("./cdp.js").CdpSession} CdpSession
 */

import { sleep, waitForPage } from "./drive.js";
import { streamFrom } from "../util/rng.js";
import { logger } from "../util/log.js";

const log = logger("drive-generic");

/** The states this driver is responsible for, in order. */
export const GENERIC_SPINE = ["interactive", "looking", "session-complete"];

/**
 * @typedef {object} GenericDriveResult
 * @property {string[]} completed            spine steps reached, in order
 * @property {string | null} failedAt        the step that did not complete
 * @property {string | null} error           why, if it failed
 * @property {number | null} settledAtMs     when the DOM/resource graph stopped changing
 * @property {boolean} settled               false = hit the settle cap still changing
 * @property {number} looks                  drag gestures dispatched
 * @property {GenericXrResult} xr
 * @property {Record<string, unknown> | null} surface  the probe's final surface read
 */

/**
 * @typedef {object} GenericXrResult
 * @property {boolean} supported             `isSessionSupported` for the probed mode
 * @property {string | null} trigger         selector tapped, if one was found
 * @property {"started" | "refused" | "no-trigger" | "unavailable" | "no-response"} outcome
 * @property {number} sessions               XR lifecycle events the probe saw
 */

/**
 * @param {CdpSession} session
 * @param {{
 *   mobile: boolean;
 *   seed: number;
 *   viewport: { width: number; height: number };
 *   stepTimeoutMs?: number;
 *   settleQuietMs?: number;
 *   settleCapMs?: number;
 *   lookMs?: number;
 *   attemptXr?: boolean;
 *   xrMode?: string;
 * }} opts
 * @returns {Promise<GenericDriveResult>}
 */
export async function driveGeneric(session, opts) {
  const stepTimeoutMs = opts.stepTimeoutMs ?? 45_000;
  /** @type {string[]} */
  const completed = [];
  /** @type {GenericXrResult} */
  const xr = { supported: false, trigger: null, outcome: "unavailable", sessions: 0 };

  // The probe is registered before navigation, so if it is missing the
  // injection channel failed and nothing downstream is trustworthy.
  try {
    await waitForPage(session, 'typeof globalThis.__atlasGeneric === "object"', {
      timeoutMs: 15_000,
      label: "the generic probe to install",
    });
  } catch (err) {
    return {
      completed,
      failedAt: "probe",
      error: message(err),
      settledAtMs: null,
      settled: false,
      looks: 0,
      xr,
      surface: null,
    };
  }

  /* ── 1. settle ─────────────────────────────────────────────────────────── */

  const settle = await waitForSettle(session, {
    quietMs: opts.settleQuietMs ?? 1_200,
    capMs: opts.settleCapMs ?? Math.min(stepTimeoutMs, 30_000),
  });

  if (!settle.settled) {
    await note(session, `page was still changing after ${settle.capMs}ms; treated as settled`);
  }

  // Taken here rather than at `load`: this is the first moment a photograph of
  // the page means "what a user would see", and session.js measures the visual
  // invariant from exactly this file.
  await checkpoint(session, "cp-first-frame", "first-frame");

  await mark(session, "interactive");
  completed.push("interactive");
  await checkpoint(session, "cp-interactive", "interactive");

  /* ── 2. look around ────────────────────────────────────────────────────── */

  await mark(session, "looking");
  let looks = 0;
  try {
    looks = await lookAround(session, {
      mobile: opts.mobile,
      seed: opts.seed,
      viewport: opts.viewport,
      durationMs: opts.lookMs ?? 4_000,
    });
    completed.push("looking");
  } catch (err) {
    // A failed gesture is a finding, not a crash: the trace and the report row
    // still get written, which is the whole point of driving defensively. The
    // recorder is closed here rather than left open, because everything it
    // captured up to the failure is the evidence for *why* it failed, and a
    // harvest of an unflushed recorder would lose the last frame bucket.
    log.warn(`look-around failed: ${message(err)}`);
    await note(session, `scripted look-around failed: ${message(err)}`);
    const surfaceAtFailure = await surface(session);
    await session.evaluate("globalThis.__atlasGeneric.finish()").catch(() => {});
    return {
      completed,
      failedAt: "looking",
      error: message(err),
      settledAtMs: settle.atMs,
      settled: settle.settled,
      looks,
      xr,
      surface: surfaceAtFailure,
    };
  }

  await checkpoint(session, "cp-after-look", "looking");

  /* ── 3. attempt XR ─────────────────────────────────────────────────────── */

  if (opts.attemptXr !== false) {
    Object.assign(xr, await attemptXr(session, { mobile: opts.mobile, mode: opts.xrMode ?? "immersive-vr" }));
    if (xr.outcome === "started" || xr.outcome === "refused") {
      await mark(session, "xr-session");
      await checkpoint(session, "cp-xr", "xr-session");
    }
  } else {
    xr.outcome = "unavailable";
    await note(session, "XR entry was not attempted on this profile");
  }

  /* ── 4. close the session ──────────────────────────────────────────────── */

  const final = await surface(session);
  await mark(session, "session-complete");
  completed.push("session-complete");
  await checkpoint(session, "cp-final", "session-complete");

  await session.evaluate("globalThis.__atlasGeneric.finish()").catch(() => {});

  return {
    completed,
    failedAt: null,
    error: null,
    settledAtMs: settle.atMs,
    settled: settle.settled,
    looks,
    xr,
    surface: final,
  };
}

/* ── settle detection ─────────────────────────────────────────────────────── */

/**
 * Waits until the page stops growing.
 *
 * "Loaded" is the wrong signal for a WebGL app: `load` fires, then a few
 * megabytes of textures stream in and the DOM sprouts an overlay. So this
 * watches a cheap fingerprint — element count, canvas count, resource count,
 * total transferred bytes — and calls it settled once that fingerprint holds
 * still for `quietMs`.
 *
 * Bytes are in the fingerprint on purpose: a single large asset arriving
 * changes no counts at all, and an app that is still pulling a 12MB texture is
 * emphatically not settled.
 *
 * The cap is not a failure. An app that never stops changing (an animated
 * scene that keeps streaming LODs) is a real and common shape; we record that
 * it never went quiet and carry on, because the frame-time series is the
 * measurement that matters and it needs the session to proceed.
 *
 * @param {CdpSession} session
 * @param {{ quietMs: number; capMs: number }} opts
 * @returns {Promise<{ settled: boolean; atMs: number | null; capMs: number }>}
 */
async function waitForSettle(session, opts) {
  const started = Date.now();
  let previous = "";
  let quietSince = 0;

  for (;;) {
    const fingerprint = await session
      .evaluate(`(() => {
        let bytes = 0;
        let count = 0;
        try {
          for (const e of performance.getEntriesByType("resource")) {
            bytes += e.transferSize || e.encodedBodySize || 0;
            count++;
          }
        } catch (err) { /* resource timing unavailable */ }
        return [
          document.readyState,
          document.getElementsByTagName("*").length,
          document.getElementsByTagName("canvas").length,
          count,
          bytes
        ].join(":");
      })()`)
      .catch(() => null);

    const now = Date.now();

    if (typeof fingerprint === "string" && fingerprint.startsWith("complete:")) {
      if (fingerprint === previous) {
        if (quietSince && now - quietSince >= opts.quietMs) {
          return { settled: true, atMs: now - started, capMs: opts.capMs };
        }
        if (!quietSince) quietSince = now;
      } else {
        quietSince = 0;
      }
    } else {
      quietSince = 0;
    }
    previous = typeof fingerprint === "string" ? fingerprint : "";

    if (now - started > opts.capMs) {
      return { settled: false, atMs: null, capMs: opts.capMs };
    }
    await sleep(120);
  }
}

/* ── the look-around ──────────────────────────────────────────────────────── */

/**
 * Dispatches a seeded sequence of drag gestures across the largest canvas.
 *
 * Seeded, so two runs of the same profile produce the same gestures and the
 * frame-time series they provoke is comparable. Drags rather than taps, because
 * orbit controls — three.js `OrbitControls`, PlayCanvas, 8th Wall's own — all
 * listen for pointer *movement*, and a tap tells you nothing about whether the
 * scene can be turned.
 *
 * Coordinates stay inside the canvas's box and away from its edges, where UI
 * overlays live: dragging a "share" button is not a look-around.
 *
 * @param {CdpSession} session
 * @param {{ mobile: boolean; seed: number; viewport: { width: number; height: number }; durationMs: number }} opts
 * @returns {Promise<number>}  gestures dispatched
 */
async function lookAround(session, opts) {
  const box = await largestCanvasBox(session, opts.viewport);
  const rnd = streamFrom(opts.seed, 0x100c);
  const deadline = Date.now() + opts.durationMs;

  // Inset 15% so the gesture lands on the scene, not on chrome pinned to the
  // canvas edge.
  const insetX = box.width * 0.15;
  const insetY = box.height * 0.15;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  let dispatched = 0;
  while (Date.now() < deadline && dispatched < 6) {
    const angle = rnd() * Math.PI * 2;
    const reach = 0.35 + rnd() * 0.5;
    const fromX = Math.round(cx - Math.cos(angle) * (box.width / 2 - insetX) * reach * 0.5);
    const fromY = Math.round(cy - Math.sin(angle) * (box.height / 2 - insetY) * reach * 0.5);
    const toX = Math.round(cx + Math.cos(angle) * (box.width / 2 - insetX) * reach * 0.5);
    const toY = Math.round(cy + Math.sin(angle) * (box.height / 2 - insetY) * reach * 0.5);

    await drag(session, { fromX, fromY, toX, toY, mobile: opts.mobile, steps: 12 });
    dispatched++;
    // Let the scene react and the frame recorder accumulate samples between
    // gestures; back-to-back drags measure the input pipeline, not rendering.
    await sleep(320);
  }

  log.debug(`look-around: ${dispatched} gestures`);
  return dispatched;
}

/**
 * One drag, as touch or mouse, with interpolated intermediate moves.
 *
 * The intermediate moves are the point. A press followed by a release at a
 * different coordinate is not a drag to any orbit control ever written; they
 * integrate movement deltas, so the gesture has to actually move.
 *
 * @param {CdpSession} session
 * @param {{ fromX: number; fromY: number; toX: number; toY: number; mobile: boolean; steps: number }} g
 */
async function drag(session, g) {
  // Labels the interaction the probe is about to time. Sent before the press,
  // because the probe's capture-phase listener fires the moment it lands.
  await session
    .evaluate(`globalThis.__atlasGeneric.expectInput(${JSON.stringify("drag:look")})`)
    .catch(() => {});

  if (g.mobile) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: g.fromX, y: g.fromY, radiusX: 12, radiusY: 12, force: 1 }],
    });
    for (let i = 1; i <= g.steps; i++) {
      const t = i / g.steps;
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: Math.round(g.fromX + (g.toX - g.fromX) * t),
            y: Math.round(g.fromY + (g.toY - g.fromY) * t),
            radiusX: 12,
            radiusY: 12,
            force: 1,
          },
        ],
      });
      await sleep(16);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return;
  }

  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: g.fromX,
    y: g.fromY,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let i = 1; i <= g.steps; i++) {
    const t = i / g.steps;
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(g.fromX + (g.toX - g.fromX) * t),
      y: Math.round(g.fromY + (g.toY - g.fromY) * t),
      button: "left",
      buttons: 1,
    });
    await sleep(16);
  }
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: g.toX,
    y: g.toY,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

/**
 * The biggest canvas box, or the viewport if the page has no canvas at all.
 *
 * No canvas is not an error here — a page that fell back to a static poster is
 * a legitimate outcome and still deserves a look-around against its body.
 *
 * @param {CdpSession} session
 * @param {{ width: number; height: number }} viewport
 * @returns {Promise<{ x: number; y: number; width: number; height: number }>}
 */
async function largestCanvasBox(session, viewport) {
  const raw = await session
    .evaluate(`(() => {
      let best = null;
      for (const c of document.getElementsByTagName("canvas")) {
        const r = c.getBoundingClientRect();
        if (r.width < 32 || r.height < 32) continue;
        if (!best || r.width * r.height > best.width * best.height) {
          best = { x: r.x, y: r.y, width: r.width, height: r.height };
        }
      }
      return best;
    })()`)
    .catch(() => null);

  if (raw && typeof raw.width === "number" && raw.width >= 32) {
    // Clamped to the viewport: a canvas can extend past it, and an input event
    // dispatched at a coordinate off-screen is discarded.
    const x = Math.max(0, raw.x);
    const y = Math.max(0, raw.y);
    return {
      x,
      y,
      width: Math.min(raw.width, viewport.width - x),
      height: Math.min(raw.height, viewport.height - y),
    };
  }
  return { x: 0, y: 0, width: viewport.width, height: viewport.height };
}

/* ── XR entry ─────────────────────────────────────────────────────────────── */

/**
 * Tries to enter XR the way a user would: find the app's own button, tap it,
 * watch what the app's handler does.
 *
 * Deliberately *not* `navigator.xr.requestSession()` from the driver. Calling
 * it ourselves would prove the stub works, which we already know, and would
 * prove nothing about the app — including the thing most likely to be broken,
 * which is the app's own handling of a refusal.
 *
 * `no-trigger` is a finding, not a failure. Plenty of apps enter XR from a
 * gesture or automatically, and the report says "we could not find an entry
 * point" rather than pretending XR was tested.
 *
 * @param {CdpSession} session
 * @param {{ mobile: boolean; mode: string }} opts
 * @returns {Promise<GenericXrResult>}
 */
async function attemptXr(session, opts) {
  /** @type {GenericXrResult} */
  const result = { supported: false, trigger: null, outcome: "unavailable", sessions: 0 };

  const supported = await session
    .evaluate(`globalThis.__atlasGeneric.probeXrSupport(${JSON.stringify(opts.mode)})`, {
      awaitPromise: true,
    })
    .catch(() => false);
  result.supported = supported === true;

  const before = (await xrPhases(session)).length;

  const trigger = await session.evaluate("globalThis.__atlasGeneric.findXrTrigger()").catch(() => null);
  if (!trigger || typeof trigger.x !== "number") {
    result.outcome = result.supported ? "no-trigger" : "unavailable";
    await note(
      session,
      result.supported
        ? "XR was supported but no entry control could be located; XR entry is untested for this app"
        : "XR was not supported in this profile and no entry control was found",
    );
    return result;
  }

  result.trigger = String(trigger.selector ?? "unknown");
  await session
    .evaluate(`globalThis.__atlasGeneric.expectInput(${JSON.stringify("tap:xr-entry")})`)
    .catch(() => {});

  const x = Math.round(trigger.x);
  const y = Math.round(trigger.y);
  if (opts.mobile) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1 }],
    });
    await sleep(55);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    const base = { x, y, button: "left", buttons: 1, clickCount: 1 };
    await session.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await sleep(55);
    await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 });
  }

  // The app's handler may gate the request behind its own async work, so give
  // it a real window before concluding nothing happened.
  const deadline = Date.now() + 6_000;
  for (;;) {
    const phases = await xrPhases(session);
    result.sessions = phases.length;
    if (phases.includes("session-start")) {
      result.outcome = "started";
      break;
    }
    if (phases.includes("session-refused")) {
      result.outcome = "refused";
      break;
    }
    if (Date.now() > deadline) {
      result.outcome = phases.length > before ? "refused" : "no-response";
      break;
    }
    await sleep(150);
  }

  if (result.outcome === "no-response") {
    await note(
      session,
      `tapped "${result.trigger}" but the page never requested an XR session; XR entry is untested for this app`,
    );
  }
  if (result.outcome === "started") {
    // Let the app render from the scripted pose path before the screenshot, so
    // the checkpoint photographs a posed frame rather than the transition.
    await sleep(900);
  }

  return result;
}

/**
 * The XR phases the probe has observed so far, oldest first.
 *
 * A fixed vocabulary the probe owns — "request", "session-start",
 * "session-refused", "session-end", "unavailable" — so polling it is reading a
 * counter, not parsing anything the page wrote.
 *
 * @param {CdpSession} session
 * @returns {Promise<string[]>}
 */
async function xrPhases(session) {
  const raw = await session
    .evaluate('(() => { const s = globalThis.__atlasGeneric.surface(); return s && s.xrPhases ? s.xrPhases : []; })()')
    .catch(() => []);
  return Array.isArray(raw) ? raw.map(String) : [];
}

/* ── small page calls ─────────────────────────────────────────────────────── */

/** @param {CdpSession} session @param {string} state */
function mark(session, state) {
  return session.evaluate(`globalThis.__atlasGeneric.mark(${JSON.stringify(state)})`).catch(() => {});
}

/** @param {CdpSession} session @param {string} text */
function note(session, text) {
  return session.evaluate(`globalThis.__atlasGeneric.note(${JSON.stringify(text)})`).catch(() => {});
}

/**
 * Announces a checkpoint and waits for the runner's screenshot acknowledgement.
 *
 * `awaitPromise` matters: the page's `checkpoint()` resolves only once
 * `session.js` has written the PNG and set the ack, which is what makes the
 * screenshot a photograph of this state rather than of the next one.
 *
 * @param {CdpSession} session
 * @param {string} id
 * @param {string} state
 */
function checkpoint(session, id, state) {
  return session
    .evaluate(`globalThis.__atlasGeneric.checkpoint(${JSON.stringify(id)}, ${JSON.stringify(state)})`, {
      awaitPromise: true,
      timeoutMs: 20_000,
    })
    .catch((err) => {
      log.warn(`checkpoint ${id} was not acknowledged: ${message(err)}`);
    });
}

/** @param {CdpSession} session */
async function surface(session) {
  const raw = await session.evaluate("globalThis.__atlasGeneric.surface()").catch(() => null);
  return raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : null;
}

/** @param {unknown} err */
function message(err) {
  return err instanceof Error ? err.message : String(err);
}
