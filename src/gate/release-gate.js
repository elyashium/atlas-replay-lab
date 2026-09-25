/**
 * The release rule.
 *
 * §5.2 item 7 asks for "a release rule". This is it, in one file, stated once
 * and applied mechanically to a captured matrix report. Nothing here re-runs
 * the browser or re-judges a trace — it reads `artifacts/matrix/report.json`
 * and decides ship / don't ship from what was actually captured.
 *
 * ## The rule
 *
 * A build ships when all of the following hold:
 *
 *  1. Every **critical** profile produced a trace. A run the harness lost is
 *     not a pass; it is an absence of evidence.
 *  2. No critical profile's verdict is `fail`.
 *  3. No critical profile's `releaseBlocking` score reaches **major** (index 3
 *     of the 5-level scale).
 *  4. The **business invariant** holds everywhere: every critical profile
 *     reached the manifest's end state (`checkout-complete` on Orbital,
 *     `session-complete` on generic runs). This one is absolute and
 *     tier-independent — degrading the visuals is the entire point of the tier
 *     ladder, so a low tier is never an excuse; losing the end state is a
 *     different kind of failure from looking worse.
 *  5. No critical profile is `inconclusive`. A gate that reads "we don't know"
 *     as "yes" is not a gate. These block, but they block with a distinct
 *     reason code, because the fix is usually to the harness, not the product.
 *  6. Every decision that drove a shipped run was made at or above the
 *     confidence floor, or was taken over by the rule engine. A decision the
 *     engine was unsure about is routed to a human rather than silently shipped.
 *  7. Replayed sessions reproduce (see the replay section below).
 *  8. Every critical profile's **Atlas score** clears the score floor
 *     (`SCORE_FLOOR`, currently 50). The score is deterministic — computed from
 *     the trace and the manifest alone, never from a model — so the bar cannot
 *     move when a model revision ships. Comfort disasters (sustained low fps,
 *     broken XR fallback) already drag the score down through caps; the floor
 *     is what turns that drag into a decision.
 *
 * The score rule reads the trace file behind each run (`scoreTrace` over the
 * manifest the trace was captured against, selected by recorded id). A run
 * whose trace cannot be loaded is skipped by rule 8 without a finding — rule 1
 * already blocks a critical profile with no trace, and scoring a file that is
 * not there would double-count the same absence.
 *
 * Budget breaches are **warnings, not blocks**, with one exception: a breach on
 * a critical profile whose verdict is already worse than `pass` is folded into
 * that verdict rather than double-counted. The reasoning is that the budgets
 * are targets for the *high* tier, and a low-tier device being slower than the
 * high-tier budget is the ladder working correctly. What must not happen is the
 * experience failing outright, and that is what rules 2–4 catch.
 *
 * ## Why the rule lives here and not inside the judge
 *
 * The trace judge answers "what happened in this session". The gate answers
 * "does that clear the bar to ship". Those are different questions with
 * different owners: the first is a property of a run, the second is a policy
 * decision that a team changes over time without touching the judge. Keeping
 * the policy out of the judge also means swapping in `JevDecisionEngine`
 * changes what the verdicts are, never what the bar is — the model never gets
 * to move its own goalposts.
 *
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { orbitalManifest } from "../manifest/atlas-orbital.manifest.js";
import { manifestFor, manifestById } from "../manifest/select.js";
import { scoreTrace } from "./atlas-score.js";
import { PROFILES } from "../runner/profiles.js";
import { SEVERITY_LEVELS } from "../decision/questions.js";
import { MATRIX_DIR } from "../runner/run-matrix.js";
import { REPLAY_DIR } from "../runner/run-replay.js";
import { readJson, writeJson, fromRoot, ROOT } from "../util/fsx.js";
import { logger, banner } from "../util/log.js";

const log = logger("gate");

export const GATE_DIR = fromRoot("artifacts", "gate");

/**
 * `releaseBlocking` index at which a finding blocks. 3 = "major".
 * Named rather than inlined because it is the single number most likely to be
 * argued about, and it should be arguable in one place.
 */
