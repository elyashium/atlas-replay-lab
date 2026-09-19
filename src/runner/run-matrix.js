/**
 * The six-profile matrix — the "one command" of §5.4.
 *
 * Runs each profile in its own browser context against a freshly started
 * control-plane server, captures a trace and checkpoint screenshots per run,
 * has the decision engine judge every captured trace, and writes one
 * `report.json` describing the whole matrix.
 *
 * Two things about how this is scheduled are load-bearing:
 *
 *  - Profiles run **sequentially**, never in parallel. `Emulation.setCPUThrottlingRate`
 *    throttles by making the renderer busy-wait; six throttled renderers on one
 *    machine contend for the same cores, and every timing in the report would
 *    then be a measurement of the host's core count rather than of the profile.
 *    The matrix is slow on purpose.
 *  - The baseline run goes first. It is the same profile as the adaptive
 *    low-CPU/3G run with the router bypassed (`forceTier: "high"`), and it is
 *    the "before" half of the failure story. Running it first means the
 *    adaptive run cannot be accused of having benefited from a warm anything —
 *    though the server also sends `Cache-Control: no-store` on every response,
 *    which is the real guarantee.
 *
 * Every number in the resulting report is read from a real captured trace. No
 * metric in this file is written by hand.
 *
 * @typedef {import("../../types/atlas.js").Trace} Trace
 * @typedef {import("../../types/atlas.js").Profile} Profile
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 * @typedef {import("../../types/atlas.js").TraceVerdict} TraceVerdict
 */

import path from "node:path";
import { existsSync } from "node:fs";

import { orbitalManifest } from "../manifest/atlas-orbital.manifest.js";
import { validateManifest } from "../manifest/validate.js";
import { selectEngine } from "../decision/index.js";
import { launchBrowser } from "./cdp.js";
import { startServer } from "./server.js";
import { PROFILES, profileById } from "./profiles.js";
import { runSession } from "./session.js";
import { driveHappyPath } from "./drive.js";
import { causalHash } from "../trace/normalize.js";
import { fromRoot, ensureDir, emptyDir, writeJson } from "../util/fsx.js";
import { logger, banner } from "../util/log.js";

const log = logger("matrix");

/** Fixed unless overridden. Part of the reproducibility contract. */
export const DEFAULT_SEED = 0x0b17a1;

/** The profile the failure story is told on, and the tier the baseline forces. */
export const BASELINE_PROFILE_ID = "low-cpu-3g";
export const BASELINE_FORCED_TIER = "high";

export const MATRIX_DIR = fromRoot("artifacts", "matrix");

/**
 * @typedef {object} MatrixRunRow
 * @property {string} runId
 * @property {string} profileId
 * @property {string} label
 * @property {"baseline" | "adaptive"} runKind
 * @property {string | null} forcedTier
 * @property {string} traceId
 * @property {string | null} tracePath
 * @property {string | null} determinismHash
 * @property {string | null} causalHash
 * @property {string | null} servedTier
 * @property {string | null} servedPath
 * @property {import("../../types/atlas.js").TraceMetrics | null} metrics
 * @property {object | null} decision
 * @property {TraceVerdict | null} verdict
 * @property {{ completed: string[]; failedAt: string | null; error: string | null } | null} drive
 * @property {Record<string, string>} screenshots
 * @property {string[]} pageErrors
 * @property {string | null} error
 * @property {number} wallMs
 */

/**
 * @param {{
 *   profileIds?: string[];
 *   seed?: number;
 *   outDir?: string;
 *   includeBaseline?: boolean;
 *   clean?: boolean;
 *   env?: NodeJS.ProcessEnv;
 * }} [opts]
 */
