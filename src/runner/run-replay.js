/**
 * Deterministic replay.
 *
 * Takes a captured trace, re-runs the session it describes, and reports three
 * independent comparisons:
 *
 *  1. **Causal** — does the replay produce the same ordered structure?
 *     (`causalHash`, and `firstDivergence` to locate the exact event where two
 *     runs stopped agreeing.)
 *  2. **Timed** — does it also agree on quantised timing? (`determinismHash`.)
 *     Expected to hold on the same profile; expected *not* to hold across
 *     different throttling, which is why it is reported separately rather than
 *     folded into a single pass/fail.
 *  3. **Visual** — do the checkpoint screenshots match, pixel and perceptually?
 *
 * What makes the replay a replay rather than a second scripted run:
 *
 *  - the same seed, read out of the source trace's `atlas.seed`, so the
 *    particle layout and the mock order id are reproduced rather than
 *    re-randomised;
 *  - the same profile, so the capability snapshot the router sees is the same;
 *  - the recorded interaction events, re-issued in recorded order by
 *    `driveFromTrace`, instead of the hard-coded happy path.
 *
 * The router is deliberately **not** pinned on an adaptive replay. The
 * rule-based engine is a pure function of the snapshot, so a correct replay
 * re-derives the same tier on its own — and if it does not, that divergence is
 * the single most interesting thing the report could tell you. Pinning the tier
 * would hide exactly the bug class this lab exists to catch. Baseline traces
 * are the one exception: their router was bypassed at capture time, so replay
 * bypasses it identically.
 *
 * @typedef {import("../../types/atlas.js").Trace} Trace
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { orbitalManifest } from "../manifest/atlas-orbital.manifest.js";
import { selectEngine } from "../decision/index.js";
import { launchBrowser } from "./cdp.js";
import { startServer } from "./server.js";
import { profileById } from "./profiles.js";
import { runSession } from "./session.js";
import { driveFromTrace } from "./drive.js";
import { causalHash, firstDivergence } from "../trace/normalize.js";
import { decodePng, encodePng } from "../image/png.js";
import { diffImages, perceptualScore, edgeEnergy, edgeDrift } from "../image/diff.js";
import { diffOverlay } from "../image/overlay.js";
import { MATRIX_DIR } from "./run-matrix.js";
import { fromRoot, ensureDir, emptyDir, writeJson, readJson, writeFileEnsured } from "../util/fsx.js";
import { logger, banner } from "../util/log.js";

const log = logger("replay");

export const REPLAY_DIR = fromRoot("artifacts", "replay");

/**
 * Visual tolerance for a checkpoint to count as reproduced.
 *
 * Not zero, and the reason matters: these screenshots come from SwiftShader,
 * a software rasteriser that is stable but not bit-exact across processes, and
 * the composited frame includes text rendered by the host's font stack. A
 * zero-tolerance gate would be red on a correct replay, which is worse than no
 * gate. 0.5% of pixels is far below any visible change and far above the noise.
 */
export const MAX_PIXEL_DIFF_RATIO = 0.005;
export const MIN_PERCEPTUAL_SCORE = 0.985;

/**
 * @param {{
 *   tracePath?: string;
 *   profileId?: string;
 *   baseline?: boolean;
 *   outDir?: string;
 *   env?: NodeJS.ProcessEnv;
 *   clean?: boolean;
 * }} [opts]
 */
