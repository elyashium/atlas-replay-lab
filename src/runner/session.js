/**
 * Runs one session: one page, one profile, one trace.
 *
 * Shared by the matrix and by replay. The only thing that differs between a
 * matrix run and a replay run is the seed (identical), the `runKind` stamp, and
 * which drive function walks the flow — everything about capture, checkpoint
 * screenshots and trace assembly is the same code. That is what makes "the
 * replay produced the same trace" a meaningful claim rather than a comparison
 * between two different pipelines.
 *
 * ## The `--url` additions, and why they are three options rather than a fork
 *
 * A generic run against a stranger's URL needs exactly three things this
 * function did not previously do, and each is an option rather than a second
 * copy of the function for the same reason the matrix and replay share it: the
 * moment there are two capture paths, "the same pipeline produced both traces"
 * stops being true.
 *
 *  - `target` — navigate somewhere other than the bundled experience. It also
 *    re-points the camera-permission grant, which is a per-origin browser
 *    setting: granting `videoCapture` to `http://127.0.0.1:41234` while the
 *    page under test is served from `https://someone.example` grants nothing,
 *    and the `camera-denied` profile would silently stop being a denial.
 *
 *  - `extraScripts` — the XR stub and the generic probe, registered after the
 *    bootstrap in a load-bearing order (see `applyProfile`).
 *
 *  - `harvest` — pull the payload out of the page over CDP instead of waiting
 *    for it to arrive by HTTP. Orbital posts its own trace to the control
 *    plane because Orbital is served by the control plane. A third-party HTTPS
 *    page cannot: `fetch` to `http://127.0.0.1:PORT` is blocked twice over, by
 *    CORS and by mixed content. Reading the payload back through
 *    `Runtime.evaluate` is not a workaround for a security control, it is the
 *    only channel that exists — and it goes through the same `assembleTrace`,
 *    so the coercion, the allow-lists and the bounds all still apply to it.
 *
 * With none of the three supplied this function behaves exactly as it did.
 *
 * @typedef {import("./cdp.js").CdpConnection} CdpConnection
 * @typedef {import("./cdp.js").CdpSession} CdpSession
 * @typedef {import("../../types/atlas.js").Profile} Profile
 * @typedef {import("../../types/atlas.js").Trace} Trace
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import { applyProfile } from "./profiles.js";
import { buildInjectedScript } from "./inject.js";
import { waitForDone, sleep } from "./drive.js";
import { writeFileEnsured, ensureDir } from "../util/fsx.js";
import { decodePng } from "../image/png.js";
import { redactPngRectangles } from "../image/redact.js";
import { nonBlankness, focalCoverage, edgeEnergy, edgeDrift } from "../image/diff.js";
import { assembleTrace, applyFirstFrameVisual, finalizeTrace } from "../trace/assemble.js";
import { logger } from "../util/log.js";

const log = logger("session");

/** The binding the page's recorder writes to. */
const BINDING = "__atlasBinding";

/**
 * @typedef {object} SessionResult
 * @property {Trace | null} trace
 * @property {string} traceId
 * @property {Record<string, string>} screenshots   checkpoint id → absolute path
 * @property {string[]} pageErrors
 * @property {string | null} error                  harness-level failure, if any
 * @property {number} wallMs                        real elapsed time for the run
 */

/**
 * @param {{
 *   connection: CdpConnection;
 *   server: { origin: string; traces: Trace[] };
 *   manifest: ExperienceManifest;
 *   profile: Profile;
 *   seed: number;
 *   traceId: string;
 *   runKind: "baseline" | "adaptive" | "replay" | "production";
 *   forceTier?: string | null;
 *   screenshotDir: string;
 *   drive: (session: CdpSession) => Promise<unknown>;
 *   doneTimeoutMs?: number;
 *   target?: string;
 *   extraScripts?: string[];
 *   harvest?: (session: CdpSession) => Promise<unknown>;
 *   partialHarvest?: (session: CdpSession) => Promise<unknown>;
 *   doneOptional?: boolean;
 *   captureScreenshots?: boolean;
 *   screenshotRedactSelectors?: string[];
 *   redactPageErrorDetails?: boolean;
 * }} opts
 * @returns {Promise<SessionResult>}
 */
