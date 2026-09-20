/**
 * §4.4 — the engine comparison harness.
 *
 * Runs every synthetic capability packet and every synthetic trace through
 * *both* DecisionEngine implementations and reports how often they agree.
 *
 * ## What this measures, and what it does not
 *
 * This harness has three possible modes, and they are not equally meaningful.
 * The report says which one produced it, on every run, at the top:
 *
 *  - **rule-based** (default, no key). There is nothing to compare against. The
 *    report emits "agreement N/A — no live Jev key" and still runs end to end,
 *    printing the rule engine's own answers. This is the mode CI runs in, and
 *    it must never fail for want of a key.
 *  - **jev-fixture** (`ATLAS_JEV_FIXTURES=1`). Exercises the whole Jev code
 *    path against hand-authored answers. The agreement number this produces is
 *    a measurement of `src/decision/fixtures/answers.js` and of nothing else —
 *    I wrote both columns. It is reported because a broken adapter shows up
 *    here, not because the percentage means anything about Jev.
 *  - **jev-live** (`TYPESAFE_API_KEY` set). The only mode where the agreement
 *    rate is a real measurement of a real model. Even then it is 12 packets and
 *    10 traces against one hand-labelled set — a smoke test, not an evaluation.
 *
 * The calibration section is computed only in live mode, because calibrating
 * fixtures I authored against labels I also authored would be theatre. Even in
 * live mode the sample is far too small to support a claim about Jev's
 * calibration, and the section says so rather than leaving the reader to infer
 * it. TypeSafe's own calibration claims are theirs; nothing here audits them.
 *
 * Run it with:
 *
 *     node bin/atlas.js compare
 *
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 * @typedef {import("../../types/atlas.js").DecisionEngine} DecisionEngine
 * @typedef {import("../../types/atlas.js").TierDecision} TierDecision
 * @typedef {import("../../types/atlas.js").TraceVerdict} TraceVerdict
 */

import path from "node:path";
import { orbitalManifest } from "../manifest/atlas-orbital.manifest.js";
import { selectEngine } from "../decision/index.js";
import { SYNTHETIC_STATES } from "../decision/fixtures/states.js";
import { TRACE_SCENARIOS, buildScenarioTrace } from "../decision/fixtures/traces.js";
import { SEVERITY_LEVELS } from "../decision/questions.js";
import { writeJson, fromRoot } from "../util/fsx.js";
import { logger, banner } from "../util/log.js";

const log = logger("compare");

export const COMPARE_DIR = fromRoot("artifacts", "compare");

/** Confidence buckets for the calibration table. */
const CALIBRATION_BUCKETS = [
  [0.0, 0.5],
  [0.5, 0.7],
  [0.7, 0.85],
  [0.85, 0.95],
  [0.95, 1.0001],
];

/**
 * @param {{ env?: NodeJS.ProcessEnv; outDir?: string; quiet?: boolean }} [opts]
 */
