/**
 * Cross-report diff: what changed between two matrix runs, and whether the
 * comparison is even valid.
 *
 * `docs/handoffs/phase-1.md` lists "automatic cross-report diff" as still
 * absent, and `run-matrix.js` says so in the artifact itself — a contract run
 * writes `failureStory: { unavailable: "…this report does not compare separate
 * target builds automatically." }`. This is that comparison.
 *
 * ## The workflow it serves, and the trap in it
 *
 * Phase 1 acceptance is: capture a genuine failure, the app owner changes their
 * application, rerun with the same contract, show the fix. The obvious
 * implementation subtracts the two scores and reports an improvement. That
 * implementation is wrong, and wrong in the direction that flatters the tool.
 *
 * Between two runs, four things can move: the target app, the target's *build
 * label*, Atlas itself, and the bar Atlas grades against. If more than one moved,
 * the delta is not attributable to any of them. A report that says "score 42 →
 * 78 after your fix" when Atlas also gained a scoring component in between is
 * not a measurement, it is a sales pitch with a number in it.
 *
 * So the first thing this module computes is not the delta. It is
 * `comparability`: the list of things that differ between the two runs which are
 * supposed to be held constant. Only when that list is empty does the diff
 * attribute a change to the application. When it is not empty, the deltas are
 * still reported — they are real numbers and hiding them helps nobody — but
 * every one of them is marked `attribution: "confounded"` and the reason is
 * carried alongside.
 *
 * ## What the hashes tell you that the metrics do not
 *
 * Every run carries two hashes (ADR-0004): `causalHash` over structure alone and
 * `determinismHash` over structure and quantised timing. Comparing them
 * separates two failures that look identical in a score:
 *
 *   - same `causalHash`, different `determinismHash` → the app did the same
 *     things in the same order, and only the timing moved. A performance change.
 *   - different `causalHash` → the app did something different. A behaviour
 *     change, whatever the score says.
 *
 * A "fix" that leaves `causalHash` unchanged while the score improves is a
 * performance win. One that changes `causalHash` changed what the app does, and
 * deserves a closer look than a green number invites.
 *
 * ## Deliberately not here
 *
 * No cause is inferred. This module reports what differs; `src/diagnose/` is
 * where an observation becomes a suggested cause, and the two are kept apart on
 * purpose (Phase 5 item 1). Nothing here re-runs a browser, re-scores a trace,
 * or reads anything but the two reports it was handed.
 */

import path from "node:path";
import { sha256 } from "../util/hash.js";
import { readJson, writeJson, fromRoot } from "../util/fsx.js";
import { logger, banner } from "../util/log.js";

const log = logger("diff");

export const DIFF_DIR = fromRoot("artifacts", "diff");
export const DIFF_SCHEMA_VERSION = 1;

/**
 * Fields that must match for a delta to be attributable to the application.
 *
 * Each entry names where to read it, what it means, and — the part that
 * matters — whether a mismatch is fatal to attribution or merely worth stating.
 * `contract` and `manifest` are fatal because they define what was measured;
 * `chrome` and `node` are fatal because they define what did the measuring.
 * `seed` is fatal for timing but not for structure, so it is its own severity.
 *
 * @type {ReadonlyArray<{ key: string; label: string; read: (r: any) => unknown; fatal: boolean; why: string }>}
 */
