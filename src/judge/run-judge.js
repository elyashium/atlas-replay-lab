/**
 * `atlas judge` — batch trace triage at volume (Stage 4 on-ramp).
 *
 * The trace judge (`DecisionEngine.judgeTrace`) is the integration point that
 * earns its keep over *every* production trace, not a curated sample — the
 * "map-reduce over big data" use case from the Jev brief. Until now it only
 * ran inside `atlas compare` over synthetic scenarios. This module points the
 * same function at real captured traces without changing its shape:
 *
 *  - inputs: any mix of `--trace <file>` and `--dir <dir>`; by default the
 *    matrix output plus live-server captures (`artifacts/matrix`,
 *    `artifacts/live-traces`, `artifacts/replay` when present).
 *  - engine: the rule-based judge always runs; the Jev judge additionally
 *    runs whenever `selectEngine` configures it (live key or
 *    `ATLAS_JEV_FIXTURES=1`), each trace independently so one bad file or one
 *    failed call costs its row, never the report.
 *  - output: `artifacts/judge/judge-report.json` — per-trace verdicts from
 *    each engine, agreement flags, outcome/root-cause tallies, and the Jev
 *    run's own telemetry (calls, latency, input tokens, estimated USD at
 *    $0.042/M input with output free). That telemetry is what makes the
 *    "viable at production volume" claim checkable rather than asserted.
 *
 * Always exits 0: judging observes; `gate` decides. Privacy posture is
 * unchanged — the judge ships `summariseTraceForJev` summaries, never event
 * streams with raw media (there is none to ship by schema), and live egress
 * only happens when a key is deliberately configured (see PRIVACY.md).
 *
 * @typedef {import("../../types/atlas.js").Trace} Trace
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { orbitalManifest } from "../manifest/atlas-orbital.manifest.js";
import { selectEngine } from "../decision/index.js";
import { estimateCostUsd } from "../decision/jev-transport.js";
import { writeJson, fromRoot, readJson } from "../util/fsx.js";
import { logger, banner } from "../util/log.js";

const log = logger("judge");

export const JUDGE_DIR = fromRoot("artifacts", "judge");

const DEFAULT_DIRS = ["artifacts/matrix", "artifacts/live-traces", "artifacts/replay"];

/**
 * @param {{ traceFiles?: string[]; dirs?: string[]; outDir?: string; env?: NodeJS.ProcessEnv; quiet?: boolean }} [opts]
 */
export async function runJudge(opts = {}) {
  const env = opts.env ?? process.env;
  const manifest = orbitalManifest;
  const outDir = opts.outDir ?? JUDGE_DIR;
  const ctx = { manifest, origin: /** @type {const} */ ("judge") };

  const files = await collectTraceFiles(opts.traceFiles ?? [], opts.dirs ?? []);
  if (!files.length) {
    throw new Error(
      "no trace files found. Run `atlas matrix` first, point --dir at a directory of trace JSON, or pass --trace <file>.",
    );
  }

  const selection = await selectEngine({ env, allowFixture: true, quiet: opts.quiet });
  const withJev = selection.jev !== null;
  const rows = [];
  let skipped = 0;

  for (const file of files) {
    const trace = await loadTrace(file);
    if (!trace) {
      skipped++;
      continue;
    }
    const rules = await selection.rules.judgeTrace(trace, ctx);
    const jev = withJev ? await attempt(() => /** @type {any} */ (selection.jev).judgeTrace(trace, ctx)) : null;
    rows.push({
      file: path.relative(process.cwd(), file),
      traceId: trace.traceId,
      profile: trace.resource?.["atlas.profile.id"] ?? null,
      runKind: trace.resource?.["atlas.run.kind"] ?? null,
      servedTier: trace.servedTier,
      rules: verdictSummary(rules),
      jev: jev?.ok ? verdictSummary(jev.value) : null,
      jevError: jev && !jev.ok ? jev.error : null,
      agreement: jev?.ok
        ? {
            outcome: rules.outcome.value === jev.value.outcome.value,
            rootCause: rules.rootCause.value === jev.value.rootCause.value,
            releaseBlocking: Math.abs(rules.releaseBlocking.score - jev.value.releaseBlocking.score) <= 1,
          }
        : null,
    });
  }

  const jevStats = withJev ? { ...selection.jev.stats } : null;
  const report = {
    $note:
      selection.mode === "jev-live"
        ? "Jev verdicts came from a live API over captured traces. Cost/latency below are measured, not estimated from fixtures."
        : selection.mode === "jev-fixture"
          ? "Jev verdicts came from hand-authored ILLUSTRATIVE fixtures — agreement here exercises the code path, not the model."
          : "Rule-based judge only. No external calls were made.",
    generatedAtIso: new Date().toISOString(),
    mode: selection.mode,
    manifest: { id: manifest.id, version: manifest.version, contentHash: manifest.contentHash },
    counts: {
      files: files.length,
      judged: rows.length,
      skipped,
      jevErrors: rows.filter((r) => r.jevError).length,
    },
    tally: {
      rules: tally(rows.map((r) => r.rules)),
      jev: withJev ? tally(rows.filter((r) => r.jev).map((r) => r.jev)) : null,
    },
    agreement: withJev ? agreementRates(rows) : { available: false, reason: "no Jev engine configured" },
    jevRun: jevStats
      ? {
          calls: jevStats.calls,
          totalLatencyMs: Math.round(jevStats.totalLatencyMs * 100) / 100,
          meanLatencyMs: jevStats.calls ? Math.round((jevStats.totalLatencyMs / jevStats.calls) * 100) / 100 : 0,
          inputTokens: jevStats.inputTokens,
          estimatedUsd: estimateCostUsd(jevStats.inputTokens),
          model: jevStats.model,
          perTraceUsd: rows.length ? estimateCostUsd(jevStats.inputTokens / Math.max(1, rows.length)) : 0,
        }
      : null,
    rows,
  };

  const file = path.join(outDir, "judge-report.json");
  await writeJson(file, report);
  if (!opts.quiet) printReport(report, file);
  return { report, file };
}