export const BLOCKING_SEVERITY_INDEX = SEVERITY_LEVELS.indexOf("major");

/**
 * Below this, a decision goes to a human instead of shipping. Matches the
 * guard's own floor so the gate and the runtime agree on what "unsure" means.
 */
export const DECISION_CONFIDENCE_FLOOR = 0.55;

/**
 * Below this Atlas score, a run does not ship. Named for the same reason as
 * the severity index above: the floor is the policy, and policy should be
 * arguable in one place. Mirrors the judge's `below50` tally bucket so the
 * two reports count the same thing.
 */
export const SCORE_FLOOR = 50;

/**
 * @typedef {object} Finding
 * @property {"block" | "warn" | "info"} severity
 * @property {string} rule       which numbered rule produced this
 * @property {string} runId
 * @property {string} message
 * @property {unknown} [evidence]
 */

/**
 * @param {{
 *   matrixReportPath?: string;
 *   replayReportPath?: string | null;
 *   outDir?: string;
 *   quiet?: boolean;
 * }} [opts]
 */
export async function runGate(opts = {}) {
  const matrixPath = opts.matrixReportPath ?? path.join(MATRIX_DIR, "report.json");

  if (!existsSync(matrixPath)) {
    throw new Error(
      `no matrix report at ${rel(matrixPath)}. The gate reads captured results; it does not ` +
        `produce them. Run the matrix first:\n  node bin/atlas.js matrix`,
    );
  }

  const matrix = await readJson(matrixPath);
  const replay = await loadReplay(opts.replayReportPath);

  // The bar comes from the manifest the matrix ran against, selected by
  // recorded id — grading a generic run against Orbital's checkout invariant
  // would hold a stranger's app to an end state it never declared. Reports
  // without an id predate selection and grade against Orbital, as before.
  const { manifest, matched: manifestMatched } = manifestById(matrix.manifest?.id);
  if (matrix.manifest?.id && !manifestMatched) {
    log.warn(
      `matrix report names unknown manifest id "${matrix.manifest.id}" — grading ` +
        `against Orbital (${orbitalManifest.id}@${orbitalManifest.version}) instead.`,
    );
  }

  /** @type {Finding[]} */
  const findings = [];
  const criticalIds = new Set(PROFILES.filter((p) => p.critical).map((p) => p.id));

  // Only adaptive runs are graded. The baseline run is *designed* to fail — it
  // is the "before" half of the failure story, captured with the router
  // deliberately bypassed. Gating on it would mean the gate can never pass,
  // which would make it decorative.
  const graded = matrix.runs.filter((r) => r.runKind !== "baseline");
  const baseline = matrix.runs.find((r) => r.runKind === "baseline") ?? null;

  /* ── rule 1: every critical profile produced a trace ───────────────────── */
  for (const id of criticalIds) {
    const run = graded.find((r) => r.profileId === id);
    if (!run) {
      findings.push({
        severity: "block",
        rule: "1-coverage",
        runId: id,
        message: `critical profile "${id}" was not run`,
      });
      continue;
    }
    if (!run.tracePath || !run.metrics) {
      findings.push({
        severity: "block",
        rule: "1-coverage",
        runId: run.runId,
        message: `critical profile "${id}" produced no trace${run.error ? `: ${run.error}` : ""}`,
        evidence: { harnessError: run.error },
      });
    }
  }

  /* ── rules 2, 3, 5: the verdict itself ─────────────────────────────────── */
  for (const run of graded) {
    const critical = criticalIds.has(run.profileId);
    if (!run.verdict) continue;

    const outcome = run.verdict.outcome.value;
    const severityIndex = run.verdict.releaseBlocking.score;

    if (outcome === "fail") {
      findings.push({
        severity: critical ? "block" : "warn",
        rule: "2-no-failures",
        runId: run.runId,
        message: `verdict is "fail" (root cause: ${run.verdict.rootCause.value})`,
        evidence: {
          rootCause: run.verdict.rootCause.value,
          rootCauseConfidence: topProbability(run.verdict.rootCause.distribution),
          servedTier: run.servedTier,
          servedPath: run.servedPath,
        },
      });
    }

    if (severityIndex >= BLOCKING_SEVERITY_INDEX) {
      findings.push({
        severity: critical ? "block" : "warn",
        rule: "3-severity",
        runId: run.runId,
        message:
          `releaseBlocking scored ${severityIndex.toFixed(2)}/4 ` +
          `(≥ ${BLOCKING_SEVERITY_INDEX} = "${SEVERITY_LEVELS[BLOCKING_SEVERITY_INDEX]}")`,
        evidence: { score: severityIndex, distribution: run.verdict.releaseBlocking.distribution },
      });
    }

    if (outcome === "inconclusive") {
      findings.push({
        severity: critical ? "block" : "warn",
        rule: "5-inconclusive",
        runId: run.runId,
        message:
          "verdict is \"inconclusive\" — the run did not produce enough evidence to judge. " +
          "This usually means the harness broke, not the product, but it blocks either way.",
        evidence: { harnessError: run.error, drive: run.drive },
      });
    }

    /* ── rule 4: the business invariant ─────────────────────────────────── */
    if (run.metrics && !run.metrics.reachedEndState) {
      findings.push({
        severity: critical ? "block" : "warn",
        rule: "4-business-invariant",
        runId: run.runId,
        message:
          `never reached "${manifest.invariants.business.endState}". A lower tier is an ` +
          "acceptable degradation; an unreachable end state is not.",
        evidence: {
          endState: manifest.invariants.business.endState,
          statesVisited: run.drive?.completed ?? null,
          failedAt: run.drive?.failedAt ?? null,
          servedTier: run.servedTier,
        },
      });
    } else if (
      run.metrics?.reachedEndState &&
      run.metrics.stepsToEndState !== null &&
      run.metrics.stepsToEndState > manifest.invariants.business.maxStepsToEndState
    ) {
      findings.push({
        severity: "warn",
        rule: "4-business-invariant",
        runId: run.runId,
        message:
          `reached "${manifest.invariants.business.endState}" in ${run.metrics.stepsToEndState} steps, over the declared ` +
          `maximum of ${manifest.invariants.business.maxStepsToEndState}`,
      });
    }

    /* ── rule 6: decisions the engine was unsure about ──────────────────── */
    const decision = run.decision;
    // Two distinct things are worth a finding here, and they are not the same
    // event. (a) The guard overrode: something shipped that the primary engine
    // did not choose. That is the design working, so it is informational — but
    // it must be visible, because a gate that silently accepts overrides gives
    // no signal when the primary engine starts failing constantly.
    // (b) A low-confidence decision shipped *without* an override: nothing
    // caught it, so a human should look.
    //
    // Override state lives on the guard report the guarded engine attaches (see
    // src/decision/guarded.js), not on the decision itself — the decision that
    // gets served after an override is the rule engine's *replacement*, whose
    // confidence is its own and normally well above the floor. Reading
    // `decision.confidence` alone would therefore miss every override.
    if (decision) {
      const guard = decision.guard ?? null;
      const served = typeof decision.confidence === "number" ? decision.confidence : null;

      if (guard?.overridden) {
        findings.push({
          severity: "info",
          rule: "6-decision-confidence",
          runId: run.runId,
          message:
            `${guard.primaryEngine} was overridden by the rule engine — ${guard.reason}. ` +
            `Served tier "${run.servedTier}".`,
          evidence: { guard, servedTier: run.servedTier, servedConfidence: served },
        });
      } else if (served !== null && served < DECISION_CONFIDENCE_FLOOR) {
        findings.push({
          severity: "warn",
          rule: "6-decision-confidence",
          runId: run.runId,
          message:
            `router shipped tier "${run.servedTier}" at confidence ${served.toFixed(2)}, below the ` +
            `${DECISION_CONFIDENCE_FLOOR} floor, and nothing overrode it — worth a human look`,
          evidence: { confidence: served, tier: run.servedTier, engine: decision.engine, guard },
        });
      }
    }

    /* ── budgets: warnings by design, see the header ────────────────────── */
    if (run.metrics) findings.push(...budgetFindings(run, manifest));

    /* ── rule 8: the Atlas score floor ─────────────────────────────────── */
    // Needs the trace file, not just the run row: the score is computed from
    // measurements, and the matrix report carries verdicts, not measurements.
    // Unreadable trace → skip silently (rule 1 already owns that absence).
    if (run.tracePath) {
      const trace = await loadTrace(run.tracePath);
      if (trace) {
        const { manifest: traceManifest } = manifestFor(trace);
        const scored = scoreTrace(trace, traceManifest);
        if (scored.score !== null && scored.score < SCORE_FLOOR) {
          findings.push({
            severity: critical ? "block" : "warn",
            rule: "8-score-floor",
            runId: run.runId,
            message:
              `Atlas score ${scored.score} ("${scored.label}") is under the ${SCORE_FLOOR} floor` +
              (scored.capsApplied.length ? ` — capped by ${scored.capsApplied.map((c) => c.id).join(", ")}` : ""),
            evidence: {
              score: scored.score,
              label: scored.label,
              uncapped: scored.uncappedScore,
              caps: scored.capsApplied.map((c) => c.id),
              dimensions: Object.fromEntries(
                Object.entries(scored.dimensions).map(([k, d]) => [k, { score: d.score, applicable: d.applicable }]),
              ),
              comfort: scored.comfort.findings,
            },
          });
        }
      }
    }

    /* ── page errors are never fatal on their own, always worth surfacing ─ */
    if (run.pageErrors?.length) {
      findings.push({
        severity: "warn",
        rule: "page-errors",
        runId: run.runId,
        message: `${run.pageErrors.length} uncaught page error(s)`,
        evidence: run.pageErrors.slice(0, 5),
      });
    }
  }

  /* ── replay, when one is present ───────────────────────────────────────── */
  if (replay) {
    if (!replay.report.verdict.reproduced) {
      findings.push({
        severity: "block",
        rule: "7-replay",
        runId: replay.report.runId,
        message: `replay did not reproduce the captured session: ${replay.report.verdict.reason}`,
        evidence: replay.report.verdict,
      });
    } else if (!replay.report.comparison?.timedMatch) {
      // Expected and not a defect — logged so the report shows the gate saw it
      // and decided, rather than leaving a reader to wonder.
      findings.push({
        severity: "info",
        rule: "7-replay",
        runId: replay.report.runId,
        message:
          "replay reproduced causal structure and visuals; quantised timing differed, which is " +
          "expected for a separate real run on real clocks (see ADR-0004).",
      });
    }
  }

  /* ── verdict ───────────────────────────────────────────────────────────── */
  const blocks = findings.filter((f) => f.severity === "block");
  const warns = findings.filter((f) => f.severity === "warn");
  const shipped = blocks.length === 0;

  const report = {
    kind: "atlas.release-gate",
    schemaVersion: 1,
    generatedAtIso: new Date().toISOString(),
    reproduce: "node bin/atlas.js gate",
    decision: shipped ? "ship" : "hold",
    shipped,
    rule: {
      summary:
        "Ship when every critical profile ran, none failed, none scored 'major' or worse, all " +
        "reached the manifest end state, none were inconclusive, and every critical profile's Atlas score " +
        `clears ${SCORE_FLOOR}. Budget breaches warn; they do not block.`,
      blockingSeverityIndex: BLOCKING_SEVERITY_INDEX,
      blockingSeverityLevel: SEVERITY_LEVELS[BLOCKING_SEVERITY_INDEX],
      decisionConfidenceFloor: DECISION_CONFIDENCE_FLOOR,
      scoreFloor: SCORE_FLOOR,
      manifest: {
        id: manifest.id,
        version: manifest.version,
        contentHash: manifest.contentHash,
        matched: manifestMatched,
      },
      businessInvariant: manifest.invariants.business,
      criticalProfiles: [...criticalIds],
      baselineExcluded:
        "The baseline run is excluded from grading: it bypasses the router on purpose and is " +
        "expected to fail. It is evidence for the failure story, not a candidate for release.",
    },
    source: {
      matrixReport: rel(matrixPath),
      replayReport: replay ? rel(replay.path) : null,
      matrixStartedAtIso: matrix.startedAtIso ?? null,
      engine: matrix.engine ?? null,
      manifestHash: matrix.manifest?.contentHash ?? null,
    },
    counts: {
      graded: graded.length,
      blocks: blocks.length,
      warnings: warns.length,
      info: findings.length - blocks.length - warns.length,
    },
    findings,
    baseline: baseline
      ? {
          runId: baseline.runId,
          note: "excluded from grading by design",
          outcome: baseline.verdict?.outcome.value ?? null,
          reachedEndState: baseline.metrics?.reachedEndState ?? null,
        }
      : null,
  };

  const outDir = opts.outDir ?? GATE_DIR;
  const reportPath = path.join(outDir, "report.json");
  await writeJson(reportPath, report);

  if (!opts.quiet) printGate(report, reportPath);
  return { report, reportPath, shipped };
}