export async function runMatrix(opts = {}) {
  const startedAtIso = new Date().toISOString();
  const startedAt = process.hrtime.bigint();
  const seed = opts.seed ?? readSeed(opts.env ?? process.env);
  const outDir = opts.outDir ?? MATRIX_DIR;
  const manifest = orbitalManifest;

  banner("Atlas Replay Lab — capability matrix");

  // A manifest that does not validate cannot produce a meaningful matrix, and
  // finding that out six throttled runs later would be a waste of ten minutes.
  const validation = validateManifest(manifest);
  for (const issue of validation.issues.filter((i) => i.severity === "warning")) {
    log.warn(`manifest ${issue.path}: ${issue.message}`);
  }
  if (!validation.ok) {
    const errors = validation.issues
      .filter((i) => i.severity === "error")
      .map((i) => `${i.path}: ${i.message}`);
    throw new Error(`manifest is invalid:\n  ${errors.join("\n  ")}`);
  }

  await ensureAssets();

  const profiles = (opts.profileIds?.length ? opts.profileIds.map(profileById) : PROFILES);

  const selection = await selectEngine({ env: opts.env ?? process.env, allowFixture: true });
  log.info(selection.status);

  if (opts.clean !== false) await emptyDir(outDir);
  await ensureDir(path.join(outDir, "runs"));

  const browser = await launchBrowser();
  const server = await startServer({
    manifest,
    engine: selection.engine,
    emulated: true,
    // Traces are written per-run below, next to their screenshots, so the
    // server's own dump directory would only duplicate them.
    traceDir: null,
  });
  log.info(`control plane on ${server.origin}; chrome at ${browser.executable}`);

  const browserVersion = await browser.connection
    .send("Browser.getVersion")
    .catch(() => /** @type {any} */ ({}));

  /** @type {MatrixRunRow[]} */
  const runs = [];

  try {
    /** @type {Array<{ profile: Profile; runKind: "baseline" | "adaptive"; forcedTier: string | null }>} */
    const plan = [];

    const baselineWanted = opts.includeBaseline !== false;
    const baselineProfile = profiles.find((p) => p.id === BASELINE_PROFILE_ID);
    if (baselineWanted && baselineProfile) {
      plan.push({ profile: baselineProfile, runKind: "baseline", forcedTier: BASELINE_FORCED_TIER });
    }
    for (const profile of profiles) {
      plan.push({ profile, runKind: "adaptive", forcedTier: null });
    }

    let index = 0;
    for (const step of plan) {
      index++;
      const runId = step.runKind === "baseline" ? `${step.profile.id}--baseline` : step.profile.id;
      const runDir = path.join(outDir, "runs", runId);
      const traceId = `${manifest.id}-${runId}-${Date.now().toString(36)}`;

      banner(`[${index}/${plan.length}] ${runId} — ${step.profile.label}`);
      if (step.forcedTier) {
        log.info(`router bypassed: tier forced to "${step.forcedTier}" (baseline half of the failure story)`);
      }

      /** @type {{ completed: string[]; failedAt: string | null; error: string | null } | null} */
      let driveResult = null;

      const result = await runSession({
        connection: browser.connection,
        server,
        manifest,
        profile: step.profile,
        seed,
        traceId,
        runKind: step.runKind,
        forceTier: step.forcedTier,
        screenshotDir: path.join(runDir, "screenshots"),
        drive: async (session) => {
          driveResult = await driveHappyPath(session, { mobile: step.profile.viewport.mobile });
          if (driveResult.error) {
            log.warn(`drive stopped at "${driveResult.failedAt}": ${driveResult.error}`);
          }
          return driveResult;
        },
      });

      /** @type {TraceVerdict | null} */
      let verdict = null;
      /** @type {string | null} */
      let tracePath = null;

      if (result.trace) {
        if (driveResult?.error) {
          result.trace.notes.push(`drive stopped at "${driveResult.failedAt}": ${driveResult.error}`);
        }
        // Integration point 2: the trace judge, on the same call path a
        // production trace stream would use — only `origin` differs.
        verdict = await selection.engine.judgeTrace(result.trace, {
          manifest,
          origin: "ci-matrix",
          profileId: step.profile.id,
        });
        tracePath = path.join(runDir, "trace.json");
        await writeJson(tracePath, result.trace);
        await writeJson(path.join(runDir, "verdict.json"), verdict);
      }

      const row = /** @type {MatrixRunRow} */ ({
        runId,
        profileId: step.profile.id,
        label: step.profile.label,
        runKind: step.runKind,
        forcedTier: step.forcedTier,
        traceId,
        tracePath: tracePath ? rel(tracePath) : null,
        determinismHash: result.trace?.determinismHash ?? null,
        causalHash: result.trace ? causalHash(result.trace) : null,
        servedTier: result.trace?.servedTier ?? null,
        servedPath: result.trace?.servedPath ?? null,
        metrics: result.trace?.metrics ?? null,
        decision: result.trace?.decision ?? null,
        verdict,
        drive: driveResult,
        screenshots: Object.fromEntries(
          Object.entries(result.screenshots).map(([id, file]) => [id, rel(file)]),
        ),
        pageErrors: result.pageErrors,
        error: result.error,
        wallMs: result.wallMs,
      });
      runs.push(row);
      logRow(row);
    }
  } finally {
    await server.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const report = {
    kind: "atlas.matrix-report",
    schemaVersion: 1,
    startedAtIso,
    finishedAtIso: new Date().toISOString(),
    wallMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
    seed,
    reproduce: "node bin/atlas.js matrix",
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      chromeExecutable: browser.executable,
      chromeProduct: browserVersion.product ?? null,
      chromeJsVersion: browserVersion.jsVersion ?? null,
      headless: process.env.ATLAS_HEADFUL === "1" ? false : true,
    },
    emulationDisclaimer:
      "Chromium emulation, not devices. CPU throttling and network shaping are applied by the " +
      "browser and are real; deviceMemory, hardwareConcurrency, navigator.connection and GPU tier " +
      "are injected hints. These results say nothing about thermal behaviour, real GPU drivers or " +
      "actual handset performance — that needs a physical device lab.",
    manifest: {
      id: manifest.id,
      version: manifest.version,
      contentHash: manifest.contentHash,
    },
    engine: {
      mode: selection.mode,
      name: selection.engine.name,
      kind: selection.engine.kind,
      status: selection.status,
    },
    budgets: manifest.budgets,
    runs,
    summary: summarise(runs, manifest),
    serverStats: server.stats,
  };

  const reportPath = path.join(outDir, "report.json");
  await writeJson(reportPath, report);

  banner("matrix complete");
  log.info(`${report.summary.passed}/${report.summary.total} runs passed the engine's judgement`);
  log.info(`report: ${rel(reportPath)}`);

  return { report, reportPath, selection };
}

