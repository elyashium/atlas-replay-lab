import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { decodePng, encodePng } from "../image/png.js";
import { diffImages } from "../image/diff.js";
import { writeJson, writeFileEnsured } from "../util/fsx.js";

export const VISUAL_COMPARE_MAX_BYTES = 10 * 1024 * 1024;
export const VISUAL_COMPARE_MAX_DIMENSION = 4096;
export const VISUAL_COMPARE_MAX_PIXELS = 8_000_000;

/** Deterministically compare two PNG screenshots. This standalone result does not issue a release verdict. */
export async function compareVisualImages(opts) {
  if (!opts?.baseline || !opts?.actual) throw new Error("both --baseline and --actual PNG paths are required");
  const maxDiffRatio = opts.maxDiffRatio ?? 0.02;
  const minPerceptualScore = opts.minPerceptualScore ?? 0.98;
  if (!Number.isFinite(maxDiffRatio) || maxDiffRatio < 0 || maxDiffRatio > 1) throw new Error("maxDiffRatio must be in 0..1");
  if (!Number.isFinite(minPerceptualScore) || minPerceptualScore < 0 || minPerceptualScore > 1) throw new Error("minPerceptualScore must be in 0..1");

  const baseline = await loadPng(opts.baseline);
  const actual = await loadPng(opts.actual);
  const metrics = diffImages(baseline.image, actual.image);
  const sameDimensions = baseline.image.width === actual.image.width && baseline.image.height === actual.image.height;
  const status = !sameDimensions
    ? "inconclusive"
    : metrics.pixelDiffRatio <= maxDiffRatio && metrics.perceptualScore >= minPerceptualScore
      ? "pass"
      : "fail";
  const outFile = path.resolve(opts.outFile ?? "artifacts/visual-compare/report.json");
  const heatmapFile = path.resolve(opts.heatmapFile ?? "artifacts/visual-compare/diff-heatmap.png");
  await writeJson(outFile, {
    kind: "atlas.visual-compare",
    schemaVersion: 1,
    generatedAtIso: new Date().toISOString(),
    status,
    verdictEffect: "none",
    metrics: {
      pixelDiffRatio: metrics.pixelDiffRatio,
      perceptualScore: metrics.perceptualScore,
      firstDivergenceBox: metrics.firstDivergenceBox,
      identical: metrics.identical,
      width: metrics.width,
      height: metrics.height,
      baselineWidth: baseline.image.width,
      baselineHeight: baseline.image.height,
      actualWidth: actual.image.width,
      actualHeight: actual.image.height,
    },
    thresholds: { maxDiffRatio, minPerceptualScore, channelTolerance: 6 },
    inputs: {
      baseline: { path: path.relative(process.cwd(), baseline.file).split(path.sep).join("/"), sha256: baseline.sha256 },
      actual: { path: path.relative(process.cwd(), actual.file).split(path.sep).join("/"), sha256: actual.sha256 },
    },
    heatmap: path.relative(process.cwd(), heatmapFile).split(path.sep).join("/"),
    limitations: [
      "Exact viewport, browser, component state, data and animation frame must be controlled by the caller.",
      "The pixel and coarse perceptual metrics are not a judgment of design quality or accessibility.",
      "A passing pairwise comparison means only that these two images fit the selected thresholds.",
      "Dimension mismatch is inconclusive because the screenshots are not directly comparable.",
    ],
  });
  await writeFileEnsured(heatmapFile, encodePng(makeHeatmap(baseline.image, actual.image)));
  if (!opts.quiet) console.log(`visual compare ${status}: ${metrics.pixelDiffRatio} pixel difference, perceptual ${metrics.perceptualScore}; no release-gate effect; wrote ${path.relative(process.cwd(), outFile)}`);
  return { status, metrics, outFile, heatmapFile };
}

async function loadPng(input) {
  const file = path.resolve(input);
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`visual comparison input is not a file: ${file}`);
  if (info.size > VISUAL_COMPARE_MAX_BYTES) throw new Error(`visual comparison PNG exceeds ${VISUAL_COMPARE_MAX_BYTES} bytes`);
  const bytes = await readFile(file);
  if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("visual comparison input is not a complete PNG");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > VISUAL_COMPARE_MAX_DIMENSION || height > VISUAL_COMPARE_MAX_DIMENSION || width * height > VISUAL_COMPARE_MAX_PIXELS) {
    throw new Error("visual comparison PNG dimensions exceed the limit");
  }
  const image = decodePng(bytes);
  return { file, image, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function makeHeatmap(baseline, actual) {
  if (baseline.width !== actual.width || baseline.height !== actual.height) return { width: 1, height: 1, data: Buffer.from([255, 170, 0, 255]) };
  const data = Buffer.allocUnsafe(baseline.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const changed = Math.max(Math.abs(baseline.data[i] - actual.data[i]), Math.abs(baseline.data[i + 1] - actual.data[i + 1]), Math.abs(baseline.data[i + 2] - actual.data[i + 2]), Math.abs(baseline.data[i + 3] - actual.data[i + 3])) > 6;
    if (changed) { data[i] = 245; data[i + 1] = 62; data[i + 2] = 70; }
    else {
      const gray = Math.round((baseline.data[i] + baseline.data[i + 1] + baseline.data[i + 2]) / 3 * 0.22);
      data[i] = gray; data[i + 1] = gray; data[i + 2] = gray;
    }
    data[i + 3] = 255;
  }
  return { width: baseline.width, height: baseline.height, data };
}
