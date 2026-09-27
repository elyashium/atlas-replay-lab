import { sleep, waitForPage } from "./drive.js";

/** Run a customer's declared selector journey. Every step result is evidence, not a guessed pass. */
export async function driveTarget(session, contract, { env = process.env, mobile = false } = {}) {
  const steps = [];
  const started = Date.now();
  const deadline = started + contract.budgets.journeyTimeoutMs;
  try {
    await waitForPage(session, 'typeof globalThis.__atlasGeneric === "object"', { timeoutMs: 15_000, label: "target recorder" });
    await session.evaluate('globalThis.__atlasGeneric.checkpoint("cp-first-frame", "first-frame")', { awaitPromise: true, timeoutMs: 20_000 }).catch(() => {});
    await session.evaluate('globalThis.__atlasGeneric.mark("interactive"); globalThis.__atlasGeneric.checkpoint("cp-interactive", "interactive")', { awaitPromise: true, timeoutMs: 20_000 }).catch(() => {});
    for (let i = 0; i < contract.journey.steps.length; i++) {
      const step = contract.journey.steps[i];
      const timeoutMs = Math.min(step.timeoutMs ?? contract.budgets.stepTimeoutMs, remaining(deadline));
      if (timeoutMs <= 0) throw new Error("target journey exceeded its total time budget");
      await assertAllowedOrigin(session, contract);
      if (step.type === "waitForVisible" || step.type === "waitForHidden") {
        const visible = step.type === "waitForVisible";
        const ok = await pollSelector(session, step.selector, visible, timeoutMs);
        steps.push({ index: i, type: step.type, selector: step.selector, outcome: ok ? "pass" : "fail", durationMs: Date.now() - started });
        if (!ok) throw new Error(`${step.type} timed out for selector ${step.selector}`);
      } else if (step.type === "click") {
        const point = await session.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(step.selector)}); if (!e) return null; const r=e.getBoundingClientRect(), s=getComputedStyle(e); if (r.width<=0 || r.height<=0 || s.visibility==='hidden' || s.display==='none') return null; return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
        if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
          steps.push({ index: i, type: step.type, selector: step.selector, outcome: "fail" });
          throw new Error(`click target missing or hidden: ${step.selector}`);
        }
        await session.evaluate('globalThis.__atlasGeneric.expectInput("tap:target")').catch(() => {});
        if (mobile) {
          await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, radiusX: 8, radiusY: 8, force: 1 }] });
          await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } else {
          await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
          await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
        }
        steps.push({ index: i, type: step.type, selector: step.selector, outcome: "pass", inputFidelity: "CDP pointer/touch input in Chromium emulation; physical device input not tested" });
      } else if (step.type === "fill") {
        const value = env[step.valueFromEnv];
        if (typeof value !== "string" || !value) throw new Error(`required credential environment variable ${step.valueFromEnv} is missing`);
        const ok = await session.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(step.selector)}); if (!e || !(e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement)) return false; const setter=Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value')?.set; setter?.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
        steps.push({ index: i, type: step.type, selector: step.selector, outcome: ok ? "pass" : "fail", value: "[redacted]" });
        if (!ok) throw new Error(`fill target missing or is not an input: ${step.selector}`);
      }
      await sleep(150);
      const currentUrl = await session.evaluate("location.href").catch(() => "");
      let origin = "";
      try { origin = new URL(currentUrl).origin; } catch {}
      if (origin && !contract.target.allowedOrigins.includes(origin)) throw new Error(`navigation escaped allowed origins to ${origin}`);
    }
    const success = await pollSelector(session, contract.journey.success.selector, true, remaining(deadline));
    await assertAllowedOrigin(session, contract);
    steps.push({ type: "success", selector: contract.journey.success.selector, outcome: success ? "pass" : "fail" });
    if (!success) throw new Error(`declared success condition is absent: ${contract.journey.success.selector}`);
    for (const profileId of contract.journey.fallback.requiredOn ?? []) {
      if (profileId !== contract.__profileId) continue;
      const fallback = await pollSelector(session, contract.journey.fallback.selector, true, remaining(deadline));
      await assertAllowedOrigin(session, contract);
      steps.push({ type: "fallback", selector: contract.journey.fallback.selector, outcome: fallback ? "pass" : "fail" });
      if (!fallback) throw new Error(`required safe fallback is absent: ${contract.journey.fallback.selector}`);
    }
    await session.evaluate('globalThis.__atlasGeneric.mark("session-complete"); globalThis.__atlasGeneric.checkpoint("cp-final", "session-complete"); globalThis.__atlasGeneric.finish()', { awaitPromise: true, timeoutMs: 20_000 }).catch(() => {});
    const surface = await readSurface(session);
    return { completed: steps.map((s) => s.type ?? s.index), failedAt: null, error: null, steps, journeyOutcome: "pass", replayability: "selector-driven; no captured customer input stream", surface, durationMs: Date.now() - started };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    steps.push({ type: "journey", outcome: "fail", reason: error });
    await session.evaluate('globalThis.__atlasGeneric.mark("session-complete"); globalThis.__atlasGeneric.checkpoint("cp-final", "session-complete"); globalThis.__atlasGeneric.finish()', { awaitPromise: true, timeoutMs: 20_000 }).catch(() => {});
    const surface = await readSurface(session);
    return { completed: steps.filter((s) => s.outcome === "pass").map((s) => s.type ?? s.index), failedAt: "target-journey", error, steps, journeyOutcome: "fail", replayability: "selector-driven; no captured customer input stream", surface, durationMs: Date.now() - started };
  }
}

async function pollSelector(session, selector, expectedVisible, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await session.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if (!e) return false; const r=e.getBoundingClientRect(), s=getComputedStyle(e); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; })()`).catch(() => false);
    if (state === expectedVisible) return true;
    await sleep(100);
  } while (Date.now() < deadline);
  return false;
}

async function assertAllowedOrigin(session, contract) {
  const current = await session.evaluate("location.href").catch(() => "");
  let origin = "";
  try { origin = new URL(current).origin; } catch {}
  if (!origin || !contract.target.allowedOrigins.includes(origin)) throw new Error(`current page origin is outside target.allowedOrigins (${origin || "unavailable"})`);
}

async function readSurface(session) {
  const surface = await session.evaluate("globalThis.__atlasGeneric.surface()").catch(() => null);
  return surface && typeof surface === "object" ? surface : null;
}

function remaining(deadline) { return Math.max(0, deadline - Date.now()); }
