#!/usr/bin/env node
/**
 * Generates `src/decision/fixtures/jev-responses.json` from the hand-authored
 * answers in `fixtures/answers.js`.
 *
 * ## Why this is generated rather than written by hand
 *
 * `FixtureJevTransport` matches on `fixtureKey(req)`, which is
 * `sha256({state, questions, model})`. The tier state embeds the manifest's
 * budgets and every tier's asset byte totals; the questions embed the budget
 * numbers and the full criteria text. So the key changes whenever the manifest
 * changes, whenever a criterion is reworded, and whenever a tier's assets are
 * re-sized — none of which a human can compute in their head.
 *
 * Hand-maintaining the keys would mean that editing one word of a criterion
 * silently invalidates every fixture, and the failure surfaces much later as
 * "no Jev fixture for key 9f3a…" — which reads like a missing fixture rather
 * than the drift it actually is. So the answers are keyed by human-readable
 * label, this script constructs the real requests and computes the machine
 * keys, and regenerating is one command.
 *
 * Run: node scripts/build-fixtures.js
 */

import path from "node:path";
import { orbitalManifest } from "../src/manifest/atlas-orbital.manifest.js";
import { tierQuestions, traceQuestions, validateQuestions, RISK_LEVELS, SEVERITY_LEVELS, TIER_OPTIONS, OUTCOME_OPTIONS, ROOT_CAUSE_OPTIONS } from "../src/decision/questions.js";
import { tierStateForJev, summariseTraceForJev } from "../src/decision/jev.js";
import { fixtureKey, DEFAULT_MODEL } from "../src/decision/jev-transport.js";
import { SYNTHETIC_STATES } from "../src/decision/fixtures/states.js";
import { TRACE_SCENARIOS, buildScenarioTrace } from "../src/decision/fixtures/traces.js";
import { TIER_ANSWERS, TRACE_ANSWERS } from "../src/decision/fixtures/answers.js";
import { writeJson, fromRoot } from "../src/util/fsx.js";
import { logger } from "../src/util/log.js";

const log = logger("fixtures");

export const FIXTURE_FILE = fromRoot("src", "decision", "fixtures", "jev-responses.json");
export const EXAMPLES_DIR = fromRoot("examples", "traces");

/**
 * Both origins the tier router is ever called with.
 *
 * `origin` is part of the state, so it is part of the key. The live control
 * plane routes with "production" (src/runner/server.js) and the offline
 * comparison harness routes with "ci-matrix" (src/runner/run-matrix.js) — the
 * same decision from two call sites, which is exactly the §4.1 requirement that
 * CI and production share a code path. Generating both means fixture mode works
 * from either without anyone having to notice this detail.
 *
 * Trace-judge keys do not vary this way: `summariseTraceForJev` deliberately
 * omits origin, because where a trace is judged should not change the verdict.
 */
const ORIGINS = /** @type {const} */ (["production", "ci-matrix"]);

