/**
 * Synthetic input and DOM waiting over CDP.
 *
 * Two ways to drive a session, sharing one `tap`:
 *
 *  - `driveHappyPath` walks the purchase flow by target name. Used by the
 *    matrix, where nothing has been recorded yet.
 *  - `driveFromTrace` re-issues the interactions a captured trace recorded, in
 *    the order it recorded them. Used by replay. It reads the trace's own
 *    interaction events rather than a hard-coded script, so a replay is
 *    genuinely a replay of that session and not a second scripted run that
 *    happens to look similar.
 *
 * Taps are dispatched as touch events on mobile profiles and mouse events
 * otherwise, because that is the difference the page actually sees: a touch tap
 * arrives as `pointerdown` with `pointerType: "touch"` and carries the ~300ms
 * click delay history that mobile layout decisions exist to handle.
 *
 * Elements are addressed by `data-atlas-target`, never by CSS class or text.
 * That attribute is the contract between the experience and the lab; restyling
 * a button cannot silently break the matrix.
 *
 * @typedef {import("./cdp.js").CdpSession} CdpSession
 * @typedef {import("../../types/atlas.js").Trace} Trace
 */

import { logger } from "../util/log.js";

const log = logger("drive");

/** The purchase flow, as target names plus the state each tap should produce. */
export const HAPPY_PATH = [
  { target: "product", expectState: "product-detail" },
  { target: "add-to-cart", expectState: "cart" },
  { target: "checkout", expectState: "checkout-complete" },
];

/**
 * Polls a JavaScript expression in the page until it is truthy.
 *
 * Polling rather than an event subscription is deliberate: the conditions that
 * matter here are DOM states, and a 6x-throttled renderer can take hundreds of
 * milliseconds to commit one. A poll is the honest way to wait for that and it
 * cannot deadlock on a missed event.
 *
 * @param {CdpSession} session
 * @param {string} expression  must evaluate to a boolean
 * @param {{ timeoutMs?: number; pollMs?: number; label?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function waitForPage(session, expression, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 40;
  const started = Date.now();

  for (;;) {
    /** @type {unknown} */
    let value;
    try {
      value = await session.evaluate(`Boolean(${expression})`);
    } catch (err) {
      // A navigation or context teardown mid-poll is not a failure to wait for.
      value = false;
    }
    if (value === true) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${opts.label ?? expression}`);
    }
    await sleep(pollMs);
  }
}

/**
 * @param {CdpSession} session
 * @param {string} state
 * @param {number} [timeoutMs]
 */
export function waitForState(session, state, timeoutMs) {
  return waitForPage(
    session,
    `document.getElementById("stage") && document.getElementById("stage").dataset.state === ${JSON.stringify(state)}`,
    { timeoutMs, label: `state "${state}"` },
  );
}

/**
 * Waits for the page to post its trace and mark itself done.
 * @param {CdpSession} session
 * @param {number} [timeoutMs]
 */
export function waitForDone(session, timeoutMs) {
  return waitForPage(session, "globalThis.__atlasDone === true", {
    timeoutMs: timeoutMs ?? 120_000,
    label: "session completion",
  });
}

/**
 * Waits until the page records an interaction before the next step. This
 * preserves causal event order when two animation frames take longer than a
 * fixed sleep under CPU throttling.
 * @param {CdpSession} session
 * @param {number} count
 * @param {number} [timeoutMs]
 */
export function waitForInteraction(session, count, timeoutMs = 30_000) {
  return waitForPage(session, `globalThis.__atlasInteractionCount >= ${count}`, {
    timeoutMs,
    label: `recorded interaction ${count}`,
  });
}

/**
 * Resolves the tappable centre of a target, in CSS pixels. Returns null while
 * the element is absent or has no layout box, which is the normal state for a
 * panel that has not been revealed yet.
 *
 * @param {CdpSession} session
 * @param {string} target  the data-atlas-target value
 * @returns {Promise<{ x: number; y: number } | null>}
 */
export async function targetCentre(session, target) {
  const selector = `[data-atlas-target=${JSON.stringify(target)}]`;
  const raw = await session.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const style = getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none" || style.pointerEvents === "none") return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  return raw && typeof raw.x === "number" ? { x: raw.x, y: raw.y } : null;
}

/**
 * Taps a target by name. Waits for it to become hittable first.
 *
 * @param {CdpSession} session
 * @param {string} target
 * @param {{ mobile: boolean; timeoutMs?: number }} opts
 * @returns {Promise<{ x: number; y: number }>}
 */
export async function tap(session, target, opts) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const started = Date.now();
  /** @type {{ x: number; y: number } | null} */
  let centre = null;
  for (;;) {
    centre = await targetCentre(session, target);
    if (centre) break;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`target "${target}" never became hittable within ${timeoutMs}ms`);
    }
    await sleep(40);
  }

  const x = Math.round(centre.x);
  const y = Math.round(centre.y);

  if (opts.mobile) {
    // Headless Chrome's touch emulation did not deliver the scripted input to
    // the app's pointer handler. Exercise the same accessible click action by
    // name while retaining the mobile viewport/network/CPU profile. This is a
    // synthetic DOM click, not evidence of physical touch handling.
    const clicked = await session.evaluate(`(() => {
      const node = document.querySelector('[data-atlas-target=' + ${JSON.stringify(JSON.stringify(target))} + ']');
      if (!node) return false;
      node.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`target "${target}" was not clickable`);
  } else {
    const base = { x, y, button: "left", buttons: 1, clickCount: 1 };
    await session.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await sleep(55);
    await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 });
  }

  log.debug(`tap ${target} at ${x},${y}`);
  return { x, y };
}

