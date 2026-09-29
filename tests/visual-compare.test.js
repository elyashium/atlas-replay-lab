import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng, decodePng } from "../src/image/png.js";
import { compareVisualImages } from "../src/visual/compare-images.js";
import { fromRoot } from "../src/util/fsx.js";

test("identical component screenshots pass only the selected deterministic thresholds", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-visual-compare-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const baseline = path.join(dir, "baseline.png");
  const actual = path.join(dir, "actual.png");
  const png = encodePng({ width: 4, height: 4, data: Buffer.from(Array.from({ length: 16 }, (_, i) => [i * 10, 80, 120, 255]).flat()) });
  await writeFile(baseline, png);
  await writeFile(actual, png);
  const result = await compareVisualImages({ baseline, actual, outFile: path.join(dir, "report.json"), heatmapFile: path.join(dir, "heat.png"), quiet: true });
  assert.equal(result.status, "pass");
  assert.equal(result.metrics.pixelDiffRatio, 0);
  assert.equal(result.metrics.perceptualScore, 1);
  assert.equal(result.metrics.identical, true);
  const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
  assert.equal(report.verdictEffect, "none");
  assert.match(report.inputs.actual.sha256, /^[a-f0-9]{64}$/);
  assert.equal(decodePng(await readFile(path.join(dir, "heat.png"))).width, 4);
});

test("visual thresholds fail on changed pixels and dimension mismatch stays inconclusive", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-visual-compare-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const baseline = path.join(dir, "baseline.png");
  const actual = path.join(dir, "actual.png");
  await writeFile(baseline, encodePng({ width: 2, height: 2, data: Buffer.alloc(16, 0) }));
  await writeFile(actual, encodePng({ width: 2, height: 2, data: Buffer.alloc(16, 255) }));
  const changed = await compareVisualImages({ baseline, actual, maxDiffRatio: 0.01, minPerceptualScore: 0.99, outFile: path.join(dir, "changed.json"), heatmapFile: path.join(dir, "changed.png"), quiet: true });
  assert.equal(changed.status, "fail");
  assert.equal(changed.metrics.pixelDiffRatio, 1);
  await writeFile(actual, encodePng({ width: 3, height: 2, data: Buffer.alloc(24, 100) }));
  const mismatched = await compareVisualImages({ baseline, actual, outFile: path.join(dir, "mismatch.json"), heatmapFile: path.join(dir, "mismatch.png"), quiet: true });
  assert.equal(mismatched.status, "inconclusive");
});

test("invalid images and invalid policy thresholds fail without a pass result", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-visual-compare-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = path.join(dir, "bad.png");
  await writeFile(png, Buffer.from("not a png"));
  await assert.rejects(compareVisualImages({ baseline: png, actual: png, quiet: true }), /PNG/);
  await assert.rejects(compareVisualImages({ baseline: png, actual: png, maxDiffRatio: 2, quiet: true }), /maxDiffRatio/);
});

test("visual-compare CLI preserves pass, fail, and inconclusive exit semantics", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-visual-compare-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const baseline = path.join(dir, "baseline.png");
  const same = path.join(dir, "same.png");
  const changed = path.join(dir, "changed.png");
  const otherSize = path.join(dir, "other-size.png");
  await writeFile(baseline, encodePng({ width: 2, height: 2, data: Buffer.alloc(16, 0) }));
  await writeFile(same, await readFile(baseline));
  await writeFile(changed, encodePng({ width: 2, height: 2, data: Buffer.alloc(16, 255) }));
  await writeFile(otherSize, encodePng({ width: 3, height: 2, data: Buffer.alloc(24, 0) }));
  const run = (actual, name) => spawnSync(process.execPath, [
    fromRoot("bin", "atlas.js"), "visual-compare", "--baseline", baseline, "--actual", actual,
    "--out", path.join(dir, `${name}.json`), "--heatmap", path.join(dir, `${name}.png`),
  ], { cwd: fromRoot(), encoding: "utf8" });
  assert.equal(run(same, "pass").status, 0);
  assert.equal(run(changed, "fail").status, 1);
  assert.equal(run(otherSize, "inconclusive").status, 2);
});
