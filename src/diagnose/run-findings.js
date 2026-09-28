/**
 * The IO shell around `findings.js`.
 *
 * `findings.js` is pure and deterministic on purpose — same row in, same finding
 * out, no clock, no filesystem. Everything that touches disk lives here, so a
 * test can exercise the diagnosis without a fixture directory and this file
 * stays small enough to read in one pass.
 *
 * Traces are loaded from each row's own `tracePath` rather than from a directory
 * scan, because a row that lost its trace must produce a finding *without* one
 * rather than silently picking up a neighbour's file.
 */

import path from "node:path";
import { fromRoot, readJson, writeJson } from "../util/fsx.js";
import { logger } from "../util/log.js";
import { findingsForReport } from "./findings.js";
import { policyStamp } from "../gate/policy.js";

const log = logger("diagnose");

export const FINDINGS_DIR = fromRoot("artifacts", "findings");

/**
 * @param {{
 *   report?: string;
 *   manifest?: any;
 *   outDir?: string;
 *   quiet?: boolean;
 * }} [opts]
 */
export async function runFindings(opts = {}) {
  const reportPath = opts.report ?? fromRoot("artifacts", "matrix", "report.json");
  const report = await readJson(reportPath).catch(() => null);
  if (!report || !Array.isArray(report.runs)) {
    throw new Error(
      `no matrix report with a runs array at ${reportPath} — run \`atlas matrix\` first. ` +
        "Diagnosis reads evidence; it does not produce any.",
    );
  }

  const reportDir = path.dirname(reportPath);
  /** @type {Record<string, any>} */
  const traces = {};
  let missing = 0;
  for (const row of report.runs) {
    if (!row?.tracePath) {
      missing += row?.error ? 0 : 1;
      continue;
    }
    // `tracePath` is repo-relative in the report; resolve against the repo root
    // first and fall back to the report's own directory so a copied artifact
    // bundle still resolves.
    const candidates = [fromRoot(row.tracePath), path.resolve(reportDir, path.basename(path.dirname(row.tracePath)), "trace.json")];
    for (const candidate of candidates) {
      const trace = await readJson(candidate).catch(() => null);
      if (trace) {
        traces[row.runId] = trace;
        break;
      }
    }
    if (!traces[row.runId]) missing += 1;
  }

  const manifest = opts.manifest ?? (await loadManifest(report));
  const out = findingsForReport(report, { traces, manifest, policyStamp: policyStamp() });

  const enriched = {
    ...out,
    source: {
      report: reportPath,
      reportStartedAtIso: report.startedAtIso ?? null,
      runnerBuildId: report.runnerBuildId ?? null,
      manifestHash: report.manifest?.contentHash ?? null,
      contractHash: report.target?.contractHash ?? null,
      tracesLoaded: Object.keys(traces).length,
      tracesMissing: missing,
    },
  };
  if (missing) {
    // Stated, not silent: a finding built without its trace has no slice and no
    // console categories, and a reader must be able to tell that apart from a
    // clean run.
    enriched.$limitations = {
      ...enriched.$limitations,
      traces: `${missing} run(s) had no readable trace; their findings carry no trace slice or console categories.`,
    };
  }

  const outDir = opts.outDir ?? FINDINGS_DIR;
  const file = path.join(outDir, "findings.json");
  await writeJson(file, enriched);

  if (!opts.quiet) {
    log.info(`${enriched.counts.findings} finding(s) from ${enriched.counts.rows} run(s)`);
    if (enriched.counts.aboutTarget) log.warn(`${enriched.counts.aboutTarget} attributed to the target application`);
    if (enriched.counts.aboutHarness) log.warn(`${enriched.counts.aboutHarness} attributed to the Atlas harness, not the app`);
    if (enriched.counts.unexplained) log.info(`${enriched.counts.unexplained} with no rule-inferred cause (expected; the rule set is small)`);
    for (const finding of enriched.findings) {
      log.info(`  [${finding.severity}] ${finding.title}`);
    }
  }

  return { findings: enriched, file };
}

/**
 * The manifest the report was produced under, when it can be identified.
 *
 * Only the two manifests in this repository are resolvable by id. A report from
 * an unknown manifest gets `null`, which costs the finding its comfort-policy
 * reference and nothing else — better than grading against whichever manifest
 * happened to be importable.
 *
 * @param {any} report
 */
async function loadManifest(report) {
  const id = report?.manifest?.id ?? null;
  if (!id) return null;
  try {
    if (id === "generic-url") return (await import("../manifest/generic.manifest.js")).genericManifest;
    if (id === "orbital") return (await import("../manifest/atlas-orbital.manifest.js")).orbitalManifest;
  } catch {
    return null;
  }
  return null;
}