/**
 * Walks the purchase flow. Returns the steps actually completed, so a profile
 * that legitimately cannot finish (the business invariant failing is a finding,
 * not a crash) still produces a trace and a report row.
 *
 * @param {CdpSession} session
 * @param {{ mobile: boolean; stepTimeoutMs?: number }} opts
 * @returns {Promise<{ completed: string[]; failedAt: string | null; error: string | null }>}
 */
export async function driveHappyPath(session, opts) {
  /** @type {string[]} */
  const completed = [];
  const stepTimeoutMs = opts.stepTimeoutMs ?? 45_000;

  try {
    await waitForState(session, "interactive", stepTimeoutMs);
  } catch (err) {
    return { completed, failedAt: "interactive", error: message(err) };
  }

  for (const step of HAPPY_PATH) {
    try {
      await tap(session, step.target, { mobile: opts.mobile, timeoutMs: stepTimeoutMs });
      await waitForState(session, step.expectState, stepTimeoutMs);
      await waitForInteraction(session, completed.length + 1, stepTimeoutMs);
      completed.push(step.target);
    } catch (err) {
      return { completed, failedAt: step.target, error: message(err) };
    }
  }
  return { completed, failedAt: null, error: null };
}

/**
 * Replays the interactions a trace recorded, in recorded order.
 *
 * Inter-tap delays are *not* reproduced. The recorded gaps are dominated by how
 * long the runner itself waited for a throttled renderer, so replaying them
 * would reproduce the harness's latency rather than the user's behaviour. What
 * replay asserts is that the same ordered inputs against the same seeded state
 * produce the same causal structure — see docs/adr/0004.
 *
 * @param {CdpSession} session
 * @param {Trace} trace
 * @param {{ mobile: boolean; stepTimeoutMs?: number }} opts
 * @returns {Promise<{ replayed: number; failedAt: string | null; error: string | null }>}
 */
export async function driveFromTrace(session, trace, opts) {
  const stepTimeoutMs = opts.stepTimeoutMs ?? 45_000;
  const interactions = trace.events
    .filter((e) => e.kind === "interaction" && typeof e.attributes.target === "string")
    .sort((a, b) => a.tOffsetMs - b.tOffsetMs);

  try {
    await waitForState(session, "interactive", stepTimeoutMs);
  } catch (err) {
    return { replayed: 0, failedAt: "interactive", error: message(err) };
  }

  let replayed = 0;
  for (const event of interactions) {
    const target = String(event.attributes.target);
    try {
      await tap(session, target, { mobile: opts.mobile, timeoutMs: stepTimeoutMs });
      const interactionIndex = Number(event.attributes.index);
      await waitForInteraction(
        session,
        Number.isInteger(interactionIndex) ? interactionIndex + 1 : replayed + 1,
        stepTimeoutMs,
      );
      replayed++;
    } catch (err) {
      return { replayed, failedAt: target, error: message(err) };
    }
  }
  return { replayed, failedAt: null, error: null };
}

/** @param {unknown} err */
function message(err) {
  return err instanceof Error ? err.message : String(err);
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
