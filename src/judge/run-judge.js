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
import { manifestFor } from "../manifest/select.js";
import { selectEngine } from "../decision/index.js";
import { estimateCostUsd } from "../decision/jev-transport.js";
import { loadIncidents, openIncidents, storeRelPath } from "../gate/incidents.js";
import { scoreTrace } from "../gate/atlas-score.js";
import { incidentQuestionKey } from "../decision/questions.js";
import { writeJson, fromRoot, readJson } from "../util/fsx.js";
import { logger, banner } from "../util/log.js";

const log = logger("judge");

export const JUDGE_DIR = fromRoot("artifacts", "judge");

const DEFAULT_DIRS = ["artifacts/matrix", "artifacts/live-traces", "artifacts/replay"];

/**
 * @param {{ traceFiles?: string[]; dirs?: string[]; outDir?: string; incidentStore?: string; env?: NodeJS.ProcessEnv; quiet?: boolean }} [opts]
 */
export async function runJudge(opts = {}) {
  const env = opts.env ?? process.env;
  const manifest = orbitalManifest;
  const outDir = opts.outDir ?? JUDGE_DIR;

  const files = await collectTraceFiles(opts.traceFiles ?? [], opts.dirs ?? []);
  if (!files.length) {
    throw new Error(
      "no trace files found. Run `atlas matrix` first, point --dir at a directory of trace JSON, or pass --trace <file>.",
    );
  }

  // Failure memory, loaded once and held constant for the whole batch. Loading
  // it per trace would let the question set drift mid-run, and two traces judged
  // against different question sets are not comparable — which is the one thing
  // a batch report is for.
  const incidentStore = await loadIncidents(opts.incidentStore);
  const incidents = openIncidents(incidentStore);

  const selection = await selectEngine({ env, allowFixture: true, quiet: opts.quiet });
  const withJev = selection.jev !== null;
  const rows = [];
  let skipped = 0;
  let manifestMismatches = 0;

  for (const file of files) {
    const trace = await loadTrace(file);
    if (!trace) {
      skipped++;
      continue;
    }
    const chosen = manifestFor(trace);
    if (!chosen.hashMatches) manifestMismatches++;
    /** @type {import("../../types/atlas.js").DecisionContext} */
    const ctx = {
      manifest: chosen.manifest,
      origin: /** @type {any} */ ("judge"),
      profileId: trace.resource?.["atlas.profile.id"] ?? undefined,
      incidents,
    };

    const rules = await selection.rules.judgeTrace(trace, ctx);
    const jev = withJev ? await attempt(() => /** @type {any} */ (selection.jev).judgeTrace(trace, ctx)) : null;

    // The Atlas score is computed from the trace and the manifest alone — the
    // verdict only annotates it (`agreement`). Deliberately the deterministic
    // verdict and not Jev's: a score that moved when a model revision shipped
    // would make this quarter's 71 incomparable to last quarter's 78.
    const score = scoreTrace(trace, chosen.manifest, { verdict: rules });

    rows.push({
      file: path.relative(process.cwd(), file),
      traceId: trace.traceId,
      profile: trace.resource?.["atlas.profile.id"] ?? null,
      runKind: trace.resource?.["atlas.run.kind"] ?? null,
      servedTier: trace.servedTier,
      manifest: {
        id: chosen.manifest.id,
        version: chosen.manifest.version,
        contentHash: chosen.manifest.contentHash,
        recognised: chosen.matched,
        hashMatches: chosen.hashMatches,
      },
      atlasScore: {
        score: score.score,
        label: score.label,
        uncapped: score.uncappedScore,
        caps: score.capsApplied.map((c) => c.id),
        excluded: score.excluded,
        agreement: score.agreement,
      },
      comfort: comfortSummary(score.comfort),
      rules: verdictSummary(rules),
      jev: jev?.ok ? verdictSummary(jev.value) : null,
      jevError: jev && !jev.ok ? jev.error : null,
      incidentMatches: resolveIncidentMatches(incidents, rules, jev?.ok ? jev.value : null),
      agreement: jev?.ok
        ? {
            outcome: rules.outcome.value === jev.value.outcome.value,
            rootCause: rules.rootCause.value === jev.value.rootCause.value,
            releaseBlocking: Math.abs(rules.releaseBlocking.score - jev.value.releaseBlocking.score) <= 1,
            comfortRisk:
              rules.comfortRisk && jev.value.comfortRisk
                ? Math.abs(rules.comfortRisk.score - jev.value.comfortRisk.score) <= 1
                : null,
            accessibleFallback:
              rules.accessibleFallback && jev.value.accessibleFallback
                ? (rules.accessibleFallback.pTrue >= 0.5) === (jev.value.accessibleFallback.pTrue >= 0.5)
                : null,
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
    manifestsUsed: [...new Map(rows.map((r) => [r.manifest.id, r.manifest])).values()],
    incidents: {
      store: storeRelPath(opts.incidentStore),
      open: incidents.length,
      askedAbout: incidents.map((i, idx) => ({ key: incidentQuestionKey(idx), id: i.id, title: i.title })),
      $note:
        "Incident recall is a semantic match, not a predicate. The rule-based engine " +
        "answers 0.5 for any incident it has no hand-written matcher for; only a model " +
        "can recognise one it was never coded against.",
    },
    counts: {
      files: files.length,
      judged: rows.length,
      skipped,
      jevErrors: rows.filter((r) => r.jevError).length,
      manifestHashMismatches: manifestMismatches,
    },
    scores: scoreDistribution(rows),
    tally: {
      rules: tally(rows.map((r) => r.rules)),
      jev: withJev ? tally(rows.filter((r) => r.jev).map((r) => r.jev)) : null,
    },
    unexplainedFailures: unexplainedFailures(rows),
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
          questionsPerCall: 8 + incidents.length,
          $note:
            "Questions ride one forward pass, so the fan-out costs input tokens, not " +
            "extra calls. `questionsPerCall` is what those tokens bought.",
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
    comfortRisk: v.comfortRisk ? Math.round(v.comfortRisk.score * 1000) / 1000 : null,
    comfortLabel: v.comfortRisk ? levelAt(v.comfortRisk) : null,
    accessibleFallback: v.accessibleFallback ? v.accessibleFallback.pTrue : null,
    confidence: Math.round(v.confidence * 1000) / 1000,
    engine: v.engine,
    // Present only when the guard kept fan-out answers from an engine other
    // than the one named above. Without this a reader would attribute a model's
    // comfort level to the deterministic engine (see guarded.js).
    fanOutFrom: v.guard?.fanOut?.map((/** @type {any} */ f) => `${f.key}<-${f.from}`) ?? null,
  };
}

/**
 * The nearest named level to a fractional score — the label a human reads.
 * Rounds rather than floors: 3.6 on a five-level scale is much closer to the
 * fourth level than the third, and floor() would report the milder one, which
 * is the direction a comfort report must not round in.
 *
 * @param {{ score: number; levels: string[] }} answer
 */
function levelAt(answer) {
  if (!answer.levels?.length) return null;
  const idx = Math.max(0, Math.min(answer.levels.length - 1, Math.round(answer.score)));
  return answer.levels[idx];
}

/** @param {any} comfort a ComfortReport from src/gate/comfort.js */
function comfortSummary(comfort) {
  if (!comfort) return null;
  const d = comfort.dimensions;
  return {
    held: comfort.heldCount,
    applicable: comfort.applicableCount,
    sustainedFps: d.sustainedPacing.measured.worstWindowSustainedFps ?? null,
    fpsFloor: comfort.policy.sustainedFpsFloor,
    inputP95Ms: d.responsiveness.measured.p95InteractionMs ?? null,
    inputBudgetMs: comfort.policy.p95InputToFrameMs,
    xrFallbackHeld: d.xrFallback.held,
    findings: comfort.findings,
  };
}

/**
 * Maps `matchesIncident<i>` answers back onto incident ids.
 *
 * The question keys are positional, which is what makes the fan-out cheap and
 * also what makes it meaningless on its own: `matchesIncident3` means nothing
 * six months from now when the store has reordered. So the mapping is resolved
 * here, at the point the store's order is still known, and the report records
 * ids rather than indices.
 *
 * Both engines' answers are kept side by side rather than merged. That is the
 * interesting comparison: on the five seeded incidents the rule engine has a
 * matcher and the two can be checked against each other; on anything recorded
 * later it answers 0.5 by construction, and the gap is the argument.
 *
 * @param {ReadonlyArray<{ id: string; title: string }>} incidents
 * @param {any} rules
 * @param {any} jev
 */
function resolveIncidentMatches(incidents, rules, jev) {
  const MATCH_THRESHOLD = 0.65;
  return incidents
    .map((inc, idx) => {
      const key = incidentQuestionKey(idx);
      const pRules = rules?.incidentMatches?.[key]?.pTrue ?? null;
      const pJev = jev?.incidentMatches?.[key]?.pTrue ?? null;
      return {
        id: inc.id,
        title: inc.title,
        pRules,
        pJev,
        // "The rule engine has no opinion here" is different from "the rule
        // engine says no", and a report that conflates them overstates what
        // the deterministic path can do.
        rulesBlind: pRules === 0.5,
        matched: Math.max(pRules ?? 0, pJev ?? 0) >= MATCH_THRESHOLD,
      };
    })
    .filter((m) => m.matched || (m.pJev !== null && m.pJev >= 0.4));
}

/**
 * Failures nobody has a name for.
 *
 * A trace that failed and matched no known incident is the most valuable row in
 * the report: it is either a new bug or a gap in the memory, and both are worth
 * a human's attention. This list is deliberately *not* auto-promoted into the
 * incident store — a store that writes its own entries fills with near-duplicate
 * descriptions of the same failure and stops being memory. `atlas incident add`
 * is the deliberate step, and it belongs to a person.
 *
 * @param {any[]} rows
 */
function unexplainedFailures(rows) {
  return rows
    .filter((r) => {
      const failed = r.rules.outcome === "fail" || (r.atlasScore.score !== null && r.atlasScore.score < 50);
      return failed && !r.incidentMatches.some((/** @type {any} */ m) => m.matched);
    })
    .map((r) => ({
      traceId: r.traceId,
      file: r.file,
      profile: r.profile,
      score: r.atlasScore.score,
      outcome: r.rules.outcome,
      rootCause: r.rules.rootCause,
      caps: r.atlasScore.caps,
      comfortFindings: r.comfort?.findings ?? [],
    }));
}

/**
 * Score distribution across the batch — the shape of the run, not its average.
 *
 * No mean is reported. A mean over a matrix that contains one catastrophic
 * profile and eleven healthy ones reads as "mostly fine", which is exactly the
 * reading the whole repo exists to prevent. Worst and the count below 50 are
 * the numbers that change a decision.
 *
 * @param {any[]} rows
 */
function scoreDistribution(rows) {
  const scored = rows.map((r) => r.atlasScore.score).filter((/** @type {any} */ s) => typeof s === "number");
  if (!scored.length) return { n: 0, worst: null, best: null, median: null, below50: 0, capped: 0 };
  const sorted = [...scored].sort((a, b) => a - b);
  return {
    n: sorted.length,
    worst: sorted[0],
    best: sorted[sorted.length - 1],
    median: sorted[Math.floor((sorted.length - 1) / 2)],
    below50: sorted.filter((s) => s < 50).length,
    capped: rows.filter((r) => r.atlasScore.caps.length > 0).length,
    unscored: rows.length - sorted.length,
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
    // Skipping nulls rather than counting them as disagreements: a dimension
    // one engine did not answer is missing evidence, and scoring it as a
    // disagreement would make the fan-out look worse the less it was asked.
    const applicable = scored.filter((r) => r.agreement[key] !== null && r.agreement[key] !== undefined);
    if (!applicable.length) return { n: 0, agreed: 0, rate: null };
    const agreed = applicable.filter((r) => r.agreement[key]).length;
    return { n: applicable.length, agreed, rate: Math.round((agreed / applicable.length) * 1000) / 1000 };
  };
  return {
    available: true,
    outcome: rate("outcome"),
    rootCause: rate("rootCause"),
    releaseBlocking: rate("releaseBlocking"),
    comfortRisk: rate("comfortRisk"),
    accessibleFallback: rate("accessibleFallback"),
    $note:
      "`releaseBlocking` and `comfortRisk` agree when the two engines land within " +
      "one rubric level of each other; `accessibleFallback` agrees when they fall " +
      "on the same side of 0.5. Exact-match on a fractional score would report " +
      "disagreement for a difference no reader would notice.",
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
