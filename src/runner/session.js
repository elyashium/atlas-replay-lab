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
 * @typedef {import("./cdp.js").CdpConnection} CdpConnection
 * @typedef {import("./cdp.js").CdpSession} CdpSession
 * @typedef {import("../../types/atlas.js").Profile} Profile
 * @typedef {import("../../types/atlas.js").Trace} Trace
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 */

import path from "node:path";
import { applyProfile } from "./profiles.js";
import { buildInjectedScript } from "./inject.js";
import { waitForDone, sleep } from "./drive.js";
import { writeFileEnsured, ensureDir } from "../util/fsx.js";
import { decodePng } from "../image/png.js";
import { nonBlankness, focalCoverage, edgeEnergy } from "../image/diff.js";
import { applyFirstFrameVisual, finalizeTrace } from "../trace/assemble.js";
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
 * }} opts
 * @returns {Promise<SessionResult>}
 */
export async function runSession(opts) {
  const startedAt = process.hrtime.bigint();
  /** @type {Record<string, string>} */
  const screenshots = {};
  /** @type {string[]} */
  const pageErrors = [];
  /** @type {string | null} */
  let harnessError = null;

  const session = await opts.connection.newPage();
  await ensureDir(opts.screenshotDir);

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
      captureChain = captureChain.then(() => captureCheckpoint(session, msg.id, opts.screenshotDir, screenshots));
    });

    // Page-side errors are collected as evidence, not swallowed. A trace whose
    // root cause was an uncaught exception should say so.
    session.on("Runtime.exceptionThrown", (params) => {
      const d = params?.exceptionDetails;
      const text = d?.exception?.description ?? d?.text ?? "unknown exception";
      pageErrors.push(`exception: ${String(text).split("\n")[0].slice(0, 300)}`);
    });
    session.on("Log.entryAdded", (params) => {
      const entry = params?.entry;
      if (entry?.level === "error") {
        pageErrors.push(`log: ${String(entry.text ?? "").slice(0, 300)}`);
      }
    });
    session.on("Network.loadingFailed", (params) => {
      if (params?.errorText) {
        pageErrors.push(`network: ${String(params.errorText).slice(0, 120)} (${params.type ?? "?"})`);
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

    await applyProfile(session, opts.profile, { origin: opts.server.origin, injectedScript });

    await session.send("Page.navigate", { url: `${opts.server.origin}/index.html` });

    // Drive first: the page will not reach `checkout-complete` — and therefore
    // will not post its trace — until something taps through the flow.
    await opts.drive(session);
    await waitForDone(session, opts.doneTimeoutMs ?? 180_000);

    // Let any in-flight checkpoint capture finish before the target closes.
    await captureChain;

    const heapMB = await readHeapMB(session);

    // The trace arrives over HTTP, so it may land a beat after __atlasDone.
    const trace = await awaitTrace(opts.server.traces, opts.traceId, 10_000);
    if (!trace) {
      harnessError = "the page reported completion but no trace reached the control plane";
    } else {
      attachScreenshotPaths(trace, screenshots);
      attachHeapSample(trace, heapMB);
      for (const err of pageErrors.slice(0, 20)) trace.notes.push(err);

      const cpFirstFrame = screenshots["cp-first-frame"];
      if (cpFirstFrame) {
        await measureFirstFrame(trace, opts.manifest, cpFirstFrame);
      } else {
        trace.notes.push("no cp-first-frame screenshot: blank-frame check could not be performed");
        finalizeTrace(trace, opts.manifest);
      }
    }

    return {
      trace,
      traceId: opts.traceId,
      screenshots,
      pageErrors,
      error: harnessError,
      wallMs: elapsed(startedAt),
    };
  } catch (err) {
    harnessError = err instanceof Error ? err.message : String(err);
    log.warn(`${opts.profile.id}: ${harnessError}`);

    // A harness failure still produces whatever the page managed to post.
    const trace = await awaitTrace(opts.server.traces, opts.traceId, 2_000);
    if (trace) {
      attachScreenshotPaths(trace, screenshots);
      attachHeapSample(trace, null);
      trace.notes.push(`harness error: ${harnessError}`);
      for (const e of pageErrors.slice(0, 20)) trace.notes.push(e);
      finalizeTrace(trace, opts.manifest);
    }
    return {
      trace,
      traceId: opts.traceId,
      screenshots,
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
async function captureCheckpoint(session, id, dir, out) {
  try {
    const png = await session.screenshot();
    const file = path.join(dir, `${id}.png`);
    await writeFileEnsured(file, png);
    out[id] = file;
    log.debug(`checkpoint ${id} → ${png.length} bytes`);
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

/**
 * Measures the first composited frame and writes the result into the trace.
 *
 * @param {Trace} trace
 * @param {ExperienceManifest} manifest
 * @param {string} screenshotPath
 */
async function measureFirstFrame(trace, manifest, screenshotPath) {
  const { readFile } = await import("node:fs/promises");
  try {
    const image = decodePng(await readFile(screenshotPath));
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
 * @param {Trace} trace
 * @param {Record<string, string>} screenshots
 */
function attachScreenshotPaths(trace, screenshots) {
  for (const checkpoint of trace.checkpoints) {
    const file = screenshots[checkpoint.id];
    // Relative, so a trace committed to the repo does not carry someone's
    // home directory in it.
    checkpoint.screenshotPath = file ? path.relative(process.cwd(), file).split(path.sep).join("/") : null;
  }
  // Checkpoints the manifest declares but the session never reached are a
  // finding for the gate, so record their absence explicitly.
  const captured = new Set(Object.keys(screenshots));
  for (const id of captured) {
    if (!trace.checkpoints.some((c) => c.id === id)) {
      trace.notes.push(`screenshot captured for unknown checkpoint "${id}"`);
    }
  }
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
