import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fromRoot, readJson, writeJson } from "../util/fsx.js";
import { GROQ_CODE_MODEL_DEFAULT, proposeCodePatch } from "./groq-patch.js";
import { resolveArtifactPath } from "./run-review.js";

export const CODE_PROPOSAL_LIMIT_BYTES = 64 * 1024;
const SOURCE_EXTENSIONS = new Set([".css", ".html", ".js", ".jsx", ".mjs", ".svelte", ".ts", ".tsx", ".vue"]);

/** Create a local-only, unapplied patch proposal for one supplied component source file. */
export async function runCodeProposal(opts = {}) {
  if (!opts.sourcePath) throw new Error("--source is required");
  if (opts.consentToSendCode !== true) throw new Error("source-code provider egress is off; pass --consent-to-send-code only after approving this source for Groq processing");
  const sourcePath = await resolveArtifactPath(path.relative(fromRoot(), path.resolve(opts.sourcePath)).split(path.sep).join("/"));
  const sourceInfo = await stat(sourcePath);
  if (!sourceInfo.isFile()) throw new Error("source path is not a regular file");
  if (sourceInfo.size > CODE_PROPOSAL_LIMIT_BYTES) throw new Error("source exceeds the 64 KiB code-proposal limit");
  if (!SOURCE_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) throw new Error("source must be a supported text file: css, html, js, jsx, mjs, svelte, ts, tsx or vue");
  const sourceBytes = await readFile(sourcePath);
  const source = sourceBytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(sourceBytes)) throw new Error("source file must be valid UTF-8 text");

  const reviewPath = await resolveArtifactPath(path.relative(fromRoot(), path.resolve(opts.reviewPath ?? fromRoot("artifacts", "visual-review", "review.json"))).split(path.sep).join("/"));
  const reviewInfo = await stat(reviewPath);
  if (!reviewInfo.isFile() || reviewInfo.size > 256 * 1024) throw new Error("visual review must be a regular JSON file under 256 KiB");
  const review = await readJson(reviewPath).catch(() => null);
  if (!review || review.kind !== "atlas.visual-review" || !Array.isArray(review.screenshots)) throw new Error("--review must reference an Atlas visual-review JSON report");
  const findings = review.screenshots
    .filter((/** @type {any} */ item) => item.status === "analyzed")
    .flatMap((/** @type {any} */ item) => item.issues ?? [])
    .slice(0, 10)
    .map((/** @type {any} */ issue) => ({
      category: issue.category,
      kind: issue.kind,
      severity: issue.severity,
      observation: issue.observation,
      recommendation: issue.recommendation,
      region: issue.region,
    }));
  if (!findings.length) throw new Error("visual review contains no analyzed findings to address");

  const env = opts.env ?? process.env;
  const result = await proposeCodePatch({
    source,
    fileName: path.basename(sourcePath),
    findings: JSON.stringify(findings),
    task: opts.task,
    apiKey: opts.apiKey ?? env.GROQ_API_KEY,
    model: opts.model ?? env.ATLAS_GROQ_CODE_MODEL ?? GROQ_CODE_MODEL_DEFAULT,
    consentToSendCode: true,
    fetchImpl: opts.fetchImpl,
  });
  const output = {
    kind: "atlas.code-proposal",
    schemaVersion: 1,
    generatedAtIso: new Date().toISOString(),
    ...result,
    sourcePath: path.relative(process.cwd(), sourcePath).split(path.sep).join("/"),
    visualReviewPath: path.relative(process.cwd(), reviewPath).split(path.sep).join("/"),
    visualReviewSha256: reviewSha256(review),
    sourceConsent: {
      provider: "groq",
      explicitlyConfirmed: true,
      evidence: "CLI --consent-to-send-code",
    },
  };
  const outFile = path.resolve(opts.outFile ?? fromRoot("artifacts", "visual-review", "code-proposal.json"));
  await writeJson(outFile, output);
  if (!opts.quiet) console.log(`code proposal ${output.status}: not applied or tested; wrote ${path.relative(process.cwd(), outFile)}`);
  return { proposal: output, outFile };
}

function reviewSha256(review) {
  return createHash("sha256").update(JSON.stringify(review)).digest("hex");
}