/* ── summary ─────────────────────────────────────────────────────────── */

/**
 * @param {MatrixRunRow[]} runs
 * @param {ExperienceManifest} manifest
 */
function summarise(runs, manifest) {
  const graded = runs.filter((r) => r.verdict);
  const outcome = /** @param {MatrixRunRow} r */ (r) => r.verdict?.outcome.value ?? "inconclusive";

  /** @type {Record<string, number>} */
  const byOutcome = {};
  /** @type {Record<string, number>} */
  const byRootCause = {};
  for (const r of graded) {
    byOutcome[outcome(r)] = (byOutcome[outcome(r)] ?? 0) + 1;
    const cause = r.verdict?.rootCause.value ?? "unknown";
    if (outcome(r) !== "pass") byRootCause[cause] = (byRootCause[cause] ?? 0) + 1;
  }

  const baseline = runs.find((r) => r.runKind === "baseline");
  const adaptive = runs.find((r) => r.runKind === "adaptive" && r.profileId === BASELINE_PROFILE_ID);

  return {
    total: runs.length,
    completed: runs.filter((r) => !r.error).length,
    passed: graded.filter((r) => outcome(r) === "pass").length,
    degraded: graded.filter((r) => outcome(r) === "degraded-but-acceptable").length,
    failed: graded.filter((r) => outcome(r) === "fail").length,
    inconclusive: graded.filter((r) => outcome(r) === "inconclusive").length,
    byOutcome,
    byRootCause,
    tiersServed: Object.fromEntries(
      runs.map((r) => [r.runId, { tier: r.servedTier, path: r.servedPath }]),
    ),
    reachedEndState: runs.filter((r) => r.metrics?.reachedEndState).length,
    // The failure story, computed rather than narrated. Both halves come from
    // captured traces; if either is missing the field says so instead of
    // inventing a comparison.
    failureStory:
      baseline && adaptive
        ? {
            profileId: BASELINE_PROFILE_ID,
            budgetFirstFrameMs: manifest.budgets.firstFrameMs,
            before: storyHalf(baseline),
            after: storyHalf(adaptive),
            firstFrameDeltaMs: delta(
              baseline.metrics?.firstFrameMs ?? null,
              adaptive.metrics?.firstFrameMs ?? null,
            ),
            transferDeltaBytes: delta(
              baseline.metrics?.transferBytes ?? null,
              adaptive.metrics?.transferBytes ?? null,
            ),
          }
        : { unavailable: "baseline and adaptive runs of the failure profile were not both captured" },
  };
}