export async function runComparison(opts = {}) {
  const env = opts.env ?? process.env;
  const manifest = orbitalManifest;
  const outDir = opts.outDir ?? COMPARE_DIR;

  const selection = await selectEngine({ env, allowFixture: true, quiet: opts.quiet });
  const comparable = selection.jev !== null;

  /** @type {any[]} */
  const tierRows = [];
  /** @type {any[]} */
  const traceRows = [];

  /* ── tier router ──────────────────────────────────────────────────────── */
  // origin "ci-matrix": this is the offline harness, not the live control
  // plane. §4.1 asks for the same code path in both; the label is how the
  // report tells them apart afterwards.
  const ctx = { manifest, origin: /** @type {const} */ ("ci-matrix") };

  for (const synth of SYNTHETIC_STATES) {
    const rules = await selection.rules.routeTier(synth.state, ctx);
    const jev = comparable ? await attempt(() => /** @type {DecisionEngine} */ (selection.jev).routeTier(synth.state, ctx)) : null;

    tierRows.push({
      id: synth.id,
      label: synth.label,
      contested: Boolean(synth.contested),
      groundTruth: synth.groundTruth,
      cameraExpectedSafe: synth.cameraExpectedSafe,
      rules: tierSummary(rules),
      jev: jev?.ok ? tierSummary(jev.value) : null,
      jevError: jev && !jev.ok ? jev.error : null,
      agreement: jev?.ok
        ? {
            tier: rules.tier === jev.value.tier,
            // A noul pair agrees when both land on the same side of 0.5. The
            // raw probabilities will never match; the decision they imply can.
            cameraPathSafe: rules.cameraPathSafe.pTrue >= 0.5 === jev.value.cameraPathSafe.pTrue >= 0.5,
            // Ordinal scores agree within one level. Demanding an exact match
            // on a 5-level scale would report disagreement for "likely" vs
            // "possible", which is not a disagreement anyone would act on.
            firstFrameRisk: Math.abs(rules.firstFrameRisk.score - jev.value.firstFrameRisk.score) <= 1,
          }
        : null,
    });
  }

  /* ── trace judge ──────────────────────────────────────────────────────── */
  for (const scenario of TRACE_SCENARIOS) {
    const trace = buildScenarioTrace(scenario, manifest);
    const rules = await selection.rules.judgeTrace(trace, ctx);
    const jev = comparable ? await attempt(() => /** @type {DecisionEngine} */ (selection.jev).judgeTrace(trace, ctx)) : null;

    traceRows.push({
      id: scenario.id,
      label: scenario.label,
      contested: Boolean(scenario.contested),
      expected: scenario.expected,
      rules: verdictSummary(rules),
      jev: jev?.ok ? verdictSummary(jev.value) : null,
      jevError: jev && !jev.ok ? jev.error : null,
      agreement: jev?.ok
        ? {
            outcome: rules.outcome.value === jev.value.outcome.value,
            rootCause: rules.rootCause.value === jev.value.rootCause.value,
            releaseBlocking: Math.abs(rules.releaseBlocking.score - jev.value.releaseBlocking.score) <= 1,
            visualInvariantHeld: rules.visualInvariantHeld.pTrue >= 0.5 === jev.value.visualInvariantHeld.pTrue >= 0.5,
            interactionInvariantHeld:
              rules.interactionInvariantHeld.pTrue >= 0.5 === jev.value.interactionInvariantHeld.pTrue >= 0.5,
            businessInvariantHeld:
              rules.businessInvariantHeld.pTrue >= 0.5 === jev.value.businessInvariantHeld.pTrue >= 0.5,
          }
        : null,
    });
  }

  /* ── aggregate ────────────────────────────────────────────────────────── */
  const agreement = comparable
    ? {
        available: true,
        tier: rate(tierRows, "tier"),
        cameraPathSafe: rate(tierRows, "cameraPathSafe"),
        firstFrameRisk: rate(tierRows, "firstFrameRisk"),
        outcome: rate(traceRows, "outcome"),
        rootCause: rate(traceRows, "rootCause"),
        releaseBlocking: rate(traceRows, "releaseBlocking"),
        visualInvariantHeld: rate(traceRows, "visualInvariantHeld"),
        interactionInvariantHeld: rate(traceRows, "interactionInvariantHeld"),
        businessInvariantHeld: rate(traceRows, "businessInvariantHeld"),
        overall: rateAll([...tierRows, ...traceRows]),
        errors: [...tierRows, ...traceRows].filter((r) => r.jevError).length,
      }
    : {
        available: false,
        reason: "agreement N/A — no live Jev key",
        detail:
          "TYPESAFE_API_KEY is not set and ATLAS_JEV_FIXTURES is not 1, so only the " +
          "rule-based engine ran. Every answer below is its own. This is the " +
          "default posture and it is not a degraded run.",
      };

  const report = {
    $note:
      selection.mode === "jev-fixture"
        ? "Jev answers came from hand-authored fixtures. The agreement rate below measures " +
          "src/decision/fixtures/answers.js, NOT the behaviour of a live Jev deployment."
        : selection.mode === "jev-live"
          ? "Jev answers came from a live API. Sample size is small (12 packets, 10 traces); " +
            "treat this as a smoke test, not an evaluation. No vendor claim is audited here."
          : "Rule-based engine only. No external calls were made and no key was used.",
    generatedAtIso: new Date().toISOString(),
    mode: selection.mode,
    status: selection.status,
    manifest: { id: manifest.id, version: manifest.version, contentHash: manifest.contentHash },
    counts: { states: tierRows.length, traces: traceRows.length },
    agreement,
    // Ground truth is hand-assigned (see fixtures/states.js). The rule engine
    // scoring well against labels the same person wrote is close to circular,
    // and the caveat travels with the number rather than living in a README.
    groundTruth: {
      caveat:
        "Ground-truth labels are hand-assigned judgements, not measurements. The rule " +
        "engine and these labels were written by the same person, so its accuracy here " +
        "is partly circular. Contested cases are flagged per row.",
      rules: {
        tier: accuracy(tierRows, (r) => r.rules.tier === r.groundTruth),
        cameraPathSafe: accuracy(tierRows, (r) => r.rules.cameraPathSafe >= 0.5 === r.cameraExpectedSafe),
        outcome: accuracy(traceRows, (r) => r.rules.outcome === r.expected.outcome),
        rootCause: accuracy(traceRows, (r) => r.rules.rootCause === r.expected.rootCause),
      },
      jev: comparable
        ? {
            tier: accuracy(tierRows.filter((r) => r.jev), (r) => r.jev.tier === r.groundTruth),
            cameraPathSafe: accuracy(tierRows.filter((r) => r.jev), (r) => r.jev.cameraPathSafe >= 0.5 === r.cameraExpectedSafe),
            outcome: accuracy(traceRows.filter((r) => r.jev), (r) => r.jev.outcome === r.expected.outcome),
            rootCause: accuracy(traceRows.filter((r) => r.jev), (r) => r.jev.rootCause === r.expected.rootCause),
          }
        : null,
    },
    calibration: buildCalibration(selection.mode, tierRows, traceRows),
    tierRows,
    traceRows,
  };

  const file = path.join(outDir, "engine-comparison.json");
  await writeJson(file, report);
  if (!opts.quiet) printReport(report, file);
  return { report, file };
}

