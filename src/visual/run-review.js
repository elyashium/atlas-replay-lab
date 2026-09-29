import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { readJson, fromRoot, writeJson } from "../util/fsx.js";
import { GROQ_VISION_MODEL_DEFAULT, VISUAL_REVIEW_IMAGE_LIMIT_BYTES, VISUAL_REVIEW_SCHEMA_VERSION, reviewScreenshotWithGroq } from "./groq-review.js";

export const VISUAL_REVIEW_DIR = fromRoot("artifacts", "visual-review");
// Start with a small, predictable provider budget: one final screenshot per
// profile for at most three profiles in a review.
export const VISUAL_REVIEW_MAX_IMAGES = 3;

/**
 * Optional local visual review of redacted target screenshots. Provider egress
 * requires screenshot consent in the target contract plus a second explicit
 * CLI confirmation. AI findings are advisory and never change the release gate.
 *
 * @param {{ matrixReportPath?: string; imagePath?: string; referencePath?: string; criteria?: string; outFile?: string; consentToSendImages?: boolean; apiKey?: string; model?: string; fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; quiet?: boolean }} [opts]
 */
export async function runVisualReview(opts = {}) {
  if (opts.imagePath && opts.matrixReportPath) throw new Error("choose either --image or --matrix, not both");
  if (opts.referencePath && !opts.imagePath) throw new Error("--reference requires --image and is available for one component screenshot");
  if (opts.referencePath && (typeof opts.criteria !== "string" || !opts.criteria.trim() || opts.criteria.trim().length > 1200)) throw new Error("--reference requires --criteria with 1..1200 characters");
  if (opts.criteria && !opts.referencePath) throw new Error("--criteria requires --reference");
  const reportPath = opts.imagePath ? null : path.resolve(opts.matrixReportPath ?? fromRoot("artifacts", "matrix", "report.json"));
  const outFile = path.resolve(opts.outFile ?? path.join(VISUAL_REVIEW_DIR, "review.json"));
  let report = null;
  let selected;
  if (opts.imagePath) {
    selected = [{ profileId: "user-provided-component", checkpointId: "provided-screenshot", path: path.relative(fromRoot(), path.resolve(opts.imagePath)).split(path.sep).join("/") }];
  } else {
    report = await readJson(reportPath ?? "").catch(() => null);
    if (!report || report.kind !== "atlas.matrix-report" || !Array.isArray(report.runs)) {
      throw new Error(`no valid Atlas matrix report at ${reportPath}`);
    }
    if (report.target?.mode !== "owned-staging-contract" || report.target?.contract?.schemaVersion !== 1) {
      throw new Error("visual review requires --image or a matrix report from a versioned owned-staging contract");
    }
    if (report.target.contract.screenshotConsent !== true) {
      throw new Error("the target contract did not consent to screenshot capture; rerun only after capture consent is given");
    }
    selected = selectScreenshots(report.runs).slice(0, VISUAL_REVIEW_MAX_IMAGES);
  }
  if (opts.consentToSendImages !== true) {
    throw new Error("provider egress is off; pass --consent-to-send-images only after approving the screenshots, references, and criteria for Groq processing");
  }
  const env = opts.env ?? process.env;
  const apiKey = opts.apiKey ?? env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is required; visual review made no provider request");

  let reference = null;
  if (opts.referencePath) {
    const file = await resolveArtifactPath(path.relative(fromRoot(), path.resolve(opts.referencePath)).split(path.sep).join("/").replaceAll("\\", "/"));
    const info = await stat(file);
    if (!info.isFile()) throw new Error("reference image is not a regular file");
    if (info.size > VISUAL_REVIEW_IMAGE_LIMIT_BYTES) throw new Error("reference image exceeds the 10 MiB review limit");
    reference = { file, image: await readFile(file) };
  }

  const screenshots = [];
  for (const entry of selected) {
    try {
      const file = await resolveArtifactPath(entry.path);
      const info = await stat(file);
      if (!info.isFile()) throw new Error("screenshot path is not a regular file");
      if (info.size > VISUAL_REVIEW_IMAGE_LIMIT_BYTES) throw new Error("screenshot exceeds the 10 MiB review limit");
      const image = await readFile(file);
      const review = await reviewScreenshotWithGroq({
        image,
        profileId: entry.profileId,
        checkpointId: entry.checkpointId,
        referenceImage: reference?.image,
        criteria: opts.criteria,
        apiKey,
        model: opts.model ?? env.ATLAS_GROQ_VISION_MODEL ?? GROQ_VISION_MODEL_DEFAULT,
        fetchImpl: opts.fetchImpl,
      });
      screenshots.push({
        profileId: entry.profileId,
        checkpointId: entry.checkpointId,
        artifact: path.relative(process.cwd(), file).split(path.sep).join("/"),
        referenceArtifact: reference ? path.relative(process.cwd(), reference.file).split(path.sep).join("/") : null,
        criteria: reference ? opts.criteria.trim() : null,
        status: "analyzed",
        ...review,
      });
    } catch (error) {
      screenshots.push({
        profileId: entry.profileId,
        checkpointId: entry.checkpointId,
        artifact: entry.path,
        status: "inconclusive",
        issues: [],
        error: safeError(error),
        verdictEffect: "none",
      });
    }
  }

  const analyzed = screenshots.filter((entry) => entry.status === "analyzed").length;
  const issues = screenshots.flatMap((entry) => entry.issues);
  const result = {
    kind: "atlas.visual-review",
    schemaVersion: VISUAL_REVIEW_SCHEMA_VERSION,
    generatedAtIso: new Date().toISOString(),
    provider: "groq",
    requestedModel: opts.model ?? env.ATLAS_GROQ_VISION_MODEL ?? GROQ_VISION_MODEL_DEFAULT,
    consent: {
      screenshotCapture: report ? true : "user-provided; capture was not performed by Atlas",
      providerEgress: true,
      evidence: report
        ? "explicit CLI --consent-to-send-images plus target contract screenshotConsent"
        : reference
          ? "explicit CLI --consent-to-send-images for a user-provided design reference and screenshot"
          : "explicit CLI --consent-to-send-images for a user-provided screenshot",
    },
    status: analyzed === 0 ? "inconclusive" : analyzed === screenshots.length ? "complete" : "partial",
    verdictEffect: "none",
    summary: {
      selectedScreenshots: selected.length,
      analyzedScreenshots: analyzed,
      failedScreenshots: screenshots.length - analyzed,
      advisoryIssues: issues.length,
    },
    screenshots,
    limitations: [
      "Model findings are advisory, may be incorrect, and are not a release verdict.",
      "The model's self-reported confidence labels are not calibrated by Atlas.",
      "No finding does not mean the design passed visual QA.",
      report && selected.length < report.runs.length ? `Review is capped at ${VISUAL_REVIEW_MAX_IMAGES} images; some run screenshots were not analyzed.` : null,
      "Only the final checkpoint per profile is selected by default; subjective brand fit requires a user-provided reference/rubric and is not assessed here.",
    ].filter(Boolean),
  };
  await writeJson(outFile, result);
  if (!opts.quiet) console.log(`visual review ${result.status}: ${issues.length} advisory issue(s) from ${analyzed}/${screenshots.length} image(s); no gate effect; wrote ${path.relative(process.cwd(), outFile)}`);
  return { result, outFile };
}

/** @param {any[]} rows */
function selectScreenshots(rows) {
  /** @type {Array<{ profileId: string; checkpointId: string; path: string }>} */
  const selected = [];
  for (const row of rows) {
    const entries = Object.entries(row?.screenshots ?? {}).filter(([, file]) => typeof file === "string");
    if (!entries.length) continue;
    const chosen = entries.find(([id]) => id === "cp-final") ?? entries.sort(([a], [b]) => a.localeCompare(b)).at(-1);
    if (!chosen) continue;
    selected.push({ profileId: String(row.profileId ?? "unknown"), checkpointId: chosen[0], path: chosen[1] });
  }
  return selected;
}

/** Only screenshots under artifacts/ can be sent from a report, including symlink resolution. @param {string} stored */
export async function resolveArtifactPath(stored) {
  const root = await realpath(fromRoot("artifacts"));
  const file = path.resolve(fromRoot(stored));
  const resolvedFile = await realpath(file);
  const relative = path.relative(root, resolvedFile);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("screenshot artifact must be inside the repository artifacts directory");
  }
  return resolvedFile;
}

/** @param {unknown} error */
function safeError(error) {
  const message = error instanceof Error ? error.message : "visual review failed";
  return message.slice(0, 240).replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}
