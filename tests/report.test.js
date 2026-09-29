/**
 * Report rendering — offline. `predictionCheck` is pure over report JSON, so
 * every branch is pinned without a browser; the render smoke proves the page
 * still builds when artifacts are missing (the "state it, don't omit" rule).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { predictionCheck, renderReport } from "../src/report/html-report.js";

const preflight = (over = {}) => ({
  url: "https://example.com/ar",
  assessment: { tier: "low", engine: "rule-based", confidence: 0.8, transferFits: 0.9, blowBudget: { score: 1 } },
  rules: { tier: "low" },
  ...over,
});

const run = (outcome, tier) => ({
  runId: `p-${outcome}`,
  error: null,
  verdict: { outcome: { value: outcome }, rootCause: { value: "unknown" } },
  servedTier: tier,
  metrics: {},
});

const matrix = (over = {}) => ({
  target: { mode: "generic", url: "https://example.com/ar?x=1" },
  runs: [run("pass", "high"), run("pass", "mid")],
  ...over,
});

test("missing inputs are stated, not defaulted", () => {
  assert.equal(predictionCheck(null, null, null).status, "missing");
  assert.equal(predictionCheck(preflight(), null, null).status, "missing");
  assert.equal(predictionCheck(null, matrix(), null).status, "missing");
});

test("non-page targets are not-applicable, not forced", () => {
  const orbital = predictionCheck(preflight(), { target: null, runs: [] }, null);
  assert.equal(orbital.status, "not-applicable");
  const viewer = predictionCheck(
    preflight(),
    { target: { mode: "viewer", uploadHash: "abc" }, runs: [] },
    null,
  );
  assert.equal(viewer.status, "not-applicable");
});

test("different targets are mismatched, not compared", () => {
  const r = predictionCheck(
    preflight({ url: "https://example.com/ar" }),
    matrix({ target: { mode: "generic", url: "https://other.test/ar" } }),
    null,
  );
  assert.equal(r.status, "mismatched-target");
  assert.match(r.detail, /example\.com.*other\.test|other\.test.*example\.com/);
});

test("target match ignores query strings, like the scrub does", () => {
  const r = predictionCheck(preflight(), matrix(), null);
  assert.equal(r.status, "confirmed");
});

test("fit predicted, nothing failed → confirmed", () => {
  const r = predictionCheck(preflight(), matrix(), { decision: "ship", shipped: true });
  assert.equal(r.status, "confirmed");
  assert.match(r.headline, /Confirmed/);
});

test("trouble predicted, failures observed → confirmed", () => {
  const p = preflight({ assessment: { tier: "static-fallback", transferFits: 0.1, blowBudget: { score: 4 } } });
  const m = matrix({ runs: [run("fail", "low"), run("pass", "mid")] });
  const r = predictionCheck(p, m, { decision: "hold", shipped: false });
  assert.equal(r.status, "confirmed");
  assert.match(r.headline, /trouble/);
});

test("fit predicted, matrix failed → refuted with the reason named", () => {
  const m = matrix({ runs: [run("fail", "low"), run("pass", "mid")] });
  const r = predictionCheck(preflight(), m, { decision: "hold", shipped: false });
  assert.equal(r.status, "refuted");
  assert.match(r.headline, /decode, render, or runtime cost/);
});

test("trouble predicted, matrix passed → refuted as conservative", () => {
  const p = preflight({ assessment: { tier: "static-fallback", transferFits: 0.2, blowBudget: { score: 3 } } });
  const r = predictionCheck(p, matrix(), null);
  assert.equal(r.status, "refuted");
  assert.match(r.headline, /conservative/);
});

test("works without a gate report", () => {
  const r = predictionCheck(preflight(), matrix(), null);
  assert.equal(r.status, "confirmed");
  assert.equal(r.gateDecision, null);
});

test("render builds a page even with nothing on disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-report-"));
  const outFile = path.join(dir, "report.html");
  const { file } = await renderReport({ outFile, artifactsDir: path.join(dir, "artifacts"), quiet: true });
  assert.equal(file, outFile);
  const html = await readFile(outFile, "utf8");
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Not run/);
});

test("visual review renders separately as advisory and escapes model text", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-report-"));
  const artifactsDir = path.join(dir, "artifacts");
  await mkdir(path.join(artifactsDir, "visual-review"), { recursive: true });
  await writeFile(path.join(artifactsDir, "visual-review", "review.json"), JSON.stringify({
    kind: "atlas.visual-review",
    requestedModel: "qwen/qwen3.8-27b",
    status: "complete",
    verdictEffect: "none",
    summary: { analyzedScreenshots: 1, advisoryIssues: 1 },
    consent: { providerEgress: true },
    screenshots: [{
      profileId: "mid-android-4g",
      checkpointId: "cp-final",
      status: "analyzed",
      artifact: "artifacts/visual-review/current.png",
      referenceArtifact: "artifacts/visual-review/reference.png",
      criteria: "Keep <script> from taking over the hierarchy.",
      issues: [{
        category: "layout",
        kind: "subjective",
        severity: "minor",
        confidence: "medium",
        observation: "<script>not executable</script>",
        recommendation: "Review the spacing.",
        region: null,
      }],
    }],
  }), "utf8");
  const outFile = path.join(dir, "report.html");
  await renderReport({ outFile, artifactsDir, quiet: true });
  const html = await readFile(outFile, "utf8");
  assert.match(html, /AI visual review <span class="pill info">advisory only<\/span>/);
  assert.match(html, /&lt;script&gt;not executable&lt;\/script&gt;/);
  assert.ok(!html.includes("<script>not executable</script>"));
  assert.match(html, /This analysis does not affect the release verdict/);
  assert.match(html, /Screenshots were sent to Groq after explicit provider-egress consent/);
  assert.match(html, /Approved design reference/);
  assert.match(html, /Team criteria:<\/b> Keep &lt;script&gt; from taking over the hierarchy/);
});

test("deterministic visual comparison displays metrics and heatmap without affecting release verdict", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-report-"));
  const artifactsDir = path.join(dir, "artifacts");
  await mkdir(path.join(artifactsDir, "visual-compare"), { recursive: true });
  await writeFile(path.join(artifactsDir, "visual-compare", "report.json"), JSON.stringify({
    kind: "atlas.visual-compare",
    status: "fail",
    verdictEffect: "none",
    metrics: { pixelDiffRatio: 0.12, perceptualScore: 0.82, actualWidth: 640, actualHeight: 480 },
    thresholds: { maxDiffRatio: 0.02, minPerceptualScore: 0.98 },
    inputs: { baseline: { sha256: "a".repeat(64) }, actual: { sha256: "b".repeat(64) } },
    heatmap: "artifacts/visual-compare/diff-heatmap.png",
  }), "utf8");
  const outFile = path.join(dir, "report.html");
  await renderReport({ outFile, artifactsDir, quiet: true });
  const html = await readFile(outFile, "utf8");
  assert.match(html, /Visual baseline comparison <span class="pill block">fail<\/span>/);
  assert.match(html, /12%/);
  assert.match(html, /0\.82/);
  assert.match(html, /red heatmap showing pixels that differ from the baseline/);
  assert.match(html, /does not affect the release verdict/);
});

test("code proposal report shows the escaped diff and labels it unapplied and untested", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-report-"));
  const artifactsDir = path.join(dir, "artifacts");
  await mkdir(path.join(artifactsDir, "visual-review"), { recursive: true });
  await writeFile(path.join(artifactsDir, "visual-review", "code-proposal.json"), JSON.stringify({
    kind: "atlas.code-proposal", status: "proposal", applied: false, testsRun: false, verdictEffect: "none",
    fileName: "Button.jsx", requestedModel: "openai/gpt-oss-120b", returnedModel: "openai/gpt-oss-120b",
    sourceSha256: "a".repeat(64), summary: "Use the approved accent token.",
    unifiedDiff: "--- a/Button.jsx\n+++ b/Button.jsx\n@@ -1 +1 @@\n-<button className=\"blue\">\n+<button className=\"teal\">",
  }), "utf8");
  const outFile = path.join(dir, "report.html");
  await renderReport({ outFile, artifactsDir, quiet: true });
  const html = await readFile(outFile, "utf8");
  assert.match(html, /Suggested component code patch/);
  assert.match(html, /not been applied or tested by Atlas/);
  assert.match(html, /&lt;button className=&quot;teal&quot;&gt;/);
  assert.ok(!html.includes('<button className="teal">'));
});

test("a diagnosis on disk reaches the page with its three lists still separate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-report-"));
  const artifactsDir = path.join(dir, "artifacts");
  await mkdir(path.join(artifactsDir, "findings"), { recursive: true });
  await writeFile(
    path.join(artifactsDir, "findings", "findings.json"),
    JSON.stringify({
      schemaVersion: 1,
      counts: { rows: 2, findings: 1, aboutTarget: 1, aboutHarness: 0, unexplained: 0 },
      source: { report: "artifacts/matrix/report.json", tracesLoaded: 1, tracesMissing: 0 },
      $limitations: { unexplained: "not a defect in the diagnosis" },
      findings: [
        {
          id: "abc123abc123",
          profileId: "xr-denied",
          severity: "major",
          lane: "emulation",
          title: "xr-denied failed its journey",
          observations: [{ what: "sustainedFps = 22.", source: "runs[].metrics.sustainedFps" }],
          inferredCauses: [
            {
              id: "fallback-absent-under-denial",
              basis: "rule",
              aboutTarget: true,
              cause: "no usable fallback was reached while the capability was denied",
              why: "the profile withheld the capability, so a compliant experience should have degraded instead of failing",
            },
          ],
          suggestedChanges: [],
          evidence: {
            runId: "r-1",
            runKind: "adaptive",
            traceSlice: [{ tOffsetMs: 1400, kind: "asset", name: "asset-load", attributeKeys: ["bytes", "ok"] }],
            traceSliceWindow: { centreMs: 1440, radiusMs: 750 },
            consoleCategories: [{ category: "graphics", count: 1, codes: ["webgl-context-lost"], firstAtMs: 1440 }],
            networkCategories: [{ category: "asset", total: 3, failed: 1 }],
            artifacts: [{ what: "trace", path: "artifacts/matrix/r-1/trace.json" }],
            hashes: { determinismHash: "d1", causalHash: "c1" },
          },
          $limitations: {
            suggestedChanges: "Always empty. Fix suggestion (Phase 5 item 2) is not implemented.",
            lane: "Emulated Chromium, not a physical handset.",
            sampleSize: "One run on one profile. A single execution is not a rate.",
          },
        },
      ],
    }),
    "utf8",
  );

  const outFile = path.join(dir, "report.html");
  await renderReport({ outFile, artifactsDir, quiet: true });
  const html = await readFile(outFile, "utf8");

  assert.match(html, /<h2>Diagnosis<\/h2>/);
  assert.match(html, /xr-denied failed its journey/);
  // The three headings must all survive: a merged "here is what went wrong and
  // how to fix it" block is exactly what the diagnosis is built to prevent.
  assert.match(html, /<h4>Observed<\/h4>/);
  assert.match(html, /<h4>Inferred cause \(rule output\)<\/h4>/);
  assert.match(html, /<h4>Suggested changes<\/h4>/);
  assert.match(html, /None\. Always empty\. Fix suggestion \(Phase 5 item 2\) is not implemented\./);
  assert.match(html, /rule fallback-absent-under-denial/);
  assert.match(html, /target app/);
  assert.match(html, /trace slice — 1 event\(s\) within ±750ms of 1440ms/);
  // Console error text never travels into a finding, so it cannot appear here.
  assert.match(html, /webgl-context-lost/);
  assert.ok(!html.includes("CONTEXT_LOST_WEBGL"));
});

test("no diagnosis on disk is stated as not run, with the command", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-report-"));
  const outFile = path.join(dir, "report.html");
  await renderReport({ outFile, artifactsDir: path.join(dir, "artifacts"), quiet: true });
  const html = await readFile(outFile, "utf8");
  assert.match(html, /<h2>Diagnosis<\/h2>/);
  assert.match(html, /node bin\/atlas\.js findings/);
});