/* ── calibration ────────────────────────────────────────────────────────── */

/**
 * Buckets the model's stated confidence against whether it was right.
 *
 * Only computed in live mode. In fixture mode both the confidence and the
 * "correct" label came out of files I wrote, so the curve would describe my
 * own consistency; emitting it would invite exactly the misreading this
 * project is supposed to avoid.
 *
 * @param {string} mode
 * @param {any[]} tierRows
 * @param {any[]} traceRows
 */
function buildCalibration(mode, tierRows, traceRows) {
  if (mode !== "jev-live") {
    return {
      available: false,
      reason:
        mode === "jev-fixture"
          ? "skipped: fixture answers are hand-authored, so a calibration curve over them " +
            "would measure the fixture author, not the model."
          : "skipped: no live Jev key, so there is no model confidence to calibrate.",
    };
  }

  /** @type {Array<{ confidence: number; correct: boolean }>} */
  const samples = [
    ...tierRows.filter((r) => r.jev).map((r) => ({ confidence: r.jev.confidence, correct: r.jev.tier === r.groundTruth })),
    ...traceRows.filter((r) => r.jev).map((r) => ({ confidence: r.jev.confidence, correct: r.jev.outcome === r.expected.outcome })),
  ];

  const buckets = CALIBRATION_BUCKETS.map(([lo, hi]) => {
    const inBucket = samples.filter((s) => s.confidence >= lo && s.confidence < hi);
    const correct = inBucket.filter((s) => s.correct).length;
    return {
      range: `${lo.toFixed(2)}–${Math.min(hi, 1).toFixed(2)}`,
      n: inBucket.length,
      meanConfidence: inBucket.length ? round3(inBucket.reduce((s, x) => s + x.confidence, 0) / inBucket.length) : null,
      observedAccuracy: inBucket.length ? round3(correct / inBucket.length) : null,
      gap:
        inBucket.length
          ? round3(correct / inBucket.length - inBucket.reduce((s, x) => s + x.confidence, 0) / inBucket.length)
          : null,
    };
  });

  return {
    available: true,
    caveat:
      `n=${samples.length} across ${buckets.filter((b) => b.n > 0).length} populated buckets. This is far too ` +
      "small to support any claim about calibration — a single flipped row moves a bucket " +
      "by tens of percent. It is here because §4.4 asks for the check to exist and run, " +
      "not because the numbers are conclusive. TypeSafe's published calibration claims are " +
      "theirs and are not audited by this.",
    buckets,
    samples: samples.length,
  };
}

