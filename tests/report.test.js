/**
 * Report rendering — offline. `predictionCheck` is pure over report JSON, so
 * every branch is pinned without a browser; the render smoke proves the page
 * still builds when artifacts are missing (the "state it, don't omit" rule).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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
  const { file } = await renderReport({ outFile, quiet: true });
  assert.equal(file, outFile);
  const html = await readFile(outFile, "utf8");
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Not run/);
});