const COMPARABILITY_FIELDS = Object.freeze([
  {
    key: "manifest",
    label: "experience manifest",
    read: (r) => r?.manifest?.contentHash ?? null,
    fatal: true,
    why: "the manifest declares the budgets and invariants a run is graded against; a different manifest is a different exam",
  },
  {
    key: "contract",
    label: "target contract",
    read: (r) => r?.target?.contractHash ?? null,
    fatal: true,
    why: "the contract declares the journey, profiles and policy; a changed contract changes what passing means",
  },
  {
    key: "atlasEngine",
    label: "Atlas decision engine",
    read: (r) => (r?.engine ? `${r.engine.name}/${r.engine.mode}` : null),
    fatal: true,
    why: "a different engine can reach a different verdict on identical behaviour",
  },
  {
    key: "atlasBuild",
    label: "Atlas runner build",
    read: (r) => r?.runnerBuildId ?? null,
    fatal: true,
    why: "a changed Atlas build can change scoring, tracing or driving independently of the app",
  },
  {
    key: "chrome",
    label: "browser build",
    read: (r) => r?.environment?.chromeProduct ?? null,
    fatal: true,
    why: "browser version affects both what renders and what the trace records",
  },
  {
    key: "node",
    label: "Node version",
    read: (r) => r?.environment?.node ?? null,
    fatal: false,
    why: "affects the harness rather than the page, but is recorded so a surprising result can be traced",
  },
  {
    key: "headless",
    label: "headless mode",
    read: (r) => r?.environment?.headless ?? null,
    fatal: true,
    why: "headful and headless Chrome do not have the same compositor behaviour",
  },
  {
    key: "seed",
    label: "determinism seed",
    read: (r) => r?.seed ?? null,
    fatal: false,
    why: "a different seed changes the scripted interaction timing, so timing deltas are not comparable even though structure is",
  },
]);

/** Metrics compared numerically when both sides have them. Lower is better unless noted. */
const METRIC_FIELDS = Object.freeze([
  { key: "firstFrameMs", label: "first frame", unit: "ms", lowerIsBetter: true },
  { key: "ttiMs", label: "time to interactive", unit: "ms", lowerIsBetter: true },
  { key: "p95InteractionMs", label: "p95 interaction", unit: "ms", lowerIsBetter: true },
  { key: "sustainedFps", label: "sustained fps", unit: "fps", lowerIsBetter: false },
  { key: "medianFps", label: "median fps", unit: "fps", lowerIsBetter: false },
  { key: "droppedFrames", label: "dropped frames", unit: "", lowerIsBetter: true },
  { key: "longTasks", label: "long tasks", unit: "", lowerIsBetter: true },
]);

/**
 * Compare two parsed matrix reports. Pure: no I/O, no clock, no randomness.
 *
 * @param {any} before
 * @param {any} after
 * @param {{ beforeLabel?: string; afterLabel?: string }} [opts]
 */
export function diffReports(before, after, opts = {}) {
  for (const [name, report] of [["before", before], ["after", after]]) {
    if (!report || typeof report !== "object") throw new Error(`${name} report is not an object`);
    if (!Array.isArray(report.runs)) throw new Error(`${name} report has no runs array — is it a matrix report?`);
  }

  const comparability = assessComparability(before, after);
  const profiles = diffProfiles(before, after);
  const counts = tally(profiles);

  // The headline is deliberately not "improved" or "regressed" when the
  // comparison is confounded. An unattributable delta gets its own word.
  const headline = !comparability.comparable
    ? "confounded"
    : counts.regressed > 0
      ? "regressed"
      : counts.fixed > 0
        ? "improved"
        : counts.changed > 0
          ? "changed"
          : "unchanged";

  return {
    kind: "atlas.report-diff",
    schemaVersion: DIFF_SCHEMA_VERSION,
    headline,
    comparability,
    sides: {
      before: sideSummary(before, opts.beforeLabel ?? "before"),
      after: sideSummary(after, opts.afterLabel ?? "after"),
    },
    counts,
    profiles,
    $limitations:
      "Compares two captured reports only. Nothing is re-run, re-scored or re-judged, and no cause " +
      "is inferred — a delta says what differs, not why. When comparability.comparable is false, no " +
      "delta in this document may be attributed to the application under test.",
  };
}

/**
 * Everything that is supposed to be held constant, and whether it was.
 *
 * @param {any} before
 * @param {any} after
 */