/** @param {MatrixRunRow} row */
function storyHalf(row) {
  return {
    runId: row.runId,
    servedTier: row.servedTier,
    servedPath: row.servedPath,
    forcedTier: row.forcedTier,
    firstFrameMs: row.metrics?.firstFrameMs ?? null,
    timeToInteractiveMs: row.metrics?.timeToInteractiveMs ?? null,
    p95InteractionMs: row.metrics?.p95InteractionMs ?? null,
    droppedFrameRatio: row.metrics?.droppedFrameRatio ?? null,
    transferBytes: row.metrics?.transferBytes ?? null,
    firstFrameNonBlank: row.metrics?.firstFrameNonBlank ?? null,
    reachedEndState: row.metrics?.reachedEndState ?? false,
    outcome: row.verdict?.outcome.value ?? null,
    rootCause: row.verdict?.rootCause.value ?? null,
    releaseBlocking: row.verdict?.releaseBlocking.score ?? null,
    tracePath: row.tracePath,
  };
}

/**
 * @param {number | null} before
 * @param {number | null} after
 */
function delta(before, after) {
  if (before === null || after === null) return null;
  return Math.round((before - after) * 100) / 100;
}

/* ── plumbing ────────────────────────────────────────────────────────── */

/**
 * Generates the tier assets if they are not on disk, so the matrix really is
 * one command from a fresh clone. The generator is deterministic, so doing this
 * lazily does not make the run any less reproducible.
 */
async function ensureAssets() {
  const marker = fromRoot("experience", "assets", "generated", "sizes.json");
  if (existsSync(marker)) return;
  log.info("tier assets not found; generating them (deterministic, ~1s)");
  const { generateAssets } = await import("../../scripts/generate-assets.js");
  await generateAssets();
}

/** @param {NodeJS.ProcessEnv} env */
function readSeed(env) {
  const raw = env.ATLAS_SEED;
  if (!raw) return DEFAULT_SEED;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    log.warn(`ignoring non-numeric ATLAS_SEED="${raw}"`);
    return DEFAULT_SEED;
  }
  return parsed >>> 0;
}

/** @param {string} file */
function rel(file) {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

/** @param {MatrixRunRow} row */
function logRow(row) {
  const m = row.metrics;
  const bits = [
    `tier=${row.servedTier ?? "-"}`,
    `path=${row.servedPath ?? "-"}`,
    `firstFrame=${fmtMs(m?.firstFrameMs)}`,
    `tti=${fmtMs(m?.timeToInteractiveMs)}`,
    `p95tap=${fmtMs(m?.p95InteractionMs)}`,
    `dropped=${m?.droppedFrameRatio === null || m?.droppedFrameRatio === undefined ? "-" : `${Math.round(m.droppedFrameRatio * 100)}%`}`,
    `bytes=${m?.transferBytes ?? "-"}`,
    `end=${m?.reachedEndState ? "reached" : "NOT reached"}`,
  ];
  log.info(bits.join("  "));
  if (row.verdict) {
    log.info(
      `verdict=${row.verdict.outcome.value}  cause=${row.verdict.rootCause.value}  ` +
        `blocking=${row.verdict.releaseBlocking.score.toFixed(2)}/4  ` +
        `confidence=${row.verdict.confidence.toFixed(2)}  engine=${row.verdict.engine}`,
    );
  }
  if (row.error) log.warn(`harness: ${row.error}`);
}

/** @param {number | null | undefined} ms */
function fmtMs(ms) {
  return ms === null || ms === undefined ? "-" : `${Math.round(ms)}ms`;
}