/* ── budgets ─────────────────────────────────────────────────────────────── */

/**
 * Loads the trace behind a matrix run, or null when there is nothing usable.
 * Null is not an error here: rule 1 already blocks a critical profile whose
 * trace is missing, and rule 8 must not double-count that absence — or fail a
 * suite whose fixture runs never wrote traces at all.
 *
 * @param {unknown} tracePath
 * @returns {Promise<import("../../types/atlas.js").Trace | null>}
 */
async function loadTrace(tracePath) {
  if (typeof tracePath !== "string" || !tracePath) return null;
  const candidates = path.isAbsolute(tracePath)
    ? [tracePath]
    : [path.join(ROOT, tracePath), path.resolve(tracePath)];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const parsed = await readJson(file);
      const trace = /** @type {any} */ (parsed?.trace ?? parsed);
      if (trace && typeof trace.traceId === "string" && Array.isArray(trace.events)) {
        return /** @type {import("../../types/atlas.js").Trace} */ (trace);
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Budget comparisons, emitted as warnings.
 *
 * The budgets in the manifest are the high-tier targets. A low-CPU device on
 * 3G being served the low tier and still missing the high-tier first-frame
 * budget is the ladder doing its job, not a regression — so these inform rather
 * than block. They are still computed on every run because the trend across
 * runs is the thing worth watching.
 *
 * @param {any} run
 * @param {ExperienceManifest} manifest
 * @returns {Finding[]}
 */
function budgetFindings(run, manifest) {
  const b = manifest.budgets;
  const m = run.metrics;
  /** @type {Finding[]} */
  const out = [];

  /** @param {string} name @param {number | null} actual @param {number} budget @param {string} unit */
  const over = (name, actual, budget, unit) => {
    if (actual === null || actual === undefined) return;
    if (actual <= budget) return;
    out.push({
      severity: "warn",
      rule: "budget",
      runId: run.runId,
      message: `${name} ${fmt(actual)}${unit} over the ${fmt(budget)}${unit} budget (tier "${run.servedTier}")`,
      evidence: { metric: name, actual, budget, servedTier: run.servedTier },
    });
  };

  over("firstFrameMs", m.firstFrameMs, b.firstFrameMs, "ms");
  over("timeToInteractiveMs", m.timeToInteractiveMs, b.timeToInteractiveMs, "ms");
  over("p95InteractionMs", m.p95InteractionMs, b.p95InteractionMs, "ms");
  over("transferBytes", m.transferBytes, b.maxTransferBytes, "B");
  over("jsHeapUsedMB", m.jsHeapUsedMB, b.maxJsHeapMB, "MB");
  if (m.droppedFrameRatio !== null && m.droppedFrameRatio > b.maxDroppedFrameRatio) {
    out.push({
      severity: "warn",
      rule: "budget",
      runId: run.runId,
      message:
        `droppedFrameRatio ${(m.droppedFrameRatio * 100).toFixed(1)}% over the ` +
        `${(b.maxDroppedFrameRatio * 100).toFixed(0)}% budget (tier "${run.servedTier}")`,
      evidence: { actual: m.droppedFrameRatio, budget: b.maxDroppedFrameRatio },
    });
  }
  if (m.assetFailures > 0) {
    out.push({
      severity: "warn",
      rule: "budget",
      runId: run.runId,
      message: `${m.assetFailures} asset request(s) failed`,
      evidence: { assetFailures: m.assetFailures },
    });
  }
  // A first frame that rendered but was blank is the failure the naive
  // "firstFrameMs" number hides completely, which is exactly why it is tracked
  // separately rather than folded into the timing.
  if (m.firstFrameNonBlank === false) {
    out.push({
      severity: "warn",
      rule: "budget",
      runId: run.runId,
      message: "first frame rendered blank — the timing number above is technically met and meaningless",
      evidence: { firstFrameMs: m.firstFrameMs, firstFrameNonBlank: false },
    });
  }
  return out;
}

/* ── plumbing ────────────────────────────────────────────────────────────── */

/**
 * The replay report is optional: `gate` is useful straight after `matrix`, and
 * requiring a replay first would make the common path two commands. When one is
 * present it is folded in; when it is not, the gate says so rather than
 * silently grading on less evidence.
 *
 * @param {string | null | undefined} explicit
 */
async function loadReplay(explicit) {
  if (explicit === null) return null;
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [
        path.join(REPLAY_DIR, "low-cpu-3g", "report.json"),
        path.join(REPLAY_DIR, "low-cpu-3g--baseline", "report.json"),
      ];
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, report: await readJson(p) };
  }
  if (explicit) throw new Error(`replay report not found: ${explicit}`);
  return null;
}