export function assessComparability(before, after) {
  const fields = COMPARABILITY_FIELDS.map((field) => {
    const b = field.read(before);
    const a = field.read(after);
    const same = canon(b) === canon(a);
    // A field that is null on both sides is not "the same" in any useful sense:
    // two runs that both failed to record their Atlas build are two runs whose
    // Atlas build is unknown. Unknown is not a match.
    const unknown = b === null && a === null;
    return {
      key: field.key,
      label: field.label,
      before: b,
      after: a,
      same: same && !unknown,
      unknown,
      fatal: field.fatal,
      why: field.why,
    };
  });

  const differing = fields.filter((f) => !f.same && !f.unknown);
  const unknownFields = fields.filter((f) => f.unknown);
  // Unknown fatal identity is disqualifying for the same reason a mismatch is:
  // the acceptance gate asks for "reportable build and engine identities", and
  // a comparison that cannot name what it held constant has not held anything.
  const blocking = [...differing.filter((f) => f.fatal), ...unknownFields.filter((f) => f.fatal)];

  return {
    comparable: blocking.length === 0,
    blocking: blocking.map((f) => ({
      key: f.key,
      label: f.label,
      before: f.before,
      after: f.after,
      reason: f.unknown ? `${f.label} is unrecorded on both runs` : `${f.label} differs`,
      why: f.why,
    })),
    advisory: [...differing, ...unknownFields].filter((f) => !f.fatal).map((f) => ({
      key: f.key,
      label: f.label,
      before: f.before,
      after: f.after,
      why: f.why,
    })),
    fields,
    note: blocking.length
      ? "Something that must be held constant moved between these runs. Deltas below are real numbers " +
        "but are not attributable to a change in the application under test."
      : "Manifest, contract, engine, Atlas build, browser and headless mode all match. Deltas below " +
        "are attributable to the application under test, within the limits of emulation.",
  };
}

/**
 * Per-profile comparison, keyed by `profileId`.
 *
 * @param {any} before
 * @param {any} after
 */
function diffProfiles(before, after) {
  const byId = (/** @type {any} */ report) => {
    /** @type {Map<string, any>} */
    const map = new Map();
    // The baseline run is excluded for the same reason the gate excludes it: it
    // bypasses the router on purpose and is expected to fail, so its delta
    // measures nothing about a fix.
    for (const run of report.runs) {
      if (run.runKind === "baseline") continue;
      if (run.profileId) map.set(run.profileId, run);
    }
    return map;
  };

  const b = byId(before);
  const a = byId(after);
  const ids = [...new Set([...b.keys(), ...a.keys()])].sort();

  return ids.map((id) => {
    const runBefore = b.get(id) ?? null;
    const runAfter = a.get(id) ?? null;

    if (!runBefore) return { profileId: id, status: "added", before: null, after: runSummary(runAfter), metrics: [], hashes: null };
    if (!runAfter) return { profileId: id, status: "removed", before: runSummary(runBefore), after: null, metrics: [], hashes: null };

    const metrics = diffMetrics(runBefore.metrics, runAfter.metrics);
    const hashes = diffHashes(runBefore, runAfter);
    const status = classify(runBefore, runAfter, metrics);

    return {
      profileId: id,
      status,
      before: runSummary(runBefore),
      after: runSummary(runAfter),
      metrics,
      hashes,
      // Stated per profile as well as globally, because a reader skimming one
      // row must not have to remember the header to know whether it means
      // anything.
      behaviourChanged: hashes ? hashes.causalChanged : null,
    };
  });
}

/**
 * Where a run landed, in the four terms that decide a gate.
 * @param {any} run
 */
function runSummary(run) {
  if (!run) return null;
  return {
    runId: run.runId ?? null,
    outcome: run.verdict?.outcome?.value ?? null,
    releaseBlocking: run.verdict?.releaseBlocking?.value ?? null,
    servedTier: run.servedTier ?? null,
    targetScore: typeof run.targetScore === "number" ? run.targetScore : null,
    journeyOutcome: run.drive?.journeyOutcome ?? null,
    reachedEndState: run.metrics?.reachedEndState ?? null,
    pageErrors: Array.isArray(run.pageErrors) ? run.pageErrors.length : null,
    harnessError: run.error ?? null,
  };
}

/**
 * @param {any} beforeMetrics
 * @param {any} afterMetrics
 */
