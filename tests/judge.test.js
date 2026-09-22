/**
 * `atlas judge` over real trace files — rule-based path, no network, no key.
 *
 * Writes two scenario traces to a temp dir, judges them, and asserts the
 * report shape (rows, tallies, agreement-off, null jevRun). Fixture/live Jev
 * paths are covered in decision.test.js (in-memory) and exercised for real by
 * `atlas judge` with a key; this suite pins the offline default.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { orbitalManifest } from "../src/manifest/atlas-orbital.manifest.js";
import { TRACE_SCENARIOS, buildScenarioTrace } from "../src/decision/fixtures/traces.js";
import { runJudge } from "../src/judge/run-judge.js";

async function writeScenarioFiles(/** @type {string} */ dir, /** @type {string[]} */ ids) {
  /** @type {string[]} */
  const files = [];
  for (const id of ids) {
    const scenario = TRACE_SCENARIOS.find((s) => s.id === id);
    assert.ok(scenario, `unknown scenario ${id}`);
    const trace = buildScenarioTrace(scenario, orbitalManifest);
    const file = path.join(dir, `${id}.trace.json`);
    await writeFile(file, JSON.stringify(trace), "utf8");
    files.push(file);
  }
  // A non-trace JSON must be skipped, not crash the run.
  await writeFile(path.join(dir, "report.json"), JSON.stringify({ summary: {} }), "utf8");
  files.push(path.join(dir, "report.json"));
  return files;
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  delete env.ATLAS_JEV_FIXTURES;
  return env;
}

test("judge tallies rule-based verdicts and skips non-trace files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-judge-"));
  const outDir = await mkdtemp(path.join(tmpdir(), "atlas-judge-out-"));
  const first = TRACE_SCENARIOS[0].id;
  const second = TRACE_SCENARIOS[1].id;
  const files = await writeScenarioFiles(dir, [first, second]);

  const { report } = await runJudge({ traceFiles: files, outDir, env: cleanEnv(), quiet: true });

  assert.equal(report.mode, "rule-based");
  assert.equal(report.counts.judged, 2);
  assert.equal(report.counts.skipped, 1);
  assert.equal(report.rows.length, 2);
  assert.equal(report.tally.rules.n, 2);
  assert.equal(report.jevRun, null);
  assert.equal(report.agreement.available, false);
  for (const row of report.rows) {
    assert.ok(row.traceId);
    assert.ok(["pass", "degraded-but-acceptable", "fail", "inconclusive"].includes(row.rules.outcome));
    assert.equal(row.jev, null);
  }
});

test("judge --dir picks up trace files and ignores *-report.json", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-judge-"));
  const outDir = await mkdtemp(path.join(tmpdir(), "atlas-judge-out-"));
  await writeScenarioFiles(dir, [TRACE_SCENARIOS[2].id]);

  const { report } = await runJudge({ dirs: [dir], outDir, env: cleanEnv(), quiet: true });
  assert.equal(report.counts.judged, 1);
});

test("judge with no traces fails loudly instead of writing an empty report", async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "atlas-judge-out-"));
  await assert.rejects(
    () => runJudge({ dirs: [path.join(tmpdir(), "atlas-judge-nonexistent-xyz")], outDir, env: cleanEnv(), quiet: true }),
    /no trace files found/,
  );
});