/**
 * @param {string[]} explicitFiles
 * @param {string[]} explicitDirs
 */
async function collectTraceFiles(explicitFiles, explicitDirs) {
  /** @type {string[]} */
  const files = [...explicitFiles];
  const dirs = explicitDirs.length
    ? explicitDirs
    : DEFAULT_DIRS.map((d) => fromRoot(d)).filter((d) => existsSync(d));
  for (const dir of dirs) {
    for (const f of await listJsonRecursive(dir)) {
      if (/report\.json$/.test(f)) continue; // matrix/gate reports are not traces
      if (/judge-report\.json$/.test(f)) continue;
      if (/engine-comparison\.json$/.test(f)) continue;
      if (/verdict\.json$/.test(f)) continue;
      files.push(f);
    }
  }
  return [...new Set(files)].sort();
}

/**
 * Matrix traces nest at `runs/<runId>/trace.json`; live traces sit flat.
 * Walk recursively so one `--dir` covers both layouts.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listJsonRecursive(dir) {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dir)) return out;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listJsonRecursive(full)));
    else if (e.isFile() && e.name.endsWith(".json")) out.push(full);
  }
  return out.sort();
}

/**
 * @param {string} file
 * @returns {Promise<Trace | null>} null when the file is not a trace
 */
async function loadTrace(file) {
  let parsed;
  try {
    parsed = await readJson(file);
  } catch {
    return null;
  }
  const t = /** @type {any} */ (parsed?.trace ?? parsed);
  if (!t || typeof t.traceId !== "string" || !Array.isArray(t.events)) return null;
  return /** @type {Trace} */ (t);
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ ok: true; value: T } | { ok: false; error: string }>}
 */
async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** @param {any} v */
function verdictSummary(v) {
  return {
    outcome: v.outcome.value,
    rootCause: v.rootCause.value,
    releaseBlocking: Math.round(v.releaseBlocking.score * 1000) / 1000,
    confidence: Math.round(v.confidence * 1000) / 1000,
    engine: v.engine,
  };
}

/** @param {any[]} verdicts */
function tally(verdicts) {
  /** @type {Record<string, number>} */
  const outcome = {};
  /** @type {Record<string, number>} */
  const rootCause = {};
  for (const v of verdicts) {
    outcome[v.outcome] = (outcome[v.outcome] ?? 0) + 1;
    rootCause[v.rootCause] = (rootCause[v.rootCause] ?? 0) + 1;
  }
  return { n: verdicts.length, outcome, rootCause };
}

/** @param {any[]} rows */
function agreementRates(rows) {
  const scored = rows.filter((r) => r.agreement);
  const rate = (/** @type {string} */ key) => {
    if (!scored.length) return { n: 0, agreed: 0, rate: null };
    const agreed = scored.filter((r) => r.agreement[key]).length;
    return { n: scored.length, agreed, rate: Math.round((agreed / scored.length) * 1000) / 1000 };
  };
  return {
    available: true,
    outcome: rate("outcome"),
    rootCause: rate("rootCause"),
    releaseBlocking: rate("releaseBlocking"),
  };
}

/**
 * @param {any} report
 * @param {string} file
 */
function printReport(report, file) {
  banner("JUDGE — batch trace triage");
  log.info(report.$note);
  log.info(`judged ${report.counts.judged}/${report.counts.files} trace(s)${report.counts.skipped ? `, skipped ${report.counts.skipped} non-trace file(s)` : ""}`);
  for (const [engine, t] of Object.entries(report.tally)) {
    if (!t) continue;
    const s = /** @type {any} */ (t);
    log.info(`${engine}: n=${s.n} outcome=${JSON.stringify(s.outcome)} rootCause=${JSON.stringify(s.rootCause)}`);
  }
  if (report.jevRun) {
    const j = report.jevRun;
    log.info(
      `jev run: ${j.calls} call(s), mean ${j.meanLatencyMs}ms, ${j.inputTokens} input tokens, ` +
        `≈$${j.estimatedUsd} total (≈$${j.perTraceUsd}/trace, output free), model ${j.model}`,
    );
  }
  const disagreements = report.rows.filter((/** @type {any} */ r) => r.agreement && !r.agreement.outcome);
  for (const d of disagreements.slice(0, 10)) {
    log.warn(`disagree ${d.traceId}: rules=${d.rules.outcome}/${d.rules.rootCause} jev=${d.jev.outcome}/${d.jev.rootCause}`);
  }
  if (disagreements.length > 10) log.warn(`…and ${disagreements.length - 10} more disagreements (see the JSON).`);
  log.info(`full report → ${path.relative(process.cwd(), file)}`);
}