function diffMetrics(beforeMetrics, afterMetrics) {
  if (!beforeMetrics || !afterMetrics) return [];
  /** @type {Array<{ key: string; label: string; unit: string; before: number; after: number; delta: number; pct: number | null; direction: "better" | "worse" | "same" }>} */
  const out = [];
  for (const field of METRIC_FIELDS) {
    const b = beforeMetrics[field.key];
    const a = afterMetrics[field.key];
    // Only compared when both sides actually measured it. A missing metric is
    // absent evidence, never a zero.
    if (typeof b !== "number" || typeof a !== "number") continue;
    const delta = round(a - b);
    const improved = field.lowerIsBetter ? delta < 0 : delta > 0;
    out.push({
      key: field.key,
      label: field.label,
      unit: field.unit,
      before: b,
      after: a,
      delta,
      pct: b === 0 ? null : round((delta / Math.abs(b)) * 100),
      direction: delta === 0 ? "same" : improved ? "better" : "worse",
    });
  }
  return out;
}

/**
 * @param {any} runBefore
 * @param {any} runAfter
 */
function diffHashes(runBefore, runAfter) {
  const cb = runBefore.causalHash ?? null;
  const ca = runAfter.causalHash ?? null;
  const db = runBefore.determinismHash ?? null;
  const da = runAfter.determinismHash ?? null;
  if (!cb && !ca && !db && !da) return null;

  const causalChanged = cb !== null && ca !== null ? cb !== ca : null;
  const determinismChanged = db !== null && da !== null ? db !== da : null;

  return {
    causal: { before: cb, after: ca },
    determinism: { before: db, after: da },
    causalChanged,
    determinismChanged,
    reading:
      causalChanged === null || determinismChanged === null
        ? "one side did not record a hash; no structural reading is available"
        : causalChanged
          ? "the app did something structurally different, not merely faster or slower"
          : determinismChanged
            ? "same structure, different timing — a performance change with no behaviour change"
            : "identical structure and quantised timing",
  };
}

/**
 * Did this profile get better, worse, or merely different?
 *
 * Outcome and journey dominate: a run that started reaching its end state is
 * fixed regardless of what the numbers did, and one that stopped is regressed
 * regardless of how much faster it got there. Metric direction only decides
 * rows where the categorical result held still.
 *
 * @param {any} runBefore
 * @param {any} runAfter
 * @param {ReturnType<typeof diffMetrics>} metrics
 */
function classify(runBefore, runAfter, metrics) {
  const b = runSummary(runBefore);
  const a = runSummary(runAfter);

  // A harness failure on either side means the comparison for this profile has
  // no product content. It is not an improvement and it is not a regression.
  if (b?.harnessError || a?.harnessError) return "inconclusive";
  if (b?.outcome === null || a?.outcome === null) return "inconclusive";

  const rank = { pass: 2, warn: 1, fail: 0, inconclusive: -1 };
  const rb = rank[/** @type {keyof typeof rank} */ (b?.outcome)] ?? -1;
  const ra = rank[/** @type {keyof typeof rank} */ (a?.outcome)] ?? -1;
  if (ra > rb) return "fixed";
  if (ra < rb) return "regressed";

  if (b?.reachedEndState === false && a?.reachedEndState === true) return "fixed";
  if (b?.reachedEndState === true && a?.reachedEndState === false) return "regressed";
  if (b?.journeyOutcome === "fail" && a?.journeyOutcome === "pass") return "fixed";
  if (b?.journeyOutcome === "pass" && a?.journeyOutcome === "fail") return "regressed";

  const worse = metrics.filter((m) => m.direction === "worse");
  const better = metrics.filter((m) => m.direction === "better");
  if (!worse.length && !better.length) return "unchanged";
  return "changed";
}

/** @param {ReturnType<typeof diffProfiles>} profiles */
function tally(profiles) {
  const counts = { total: profiles.length, fixed: 0, regressed: 0, changed: 0, unchanged: 0, inconclusive: 0, added: 0, removed: 0 };
  for (const p of profiles) {
    if (p.status in counts) counts[/** @type {keyof typeof counts} */ (p.status)] += 1;
  }
  return counts;
}