async function main() {
  const manifest = orbitalManifest;
  /** @type {Array<{ key: string; label: string; request: any; response: any }>} */
  const cases = [];
  /** @type {string[]} */
  const problems = [];

  const tQ = tierQuestions(manifest.budgets);
  const jQ = traceQuestions(manifest);

  // Structural validation first. A malformed question set would still produce
  // fixtures — they would just be fixtures for a badly-posed question, which is
  // the failure mode hardest to spot later.
  problems.push(...validateQuestions(tQ).map((p) => `tierQuestions: ${p}`));
  problems.push(...validateQuestions(jQ).map((p) => `traceQuestions: ${p}`));

  /* ── tier router ──────────────────────────────────────────────────────── */
  for (const synth of SYNTHETIC_STATES) {
    const answers = TIER_ANSWERS[synth.id];
    if (!answers) {
      problems.push(`no hand-authored tier answer for state "${synth.id}"`);
      continue;
    }
    problems.push(
      ...checkChoice(`${synth.id}.tier`, answers.tier, TIER_OPTIONS),
      ...checkScore(`${synth.id}.firstFrameRisk`, answers.firstFrameRisk, RISK_LEVELS),
      ...checkNoul(`${synth.id}.cameraPathSafe`, answers.cameraPathSafe),
    );

    for (const origin of ORIGINS) {
      const state = tierStateForJev(synth.state, { manifest, origin });
      const request = { state, questions: tQ, model: DEFAULT_MODEL };
      cases.push({
        key: fixtureKey(request),
        label: `tier/${synth.id}@${origin}`,
        request,
        response: {
          answers: {
            tier: answers.tier,
            cameraPathSafe: answers.cameraPathSafe,
            firstFrameRisk: answers.firstFrameRisk,
          },
          // Vendor-reported end-to-end latency is 70-500ms (TypeSafe's figure,
          // not one this project measured). A plausible constant is recorded so
          // the reporting path has something to format; it is not a measurement
          // and the comparison report never presents it as one.
          latencyMs: 0,
          usage: { inputTokens: approxTokens(request) },
        },
      });
    }
  }

  /* ── trace judge ──────────────────────────────────────────────────────── */
  for (const scenario of TRACE_SCENARIOS) {
    const answers = TRACE_ANSWERS[scenario.id];
    if (!answers) {
      problems.push(`no hand-authored trace answer for scenario "${scenario.id}"`);
      continue;
    }
    problems.push(
      ...checkChoice(`${scenario.id}.outcome`, answers.outcome, OUTCOME_OPTIONS),
      ...checkChoice(`${scenario.id}.rootCause`, answers.rootCause, ROOT_CAUSE_OPTIONS),
      ...checkScore(`${scenario.id}.releaseBlocking`, answers.releaseBlocking, SEVERITY_LEVELS),
      ...checkNoul(`${scenario.id}.visualInvariantHeld`, answers.visualInvariantHeld),
      ...checkNoul(`${scenario.id}.interactionInvariantHeld`, answers.interactionInvariantHeld),
      ...checkNoul(`${scenario.id}.businessInvariantHeld`, answers.businessInvariantHeld),
    );

    const trace = buildScenarioTrace(scenario, manifest);
    const state = summariseTraceForJev(trace, { manifest, origin: "ci-matrix" });
    const request = { state, questions: jQ, model: DEFAULT_MODEL };
    cases.push({
      key: fixtureKey(request),
      label: `trace/${scenario.id}`,
      request,
      response: {
        answers: { ...answers },
        latencyMs: 0,
        usage: { inputTokens: approxTokens(request) },
      },
    });

    await writeJson(path.join(EXAMPLES_DIR, `${scenario.id}.json`), trace);
  }

  /* ── collisions ───────────────────────────────────────────────────────── */
  // Two labels sharing a key means two distinct scenarios produce byte-identical
  // requests, so one silently answers for the other. Worth failing over: it
  // means a scenario is not testing what it claims to.
  const seen = new Map();
  for (const c of cases) {
    if (seen.has(c.key)) problems.push(`key collision: "${c.label}" and "${seen.get(c.key)}" hash identically`);
    else seen.set(c.key, c.label);
  }

  if (problems.length) {
    for (const p of problems) log.error(p);
    throw new Error(`${problems.length} fixture problem(s); nothing written`);
  }

  await writeJson(FIXTURE_FILE, {
    $id: "atlas/jev-responses",
    $note:
      "ILLUSTRATIVE FIXTURES — hand-authored, NOT captured from a live Jev deployment. " +
      "Every probability here was written by a human to exercise the Jev code path " +
      "without an API key. They are not evidence of how Jev behaves, and any " +
      "agreement rate computed against them measures only this file. " +
      "Regenerate with: node scripts/build-fixtures.js",
    $generatedBy: "scripts/build-fixtures.js",
    $model: DEFAULT_MODEL,
    $manifestHash: manifest.contentHash,
    cases: cases.sort((a, b) => a.label.localeCompare(b.label)),
  });

  log.info(`wrote ${cases.length} fixtures → ${path.relative(process.cwd(), FIXTURE_FILE)}`);
  log.info(`wrote ${TRACE_SCENARIOS.length} example traces → ${path.relative(process.cwd(), EXAMPLES_DIR)}`);
  log.warn("Fixtures are illustrative only. They are NOT captured Jev responses.");
}