/* ── helpers ────────────────────────────────────────────────────────────── */

/**
 * Runs an engine call and captures a failure instead of letting it abort the
 * comparison. A fixture miss or a 500 on one packet should cost that row, not
 * the report — and the row records *why* rather than vanishing.
 *
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

/** @param {TierDecision} d */
function tierSummary(d) {
  return {
    tier: d.tier,
    path: d.path,
    confidence: round3(d.confidence),
    cameraPathSafe: round3(d.cameraPathSafe.pTrue),
    firstFrameRisk: round3(d.firstFrameRisk.score),
    riskLevel: d.firstFrameRisk.levels[Math.round(d.firstFrameRisk.score)] ?? null,
    engine: d.engine,
    distribution: d.tierAnswer.distribution,
  };
}

/** @param {TraceVerdict} v */
function verdictSummary(v) {
  return {
    outcome: v.outcome.value,
    rootCause: v.rootCause.value,
    releaseBlocking: round3(v.releaseBlocking.score),
    severity: SEVERITY_LEVELS[Math.round(v.releaseBlocking.score)] ?? null,
    visualInvariantHeld: round3(v.visualInvariantHeld.pTrue),
    interactionInvariantHeld: round3(v.interactionInvariantHeld.pTrue),
    businessInvariantHeld: round3(v.businessInvariantHeld.pTrue),
    confidence: round3(v.confidence),
    engine: v.engine,
  };
}

/**
 * Agreement rate for one question. Rows where the Jev call failed are excluded
 * from both numerator and denominator and counted separately — scoring an
 * error as a disagreement would understate agreement, and scoring it as an
 * agreement would be worse.
 *
 * @param {any[]} rows
 * @param {string} key
 */
function rate(rows, key) {
  const scored = rows.filter((r) => r.agreement);
  if (!scored.length) return { n: 0, agreed: 0, rate: null };
  const agreed = scored.filter((r) => r.agreement[key]).length;
  return { n: scored.length, agreed, rate: round3(agreed / scored.length) };
}

/** @param {any[]} rows */
function rateAll(rows) {
  let total = 0;
  let agreed = 0;
  for (const r of rows) {
    if (!r.agreement) continue;
    for (const v of Object.values(r.agreement)) {
      total++;
      if (v) agreed++;
    }
  }
  return { n: total, agreed, rate: total ? round3(agreed / total) : null };
}

/**
 * @param {any[]} rows
 * @param {(row: any) => boolean} predicate
 */
function accuracy(rows, predicate) {
  if (!rows.length) return { n: 0, correct: 0, rate: null };
  const correct = rows.filter(predicate).length;
  return { n: rows.length, correct, rate: round3(correct / rows.length) };
}

/** @param {number} n */
function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/* ── terminal output ────────────────────────────────────────────────────── */

/**
 * @param {any} report
 * @param {string} file
 */