/** @param {Record<string, number> | undefined} dist */
function topProbability(dist) {
  if (!dist) return null;
  const values = Object.values(dist);
  return values.length ? Math.max(...values) : null;
}

/** @param {number} n */
function fmt(n) {
  return n >= 10000 ? n.toLocaleString("en-US") : String(Math.round(n * 100) / 100);
}

/** @param {string} file */
function rel(file) {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

/**
 * @param {any} report
 * @param {string} reportPath
 */
function printGate(report, reportPath) {
  banner("release gate");
  log.info(report.rule.summary);

  const order = { block: 0, warn: 1, info: 2 };
  const sorted = [...report.findings].sort((a, b) => order[a.severity] - order[b.severity]);

  if (!sorted.length) {
    log.info("no findings at all — every check passed clean.");
  }
  for (const f of sorted) {
    const line = `${f.severity.toUpperCase().padEnd(5)} ${f.rule.padEnd(24)} ${f.runId.padEnd(22)} ${f.message}`;
    if (f.severity === "block") log.error(line);
    else if (f.severity === "warn") log.warn(line);
    else log.info(line);
  }

  banner(report.shipped ? "SHIP" : "HOLD");
  log.info(
    `${report.counts.blocks} blocking, ${report.counts.warnings} warning, ${report.counts.info} informational ` +
      `across ${report.counts.graded} graded run(s)`,
  );
  if (!report.source.replayReport) {
    log.info("no replay report was present; the replay check (rule 7) did not run.");
  }
  log.info(`report: ${rel(reportPath)}`);
}