export async function runSession(opts) {
  const startedAt = process.hrtime.bigint();
  /** @type {Record<string, string>} */
  const screenshots = {};
  /** @type {{componentId: string; checkpointId: string; reason: string}[]} */
  const componentScreenshotErrors = [];
  /** @type {string[]} */
  const pageErrors = [];
  /** @type {string | null} */
  let harnessError = null;
  /** @type {string[]} */
  const harnessNotes = [];

  const target = opts.target ?? `${opts.server.origin}/index.html`;

  const session = await opts.connection.newPage();
  await ensureDir(opts.screenshotDir);
  /** Raw first-frame bytes stay in memory for deterministic measurement only. */
  let firstFrameScreenshot = null;

  try {
    // The binding must exist before the document's own scripts evaluate, or
    // the recorder captures a null bridge and no checkpoint is ever announced.
    await session.send("Runtime.addBinding", { name: BINDING });

    // Checkpoint captures are serialised through a queue. Two checkpoints can
    // in principle be announced back to back, and overlapping
    // Page.captureScreenshot calls on a throttled renderer is a good way to
    // photograph the wrong frame.
    /** @type {Promise<void>} */
    let captureChain = Promise.resolve();

    session.on("Runtime.bindingCalled", (params) => {
      if (params?.name !== BINDING) return;
      /** @type {any} */
      let msg;
      try {
        msg = JSON.parse(params.payload);
      } catch {
        return;
      }
      if (msg?.type !== "checkpoint" || typeof msg.id !== "string") return;
      captureChain = captureChain.then(() => captureCheckpoint(
        session, msg.id, opts.screenshotDir, screenshots,
        { ...opts, componentScreenshotErrors },
        (id, bytes) => { if (id === "cp-first-frame") firstFrameScreenshot = bytes; },
      ));
    });

    // Page-side errors are collected as evidence, not swallowed. A trace whose
    // root cause was an uncaught exception should say so.
    session.on("Runtime.exceptionThrown", (params) => {
      const d = params?.exceptionDetails;
      const text = d?.exception?.description ?? d?.text ?? "unknown exception";
      pageErrors.push(opts.redactPageErrorDetails ? "target page exception captured; details withheld by target privacy mode" : `exception: ${String(text).split("\n")[0].slice(0, 300)}`);
    });
    session.on("Log.entryAdded", (params) => {
      const entry = params?.entry;
      if (entry?.level === "error") {
        pageErrors.push(opts.redactPageErrorDetails ? "target console error captured; details withheld by target privacy mode" : `log: ${String(entry.text ?? "").slice(0, 300)}`);
      }
    });
    session.on("Network.loadingFailed", (params) => {
      if (params?.errorText) {
        pageErrors.push(opts.redactPageErrorDetails ? "target network error captured; details withheld by target privacy mode" : `network: ${String(params.errorText).slice(0, 120)} (${params.type ?? "?"})`);
      }
    });

    const injectedScript = buildInjectedScript({
      seed: opts.seed,
      traceId: opts.traceId,
      profileId: opts.profile.id,
      runKind: opts.runKind,
      emulated: true,
      probeOverrides: opts.profile.probeOverrides,
      forceTier: opts.forceTier ?? null,
      disableWebgl: opts.profile.disableWebgl,
    });

    // Permissions are granted per *origin*, and the origin that matters is the
    // one the page will be served from — not the control plane's. Derived from
    // the navigation target so the `camera-denied` profile stays a denial on a
    // `--url` run instead of quietly denying an origin nobody visits.
    await applyProfile(session, opts.profile, {
      origin: originOf(target, opts.server.origin),
      injectedScript,
      extraScripts: opts.extraScripts,
    });

    await session.send("Page.navigate", { url: target });

    // Drive first: the page will not reach `checkout-complete` — and therefore
    // will not post its trace — until something taps through the flow.
    const driveResult = await opts.drive(session);
    const driveStopped = Boolean(
      driveResult &&
        typeof driveResult === "object" &&
        typeof driveResult.error === "string" &&
        driveResult.error,
    );

    if (driveStopped && opts.partialHarvest) {
      // On the harvest path a drive that gave up early leaves `__atlasDone`
      // false for the rest of the session. The page exposes a runner-only,
      // schema-shaped snapshot so the failed journey remains inspectable.
      harnessNotes.push(
        "scripted journey stopped before completion; the partial trace records " +
          "what the page observed before the runner stopped waiting",
      );
    } else {
      try {
        await waitForDone(session, opts.doneTimeoutMs ?? 180_000);
      } catch (err) {
        // A generic page cannot be expected to expose an Atlas completion hook.
        // Its recorder snapshot is the evidence even when its journey stops.
        if (!opts.doneOptional) throw err;
        harnessNotes.push(
          `the page never marked itself complete (${message(err)}); ` +
            "the trace below is what the recorder had captured by that point",
        );
        log.warn(`${opts.profile.id}: completion never signalled; harvesting anyway`);
      }
    }

    // Let any in-flight checkpoint capture finish before the target closes.
    await captureChain;

    const heapMB = await readHeapMB(session);

    // Either the page posted it over HTTP (Orbital) or we read it back over CDP
    // (`--url`). Both land in `assembleTrace`.
    const trace = await obtainTrace(
      session,
      {
        ...opts,
        harvest: opts.harvest ?? (driveStopped ? opts.partialHarvest : undefined),
      },
      10_000,
    );
    if (!trace) {
      harnessError = opts.harvest
        ? "the page's recorder produced no payload"
        : "the page reported completion but no trace reached the control plane";
    } else {
      await attachCheckpointMeasurements(trace, screenshots);
      attachHeapSample(trace, heapMB);
      for (const note of harnessNotes) trace.notes.push(note);
      for (const failure of componentScreenshotErrors) trace.notes.push(`component screenshot ${failure.componentId} withheld at ${failure.checkpointId}: ${failure.reason}`);
      for (const err of pageErrors.slice(0, 20)) trace.notes.push(err);

      if (screenshots["cp-first-frame"] && firstFrameScreenshot) {
        await measureFirstFrame(trace, opts.manifest, firstFrameScreenshot);
        firstFrameScreenshot = null;
      } else {
        trace.notes.push("no cp-first-frame screenshot: blank-frame check could not be performed");
        finalizeTrace(trace, opts.manifest);
      }
    }

    return {
      trace,
      traceId: opts.traceId,
      screenshots,
      componentScreenshotErrors,
      pageErrors,
      error: harnessError,
      wallMs: elapsed(startedAt),
    };
  } catch (err) {
    harnessError = err instanceof Error ? err.message : String(err);
    log.warn(`${opts.profile.id}: ${harnessError}`);

    // A harness failure still produces whatever the page managed to record.
    const trace = await obtainTrace(session, opts, 2_000);
    if (trace) {
      await attachCheckpointMeasurements(trace, screenshots);
      attachHeapSample(trace, null);
      trace.notes.push(`harness error: ${harnessError}`);
      for (const note of harnessNotes) trace.notes.push(note);
      for (const failure of componentScreenshotErrors) trace.notes.push(`component screenshot ${failure.componentId} withheld at ${failure.checkpointId}: ${failure.reason}`);
      for (const e of pageErrors.slice(0, 20)) trace.notes.push(e);
      finalizeTrace(trace, opts.manifest);
    }
    return {
      trace,
      traceId: opts.traceId,
      screenshots,
      componentScreenshotErrors,
      pageErrors,
      error: harnessError,
      wallMs: elapsed(startedAt),
    };
  } finally {
    await session.detach().catch(() => {});
  }
}