export async function runReplay(opts = {}) {
  const manifest = orbitalManifest;
  const sourcePath = resolveSourcePath(opts);

  banner("Atlas Replay Lab — deterministic replay");
  log.info(`source trace: ${rel(sourcePath)}`);

  /** @type {Trace} */
  const source = await readJson(sourcePath);
  assertReplayable(source, manifest);

  const profile = profileById(source.resource["atlas.profile.id"]);
  const seed = source.resource["atlas.seed"] >>> 0;
  const wasBaseline = source.resource["atlas.run.kind"] === "baseline";
  const forceTier = wasBaseline ? (source.decision?.tier ?? null) : null;

  const runId = `${profile.id}${wasBaseline ? "--baseline" : ""}`;
  const outDir = path.join(opts.outDir ?? REPLAY_DIR, runId);
  if (opts.clean !== false) await emptyDir(outDir);
  await ensureDir(outDir);

  log.info(
    `profile=${profile.id} seed=0x${seed.toString(16)} runKind=${source.resource["atlas.run.kind"]}` +
      (forceTier ? ` forcedTier=${forceTier} (router bypassed, matching capture)` : " (router live)"),
  );

  const interactionCount = source.events.filter((e) => e.kind === "interaction").length;
  log.info(`${interactionCount} recorded interaction${interactionCount === 1 ? "" : "s"} to re-issue`);

  const selection = await selectEngine({ env: opts.env ?? process.env, allowFixture: true });
  log.info(selection.status);

  const browser = await launchBrowser();
  const server = await startServer({ manifest, engine: selection.engine, emulated: true, traceDir: null });

  /** @type {import("./session.js").SessionResult} */
  let result;
  /** @type {{ replayed: number; failedAt: string | null; error: string | null } | null} */
  let driveResult = null;

  try {
    result = await runSession({
      connection: browser.connection,
      server,
      manifest,
      profile,
      seed,
      traceId: `${manifest.id}-${runId}-replay-${Date.now().toString(36)}`,
      runKind: "replay",
      forceTier,
      screenshotDir: path.join(outDir, "screenshots"),
      drive: async (session) => {
        driveResult = await driveFromTrace(session, source, { mobile: profile.viewport.mobile });
        if (driveResult.error) log.warn(`replay drive stopped at "${driveResult.failedAt}": ${driveResult.error}`);
        return driveResult;
      },
    });
  } finally {
    await server.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const replayTrace = result.trace;
  if (replayTrace) {
    await writeJson(path.join(outDir, "trace.json"), replayTrace);
  }

  const comparison = replayTrace
    ? {
        causalMatch: causalHash(source) === causalHash(replayTrace),
        timedMatch: source.determinismHash === replayTrace.determinismHash,
        sourceCausalHash: causalHash(source),
        replayCausalHash: causalHash(replayTrace),
        sourceDeterminismHash: source.determinismHash,
        replayDeterminismHash: replayTrace.determinismHash,
        firstDivergence: firstDivergence(source, replayTrace),
      }
    : null;

  const visual = replayTrace
    ? await compareCheckpoints(source, replayTrace, path.join(outDir, "diffs"))
    : [];

  /** @type {import("../../types/atlas.js").TraceVerdict | null} */
  const replayVerdict = replayTrace
    ? await selection.engine.judgeTrace(replayTrace, {
        manifest,
        origin: "ci-matrix",
        profileId: profile.id,
      })
    : null;

  const report = {
    kind: "atlas.replay-report",
    schemaVersion: 1,
    generatedAtIso: new Date().toISOString(),
    reproduce: `node bin/atlas.js replay --trace ${rel(sourcePath)}`,
    runId,
    seed,
    profileId: profile.id,
    routerPinned: forceTier !== null,
    forcedTier: forceTier,
    engine: { mode: selection.mode, name: selection.engine.name, status: selection.status },
    source: {
      path: rel(sourcePath),
      traceId: source.traceId,
      runKind: source.resource["atlas.run.kind"],
      servedTier: source.servedTier,
      servedPath: source.servedPath,
      metrics: source.metrics,
    },
    replay: replayTrace
      ? {
          path: rel(path.join(outDir, "trace.json")),
          traceId: replayTrace.traceId,
          servedTier: replayTrace.servedTier,
          servedPath: replayTrace.servedPath,
          metrics: replayTrace.metrics,
          verdict: replayVerdict,
        }
      : null,
    drive: driveResult,
    comparison,
    visual,
    tolerances: {
      maxPixelDiffRatio: MAX_PIXEL_DIFF_RATIO,
      minPerceptualScore: MIN_PERCEPTUAL_SCORE,
      note:
        "Non-zero because SwiftShader and host font rasterisation are stable but not bit-exact " +
        "across processes. See src/runner/run-replay.js for the reasoning.",
    },
    verdict: verdictOf(comparison, visual, result.error),
    harnessError: result.error,
  };

  const reportPath = path.join(outDir, "report.json");
  await writeJson(reportPath, report);

  logReport(report);
  return { report, reportPath };
}

/* ── comparison ──────────────────────────────────────────────────────── */

/**
 * Compares every checkpoint the two traces have in common, writes a diff
 * overlay for each, and reports the edge-energy drift that stands in for alpha
 * stability (see src/image/diff.js on why it is a proxy).
 *
 * @param {Trace} source
 * @param {Trace} replay
 * @param {string} diffDir
 */
async function compareCheckpoints(source, replay, diffDir) {
  /** @type {any[]} */
  const rows = [];
  await ensureDir(diffDir);

  for (const sourceCp of source.checkpoints) {
    const replayCp = replay.checkpoints.find((c) => c.id === sourceCp.id);
    const row = {
      id: sourceCp.id,
      state: sourceCp.state,
      sourceScreenshot: sourceCp.screenshotPath,
      replayScreenshot: replayCp?.screenshotPath ?? null,
      /** @type {any} */
      diff: null,
      edgeEnergySource: /** @type {number | null} */ (null),
      edgeEnergyReplay: /** @type {number | null} */ (null),
      edgeDrift: /** @type {number | null} */ (null),
      overlay: /** @type {string | null} */ (null),
      status: "missing",
      note: /** @type {string | null} */ (null),
    };

    if (!replayCp) {
      row.note = "the replay never reached this checkpoint";
      rows.push(row);
      continue;
    }
    if (!sourceCp.screenshotPath || !replayCp.screenshotPath) {
      row.note = "one side has no screenshot on disk";
      rows.push(row);
      continue;
    }

    const aPath = resolveArtifact(sourceCp.screenshotPath);
    const bPath = resolveArtifact(replayCp.screenshotPath);
    if (!existsSync(aPath) || !existsSync(bPath)) {
      row.note = `screenshot file missing (${!existsSync(aPath) ? rel(aPath) : rel(bPath)})`;
      rows.push(row);
      continue;
    }

    const a = decodePng(await readFile(aPath));
    const b = decodePng(await readFile(bPath));
    const diff = diffImages(a, b);

    row.diff = {
      width: diff.width,
      height: diff.height,
      pixelDiffRatio: diff.pixelDiffRatio,
      perceptualScore: diff.perceptualScore,
      firstDivergenceBox: diff.firstDivergenceBox,
      identical: diff.identical,
    };
    row.edgeEnergySource = edgeEnergy(a);
    row.edgeEnergyReplay = edgeEnergy(b);
    row.edgeDrift = edgeDrift(row.edgeEnergySource, row.edgeEnergyReplay);

    const within =
      diff.pixelDiffRatio <= MAX_PIXEL_DIFF_RATIO && diff.perceptualScore >= MIN_PERCEPTUAL_SCORE;
    row.status = diff.identical ? "identical" : within ? "within-tolerance" : "diverged";

    if (!diff.identical) {
      const overlayPath = path.join(diffDir, `${sourceCp.id}.png`);
      const overlay = diffOverlay(a, b, { box: diff.firstDivergenceBox });
      await writeFileEnsured(overlayPath, encodePng(overlay));
      row.overlay = rel(overlayPath);
    }

    rows.push(row);
  }

  // Checkpoints the replay reached that the source never did are divergences
  // in the other direction, and just as worth reporting.
  for (const replayCp of replay.checkpoints) {
    if (!source.checkpoints.some((c) => c.id === replayCp.id)) {
      rows.push({
        id: replayCp.id,
        state: replayCp.state,
        sourceScreenshot: null,
        replayScreenshot: replayCp.screenshotPath,
        diff: null,
        edgeEnergySource: null,
        edgeEnergyReplay: null,
        edgeDrift: null,
        overlay: null,
        status: "extra",
        note: "the replay reached a checkpoint the source trace never did",
      });
    }
  }

  return rows;
}

/**
 * @param {ReturnType<typeof Object> | null} comparison
 * @param {any[]} visual
 * @param {string | null} harnessError
 */
function verdictOf(comparison, visual, harnessError) {
  if (harnessError) {
    return { reproduced: false, reason: `harness error: ${harnessError}` };
  }
  const c = /** @type {any} */ (comparison);
  if (!c) return { reproduced: false, reason: "the replay produced no trace" };

  const badVisual = visual.filter((v) => v.status === "diverged" || v.status === "missing" || v.status === "extra");
  if (!c.causalMatch) {
    return {
      reproduced: false,
      reason: "causal structure diverged",
      firstDivergence: c.firstDivergence?.message ?? null,
    };
  }
  if (badVisual.length) {
    return {
      reproduced: false,
      reason: `${badVisual.length} checkpoint(s) outside visual tolerance`,
      checkpoints: badVisual.map((v) => `${v.id}:${v.status}`),
    };
  }
  return {
    reproduced: true,
    reason: c.timedMatch
      ? "identical causal structure, identical quantised timing, all checkpoints within visual tolerance"
      : "identical causal structure and all checkpoints within visual tolerance; quantised timing differed (expected — the replay is a separate real run on real clocks)",
    timedMatch: c.timedMatch,
  };
}

/* ── plumbing ────────────────────────────────────────────────────────── */

/**
 * @param {{ tracePath?: string; profileId?: string; baseline?: boolean }} opts
 * @returns {string}
 */
function resolveSourcePath(opts) {
  if (opts.tracePath) {
    const abs = path.resolve(opts.tracePath);
    if (!existsSync(abs)) throw new Error(`trace not found: ${opts.tracePath}`);
    return abs;
  }
  const profileId = opts.profileId ?? "low-cpu-3g";
  const runId = opts.baseline ? `${profileId}--baseline` : profileId;
  const guess = path.join(MATRIX_DIR, "runs", runId, "trace.json");
  if (!existsSync(guess)) {
    throw new Error(
      `no captured trace for "${runId}" at ${rel(guess)}. Run the matrix first:\n  node bin/atlas.js matrix`,
    );
  }
  return guess;
}

/**
 * A trace recorded against a different manifest describes a different
 * experience. Replaying it would compare two unrelated sessions and call the
 * difference a regression.
 *
 * @param {Trace} trace
 * @param {ExperienceManifest} manifest
 */
function assertReplayable(trace, manifest) {
  if (trace.resource["atlas.manifest.hash"] !== manifest.contentHash) {
    throw new Error(
      `trace was recorded against manifest ${trace.resource["atlas.manifest.hash"]} ` +
        `but the working tree has ${manifest.contentHash}. ` +
        `Re-capture with \`node bin/atlas.js matrix\` before replaying.`,
    );
  }
  if (typeof trace.resource["atlas.seed"] !== "number") {
    throw new Error("trace has no atlas.seed; it predates seed recording and cannot be replayed deterministically");
  }
  if (!trace.events.some((e) => e.kind === "interaction")) {
    log.warn("source trace contains no interaction events; the replay will only reproduce load and first frame");
  }
}

/** Screenshot paths in traces are repo-relative. */
function resolveArtifact(/** @type {string} */ p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/** @param {string} file */
function rel(file) {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

/** @param {any} report */
function logReport(report) {
  banner("replay result");
  const c = report.comparison;
  if (c) {
    log.info(`causal structure:  ${c.causalMatch ? "MATCH" : "DIVERGED"}  (${c.replayCausalHash.slice(0, 16)}…)`);
    log.info(`quantised timing:  ${c.timedMatch ? "MATCH" : "differs"}`);
    if (c.firstDivergence) log.warn(`first divergence:  ${c.firstDivergence.message}`);
  }
  for (const v of report.visual) {
    const detail = v.diff
      ? `pixels=${(v.diff.pixelDiffRatio * 100).toFixed(3)}%  perceptual=${v.diff.perceptualScore.toFixed(4)}  edgeDrift=${v.edgeDrift?.toFixed(4)}`
      : (v.note ?? "");
    log.info(`${v.status.padEnd(17)} ${v.id.padEnd(18)} ${detail}`);
    if (v.overlay) log.info(`${"".padEnd(17)} overlay: ${v.overlay}`);
  }
  const verdict = report.verdict;
  (verdict.reproduced ? log.info : log.warn)(
    `reproduced=${verdict.reproduced}: ${verdict.reason}`,
  );
}