/* ── answer validation ──────────────────────────────────────────────────── */
/*
 * These catch the class of typo that otherwise fails silently: a probability
 * key that is not a declared option gets dropped by `normalizeDistribution`,
 * the remaining mass is renormalised, and the fixture keeps working — just with
 * an answer nobody wrote. Better to refuse to build.
 */

/** @param {string} id @param {any} a @param {readonly string[]} options */
function checkChoice(id, a, options) {
  /** @type {string[]} */
  const out = [];
  if (!a || typeof a !== "object") return [`${id}: missing choice answer`];
  if (!options.includes(a.choice)) out.push(`${id}: choice "${a.choice}" is not a declared option`);
  out.push(...checkDistribution(id, a.probabilities, options));
  const top = argmax(a.probabilities ?? {});
  if (top && top !== a.choice) {
    out.push(`${id}: choice is "${a.choice}" but "${top}" carries the most probability mass`);
  }
  return out;
}

/** @param {string} id @param {any} a @param {readonly string[]} levels */
function checkScore(id, a, levels) {
  /** @type {string[]} */
  const out = [];
  if (!a || typeof a !== "object") return [`${id}: missing score answer`];
  out.push(...checkDistribution(id, a.probabilities, levels));
  if (typeof a.score !== "number" || !Number.isFinite(a.score)) {
    out.push(`${id}: score must be a finite number`);
  } else if (a.score < 0 || a.score > levels.length - 1) {
    out.push(`${id}: score ${a.score} is outside 0..${levels.length - 1}`);
  } else {
    // The score and the distribution must tell the same story. A score of 0.2
    // under a distribution centred on "very likely" is a fixture that would
    // make the engine and the report disagree with each other.
    const expected = levels.reduce((s, l, i) => s + (a.probabilities?.[l] ?? 0) * i, 0);
    if (Math.abs(expected - a.score) > 0.35) {
      out.push(`${id}: score ${a.score} disagrees with its distribution (expected ≈ ${expected.toFixed(2)})`);
    }
  }
  return out;
}

/** @param {string} id @param {any} a */
function checkNoul(id, a) {
  if (!a || typeof a !== "object") return [`${id}: missing noul answer`];
  if (typeof a.noul !== "number" || !Number.isFinite(a.noul)) return [`${id}: noul must be a finite number`];
  if (a.noul < 0 || a.noul > 1) return [`${id}: noul ${a.noul} is outside 0..1`];
  return [];
}

/** @param {string} id @param {any} dist @param {readonly string[]} options */
function checkDistribution(id, dist, options) {
  /** @type {string[]} */
  const out = [];
  if (!dist || typeof dist !== "object") return [`${id}: missing probabilities`];
  for (const key of Object.keys(dist)) {
    if (!options.includes(key)) out.push(`${id}: probability key "${key}" is not a declared option`);
  }
  for (const option of options) {
    if (!(option in dist)) out.push(`${id}: no probability for option "${option}"`);
  }
  const sum = Object.values(dist).reduce((s, v) => s + Number(v), 0);
  if (Math.abs(sum - 1) > 0.02) out.push(`${id}: probabilities sum to ${sum.toFixed(4)}, expected 1.0`);
  return out;
}

/** @param {Record<string, number>} dist */
function argmax(dist) {
  const keys = Object.keys(dist);
  if (!keys.length) return null;
  return keys.reduce((best, k) => (dist[k] > dist[best] ? k : best), keys[0]);
}

/**
 * Rough input-token estimate for the recorded usage figure. Deliberately crude
 * — it exists so the reporting path has a number to format and to show the
 * state stays well inside Jev's ~32k budget, not to bill anyone.
 *
 * @param {unknown} request
 */
function approxTokens(request) {
  return Math.ceil(JSON.stringify(request).length / 4);
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