/* ── checkpoints ──────────────────────────────────────────────────────── */

/**
 * Captures a checkpoint screenshot, then acknowledges it so the page can carry
 * on. The page blocks on the acknowledgement, which is what guarantees the
 * screenshot is of the state being checkpointed rather than of whatever the
 * DOM had already become.
 *
 * @param {CdpSession} session
 * @param {string} id
 * @param {string} dir
 * @param {Record<string, string>} out
 */
async function captureCheckpoint(session, id, dir, out, opts = {}, onRawCapture = () => {}) {
  try {
    if (opts.captureScreenshots === false) return;
    const selectors = opts.screenshotRedactSelectors ?? [];
    const privacyBounds = selectors.length ? await measureRedactionBounds(session, selectors) : null;
    if (selectors.length && !privacyBounds) throw new Error("a screenshot redaction selector is invalid or matched no measurable element; screenshot withheld");
    const captured = await session.screenshot();
    const png = privacyBounds
      ? redactPngRectangles(captured, privacyBounds.rectangles, { cssWidth: privacyBounds.width, cssHeight: privacyBounds.height })
      : captured;
    onRawCapture(id, captured);
    const file = path.join(dir, `${id}.png`);
    await writeFileEnsured(file, png);
    out[id] = file;
    log.debug(`checkpoint ${id} → ${png.length} bytes`);
    if (id === "cp-final") await captureComponentScreenshots(session, dir, out, opts);
  } catch (err) {
    log.warn(`checkpoint ${id} capture failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Acknowledge even on failure. A missing screenshot is a reported gap; a
    // page hung for five seconds waiting on an acknowledgement that will never
    // come would corrupt every timing after it.
    await session
      .evaluate(`globalThis.__atlasCheckpointAck = ${JSON.stringify(id)}; true`)
      .catch(() => {});
  }
}

async function measureRedactionBounds(session, selectors) {
  const measured = await session.evaluate(`(() => {
    const rectangles = [];
    for (const selector of ${JSON.stringify(selectors)}) {
      let nodes;
      try { nodes = [...document.querySelectorAll(selector)]; } catch { return null; }
      if (!nodes.length) return null;
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
        rectangles.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      }
    }
    if (!rectangles.length || innerWidth <= 0 || innerHeight <= 0) return null;
    return { width: innerWidth, height: innerHeight, rectangles };
  })()`);
  return measured && Number.isFinite(measured.width) && Number.isFinite(measured.height) && Array.isArray(measured.rectangles) && measured.rectangles.length
    ? measured
    : null;
}

async function captureComponentScreenshots(session, dir, out, opts) {
  for (const item of opts.targetComponentSelectors ?? []) {
    let reason = "capture-failed";
    try {
      const measured = await session.evaluate(`(() => {
        let matches;
        try { matches = [...document.querySelectorAll(${JSON.stringify(item.selector)})]; }
        catch { return { reason: "selector-invalid" }; }
        if (matches.length === 0) return { reason: "not-found" };
        if (matches.length !== 1) return { reason: "not-unique" };
        const element = matches[0], rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || rect.width <= 0 || rect.height <= 0) return { reason: "not-visible" };
        if (rect.x < 0 || rect.y < 0 || rect.right > innerWidth || rect.bottom > innerHeight) return { reason: "outside-viewport" };
        if (rect.width > 4096 || rect.height > 4096 || rect.width * rect.height > 8000000) return { reason: "over-dimension-limit" };
        const redactionRects = [];
        for (const selector of ${JSON.stringify(opts.screenshotRedactSelectors ?? [])}) {
          let redacted;
          try { redacted = [...document.querySelectorAll(selector)]; } catch { return { reason: "redaction-selector-invalid" }; }
          if (!redacted.length) return { reason: "redaction-selector-missing" };
          for (const node of redacted) {
            const box = node.getBoundingClientRect();
            if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return { reason: "redaction-bounds-invalid" };
            redactionRects.push({ x: box.x, y: box.y, width: box.width, height: box.height });
          }
        }
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, redactionRects };
      })()`);
      if (!measured || measured.reason) { reason = measured?.reason ?? reason; throw new Error("component screenshot unavailable"); }
      const captured = await session.screenshot({ clip: { x: measured.x, y: measured.y, width: measured.width, height: measured.height, scale: 1 } });
      const png = measured.redactionRects.length
        ? redactPngRectangles(captured, measured.redactionRects, {
          cssOriginX: measured.x, cssOriginY: measured.y, cssWidth: measured.width, cssHeight: measured.height,
        })
        : captured;
      if (png.length > 10 * 1024 * 1024) { reason = "over-file-size-limit"; throw new Error("component screenshot too large"); }
      const file = path.join(dir, `component-${item.id}.png`);
      await writeFileEnsured(file, png);
      out[`component-${item.id}`] = file;
      log.debug(`component screenshot ${item.id} → ${png.length} bytes`);
    } catch {
      opts.componentScreenshotErrors?.push({ componentId: item.id, checkpointId: "cp-final", reason });
    }
  }
}

/**
 * Measures the first composited frame and writes the result into the trace.
 *
 * @param {Trace} trace
 * @param {ExperienceManifest} manifest
 * @param {string} screenshotPath
 */
async function measureFirstFrame(trace, manifest, screenshotBytes) {
  try {
    const image = decodePng(screenshotBytes);
    applyFirstFrameVisual(trace, manifest, {
      nonBlankness: nonBlankness(image),
      focalCoverage: focalCoverage(image),
      edgeEnergy: edgeEnergy(image),
    });
  } catch (err) {
    trace.notes.push(`first-frame screenshot could not be decoded: ${err instanceof Error ? err.message : String(err)}`);
    finalizeTrace(trace, manifest);
  }
}

/* ── trace plumbing ──────────────────────────────────────────────────── */

/**
 * Gets this run's trace, by whichever channel the run has.
 *
 * The two channels differ only in transport. `assembleTrace` — the same
 * function the control plane calls on `POST /api/trace` — does the coercion,
 * the allow-listing and the bounding either way, which is what lets a harvested
 * payload from a page nobody wrote for us be compared against an Orbital trace
 * at all. A payload read over CDP is no more trusted than one that arrived over
 * HTTP; both come from a browser, and neither is believed.
 *
 * `profileId` is passed as a *fallback* only. `assembleTrace` prefers the
 * payload's own value, which the bootstrap put there — so a page that somehow
 * reported a different profile than the one we applied produces a visible
 * mismatch rather than being silently relabelled with the right answer.
 *
 * @param {CdpSession} session
 * @param {{
 *   server: { traces: Trace[] };
 *   manifest: ExperienceManifest;
 *   profile: Profile;
 *   traceId: string;
 *   harvest?: (session: CdpSession) => Promise<unknown>;
 * }} opts
 * @param {number} timeoutMs
 * @returns {Promise<Trace | null>}
 */
async function obtainTrace(session, opts, timeoutMs) {
  if (!opts.harvest) {
    // Posted over HTTP, so it may land a beat after __atlasDone.
    return awaitTrace(opts.server.traces, opts.traceId, timeoutMs);
  }
  try {
    const payload = await opts.harvest(session);
    if (!payload || typeof payload !== "object") return null;
    return assembleTrace(payload, {
      manifest: opts.manifest,
      emulated: true,
      profileId: opts.profile.id,
    });
  } catch (err) {
    log.warn(`trace harvest failed: ${message(err)}`);
    return null;
  }
}

/**
 * The origin a permission grant should be scoped to.
 *
 * Falls back to the control plane's own origin when the target is not a URL
 * this can parse — a `Browser.setPermission` against a malformed origin throws,
 * and losing the whole profile because of a typo in a flag would turn a bad
 * argument into a missing result.
 *
 * @param {string} target
 * @param {string} fallback
 */
function originOf(target, fallback) {
  try {
    return new URL(target).origin;
  } catch {
    return fallback;
  }
}

/**
 * @param {Trace[]} traces
 * @param {string} traceId
 * @param {number} timeoutMs
 * @returns {Promise<Trace | null>}
 */
async function awaitTrace(traces, traceId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = traces.find((t) => t.traceId === traceId);
    if (found) return found;
    if (Date.now() > deadline) return null;
    await sleep(60);
  }
}

/**
 * Attaches the captured screenshot path to each checkpoint **and measures it**.
 *
 * The measuring half is not decoration. `RuleBasedDecisionEngine.judgeTrace`
 * evaluates the visual invariant from `checkpoint.focalCoverage` and
 * `checkpoint.alphaEdgeDrift`; if those stay null, two of the manifest's three
 * visual checks silently never fire and the invariant degrades to "was the
 * first frame blank" without anything reporting that it did. Measuring here —
 * on the Node side, from the decoded PNG — is also the only place it *can*
 * happen: the page is deliberately unable to read pixels back out of its own
 * canvas (see PRIVACY.md), and a page-side measurement would in any case miss
 * the composited layers underneath, which is exactly where a missing product
 * layer hides.
 *
 * `alphaEdgeDrift` is measured against the *previous* checkpoint, so it
 * expresses how much the silhouette moved between two states of the flow. The
 * first checkpoint has no predecessor and is therefore null rather than 0 —
 * "not measurable" and "measured, no drift" must not be the same value.
 *
 * @param {Trace} trace
 * @param {Record<string, string>} screenshots   checkpoint id → absolute path
 */
async function attachCheckpointMeasurements(trace, screenshots) {
  /** @type {number | null} */
  let previousEdgeEnergy = null;

  for (const checkpoint of trace.checkpoints) {
    const file = screenshots[checkpoint.id];
    // Relative, so a trace committed to the repo does not carry someone's
    // home directory in it.
    checkpoint.screenshotPath = file ? path.relative(process.cwd(), file).split(path.sep).join("/") : null;
    checkpoint.focalCoverage = null;
    checkpoint.alphaEdgeDrift = null;

    if (!file) {
      previousEdgeEnergy = null;
      continue;
    }

    try {
      const image = decodePng(await readFile(file));
      checkpoint.focalCoverage = round4(focalCoverage(image));
      const energy = edgeEnergy(image);
      if (previousEdgeEnergy !== null) {
        checkpoint.alphaEdgeDrift = round4(edgeDrift(previousEdgeEnergy, energy));
      }
      previousEdgeEnergy = energy;
    } catch (err) {
      trace.notes.push(
        `checkpoint "${checkpoint.id}" screenshot could not be measured: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      previousEdgeEnergy = null;
    }
  }

  // Screenshots captured for checkpoints the trace never declared are a finding
  // for the gate, so record their presence explicitly.
  for (const id of Object.keys(screenshots)) {
    if (id.startsWith("component-")) continue;
    if (!trace.checkpoints.some((c) => c.id === id)) {
      trace.notes.push(`screenshot captured for unknown checkpoint "${id}"`);
    }
  }
}