/** @param {any} report @param {string} label */
function sideSummary(report, label) {
  return {
    label,
    startedAtIso: report.startedAtIso ?? null,
    reproduce: report.reproduce ?? null,
    manifest: report.manifest?.contentHash ?? null,
    contract: report.target?.contract?.id ?? null,
    contractHash: report.target?.contractHash ?? null,
    buildId: report.target?.contract?.buildId ?? null,
    atlasBuild: report.runnerBuildId ?? null,
    engine: report.engine ? `${report.engine.name}/${report.engine.mode}` : null,
    chrome: report.environment?.chromeProduct ?? null,
    seed: report.seed ?? null,
    runs: Array.isArray(report.runs) ? report.runs.length : 0,
  };
}

/** @param {unknown} v */
function canon(v) {
  return v === null || v === undefined ? "\u0000null" : typeof v === "object" ? sha256(v, 16) : String(v);
}

/** @param {number} n */
function round(n) {
  return Math.round(n * 100) / 100;
}

/* ── CLI entry ───────────────────────────────────────────────────────────── */

/**
 * Load two reports from disk, diff them, and write the artifact.
 *
 * @param {{ before: string; after: string; outDir?: string; quiet?: boolean }} opts
 */
export async function runDiff(opts) {
  if (!opts?.before || !opts?.after) {
    throw new Error("runDiff requires --before and --after paths to two matrix report.json files");
  }
  const before = await readJson(opts.before);
  const after = await readJson(opts.after);
  const diff = diffReports(before, after, { beforeLabel: opts.before, afterLabel: opts.after });

  const outDir = opts.outDir ?? DIFF_DIR;
  const file = path.join(outDir, "diff.json");
  await writeJson(file, {
    ...diff,
    generatedAtIso: new Date().toISOString(),
    reproduce: `node bin/atlas.js diff --before ${opts.before} --after ${opts.after}`,
    source: { before: opts.before, after: opts.after },
  });
  if (!opts.quiet) printDiff(diff, file);
  return { diff, file };
}

/** @param {ReturnType<typeof diffReports>} diff @param {string} file */
function printDiff(diff, file) {
  banner(`DIFF — ${diff.headline}`);
  if (!diff.comparability.comparable) {
    log.warn("this comparison is confounded; deltas below are not attributable to the app:");
    for (const b of diff.comparability.blocking) {
      log.warn(`  ${b.reason}: ${fmt(b.before)} → ${fmt(b.after)} — ${b.why}`);
    }
  } else {
    log.info("manifest, contract, engine, Atlas build, browser and headless mode all match.");
  }
  for (const a of diff.comparability.advisory) {
    log.info(`  note: ${a.label} ${fmt(a.before)} → ${fmt(a.after)}`);
  }

  const c = diff.counts;
  log.info(
    `${c.total} profile(s): ${c.fixed} fixed, ${c.regressed} regressed, ${c.changed} changed, ` +
      `${c.unchanged} unchanged, ${c.inconclusive} inconclusive` +
      (c.added || c.removed ? `, ${c.added} added, ${c.removed} removed` : ""),
  );

  for (const p of diff.profiles) {
    if (p.status === "unchanged") continue;
    const worst = p.metrics.filter((m) => m.direction !== "same").slice(0, 3);
    const tail = worst.length
      ? ` (${worst.map((m) => `${m.label} ${m.before}→${m.after}${m.unit}`).join(", ")})`
      : "";
    log.info(`  ${p.status.padEnd(12)} ${p.profileId}${tail}`);
    if (p.hashes?.reading && p.status !== "added" && p.status !== "removed") {
      log.info(`               ${p.hashes.reading}`);
    }
  }
  log.info(diff.$limitations);
  log.info(`full diff → ${path.relative(process.cwd(), file)}`);
}

/** @param {unknown} v */
function fmt(v) {
  return v === null || v === undefined ? "(unrecorded)" : String(v);
}