function printReport(report, file) {
  banner("ENGINE COMPARISON (§4.4)");
  log.info(report.status);
  log.info(report.$note);

  banner("Tier router — capability packets");
  const comparable = report.agreement.available;
  printTable(
    comparable
      ? ["state", "rules", "jev", "agree", "truth"]
      : ["state", "rules", "camera", "risk", "truth"],
    report.tierRows.map((r) => {
      const flag = r.contested ? "*" : " ";
      if (!comparable) {
        return [
          `${flag}${r.id}`,
          `${r.rules.tier} (${r.rules.confidence})`,
          r.rules.cameraPathSafe >= 0.5 ? "safe" : "unsafe",
          r.rules.riskLevel ?? "-",
          r.groundTruth,
        ];
      }
      return [
        `${flag}${r.id}`,
        `${r.rules.tier} (${r.rules.confidence})`,
        r.jev ? `${r.jev.tier} (${r.jev.confidence})` : `ERR: ${short(r.jevError)}`,
        r.agreement ? (r.agreement.tier ? "yes" : "NO") : "-",
        r.groundTruth,
      ];
    }),
  );

  banner("Trace judge — synthetic traces");
  printTable(
    comparable ? ["scenario", "rules", "jev", "agree", "expected"] : ["scenario", "outcome", "root cause", "severity", "expected"],
    report.traceRows.map((r) => {
      const flag = r.contested ? "*" : " ";
      if (!comparable) {
        return [`${flag}${r.id}`, r.rules.outcome, r.rules.rootCause, r.rules.severity ?? "-", r.expected.outcome];
      }
      return [
        `${flag}${r.id}`,
        `${r.rules.outcome}/${r.rules.rootCause}`,
        r.jev ? `${r.jev.outcome}/${r.jev.rootCause}` : `ERR: ${short(r.jevError)}`,
        r.agreement ? (r.agreement.outcome && r.agreement.rootCause ? "yes" : "NO") : "-",
        r.expected.outcome,
      ];
    }),
  );
  log.info("* = contested: a reasonable engineer could assign a different label.");

  banner("Agreement");
  if (!report.agreement.available) {
    log.info(report.agreement.reason);
    log.info(report.agreement.detail);
  } else {
    for (const [key, value] of Object.entries(report.agreement)) {
      if (!value || typeof value !== "object" || !("rate" in value)) continue;
      const v = /** @type {any} */ (value);
      log.info(`${key.padEnd(26)} ${pct(v.rate)}  (${v.agreed}/${v.n})`);
    }
    if (report.agreement.errors) log.warn(`${report.agreement.errors} row(s) had a Jev call failure; excluded from the rates above.`);
  }

  banner("Calibration");
  if (!report.calibration.available) {
    log.info(report.calibration.reason);
  } else {
    log.warn(report.calibration.caveat);
    printTable(
      ["confidence", "n", "mean conf", "observed", "gap"],
      report.calibration.buckets.map((b) => [
        b.range,
        String(b.n),
        b.meanConfidence === null ? "-" : b.meanConfidence.toFixed(3),
        b.observedAccuracy === null ? "-" : b.observedAccuracy.toFixed(3),
        b.gap === null ? "-" : (b.gap >= 0 ? "+" : "") + b.gap.toFixed(3),
      ]),
    );
  }

  banner("Ground truth (hand-assigned — see caveat)");
  log.info(report.groundTruth.caveat);
  for (const [engine, scores] of Object.entries(report.groundTruth)) {
    if (engine === "caveat" || !scores) continue;
    for (const [key, v] of Object.entries(/** @type {any} */ (scores))) {
      const s = /** @type {any} */ (v);
      log.info(`${engine}.${key}`.padEnd(26) + ` ${pct(s.rate)}  (${s.correct}/${s.n})`);
    }
  }

  log.info(`\nfull report → ${path.relative(process.cwd(), file)}`);
}

/** @param {number | null} n */
function pct(n) {
  return n === null ? "  n/a" : `${(n * 100).toFixed(1).padStart(5)}%`;
}

/** @param {string | null} s */
function short(s) {
  return (s ?? "unknown").slice(0, 28);
}

/**
 * @param {string[]} headers
 * @param {string[][]} rows
 */
function printTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cells) => cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ");
  process.stdout.write(`  ${line(headers)}\n`);
  process.stdout.write(`  ${widths.map((w) => "-".repeat(w)).join("  ")}\n`);
  for (const row of rows) process.stdout.write(`  ${line(row)}\n`);
}