/** @param {number} n */
function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Reads real heap usage over CDP rather than trusting `performance.memory`,
 * which headless Chromium does not expose without a flag that also coarsens it.
 *
 * @param {CdpSession} session
 * @returns {Promise<number | null>}
 */
async function readHeapMB(session) {
  try {
    const { metrics } = await session.send("Performance.getMetrics");
    const entry = Array.isArray(metrics) ? metrics.find((m) => m.name === "JSHeapUsedSize") : null;
    if (!entry || typeof entry.value !== "number") return null;
    return Math.round((entry.value / 1048576) * 10) / 10;
  } catch {
    return null;
  }
}

/**
 * Appends the runner's own heap measurement as a trace event.
 *
 * Appended unconditionally, even when the reading is unavailable. Presence of
 * an event is causal structure and therefore part of the determinism hash; its
 * `jsHeapUsedMB` value is not in the hash's allow-list. Adding the event only
 * when a number came back would make the hash depend on whether CDP felt like
 * answering, which is precisely the kind of false divergence the normaliser
 * exists to prevent.
 *
 * Its offset is pinned to the `session-end` event rather than to the wall
 * clock, so the append introduces no timing noise either.
 *
 * @param {Trace} trace
 * @param {number | null} heapMB
 */
function attachHeapSample(trace, heapMB) {
  const sessionEnd = trace.events.find((e) => e.name === "session-end");
  trace.events.push({
    tOffsetMs: sessionEnd ? sessionEnd.tOffsetMs : trace.durationMs,
    name: "runner-heap-sample",
    kind: "lifecycle",
    attributes: {
      state: "session-end",
      jsHeapUsedMB: heapMB,
      source: heapMB === null ? "cdp:unavailable" : "cdp:Performance.getMetrics",
    },
  });
}

/** @param {bigint} startedAt */
function elapsed(startedAt) {
  return Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
}

/** @param {unknown} err */
function message(err) {
  return err instanceof Error ? err.message : String(err);
}
