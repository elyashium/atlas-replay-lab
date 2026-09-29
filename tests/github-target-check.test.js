import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkRunConclusion, conclusionForTargetVerdict, isCompleteProfileEvidence, verdictFromEvidence } from "../src/github/target-check.js";
import { runAction } from "../.github/actions/atlas-target-qa/run.js";

test("target check fails closed when the browser matrix or gate evidence is unavailable", () => {
  const gate = shippedGate("b".repeat(40));
  assert.equal(verdictFromEvidence({ gate, matrixExitCode: 1, targetBuildId: "b".repeat(40) }), "INCONCLUSIVE");
  assert.equal(verdictFromEvidence({ gate: null, matrixExitCode: 0, targetBuildId: "b".repeat(40) }), "INCONCLUSIVE");
  assert.equal(verdictFromEvidence({ gate: { ...gate, decision: "inconclusive", shipped: false }, matrixExitCode: 0, targetBuildId: "b".repeat(40) }), "INCONCLUSIVE");
  assert.equal(verdictFromEvidence({ gate, matrixExitCode: 0, targetBuildId: "c".repeat(40) }), "INCONCLUSIVE");
  assert.equal(verdictFromEvidence({ gate: { ...gate, targetDecision: { ...gate.targetDecision, evidence: [null] } }, matrixExitCode: 0, targetBuildId: "b".repeat(40) }), "INCONCLUSIVE");
  const partialHold = heldGate("b".repeat(40));
  partialHold.targetDecision.requiredProfiles = ["high-wifi", "low-cpu-3g"];
  partialHold.targetDecision.evidence = [
    partialHold.targetDecision.evidence[0],
    { profileId: "low-cpu-3g", runId: null, error: "harness failure", journey: null, score: null },
  ];
  assert.equal(verdictFromEvidence({ gate: partialHold, matrixExitCode: 0, targetBuildId: "b".repeat(40) }), "INCONCLUSIVE", "a real failure cannot mask missing critical-profile harness evidence");
});

test("blocking and advisory checks preserve explicit policy semantics", () => {
  assert.equal(conclusionForTargetVerdict("SHIP", "blocking"), "success");
  assert.equal(conclusionForTargetVerdict("HOLD", "blocking"), "failure");
  assert.equal(conclusionForTargetVerdict("HOLD", "advisory"), "neutral");
  assert.equal(conclusionForTargetVerdict("INCONCLUSIVE", "advisory"), "failure");
  const advisory = checkRunConclusion({ verdict: "HOLD", mode: "advisory", buildId: "a".repeat(40), completedProfiles: 2, requiredProfiles: 3 });
  assert.match(advisory.summary, /GitHub accepts neutral required checks/);
  assert.match(advisory.title, /advisory finding/);
});

test("only a shipped gate with zero harness failure becomes SHIP", () => {
  const sha = "b".repeat(40);
  assert.equal(verdictFromEvidence({ gate: shippedGate(sha), matrixExitCode: 0, targetBuildId: sha }), "SHIP");
  assert.equal(verdictFromEvidence({ gate: { ...shippedGate(sha), shipped: false }, matrixExitCode: 0, targetBuildId: sha }), "INCONCLUSIVE");
  assert.equal(verdictFromEvidence({ gate: heldGate(sha), matrixExitCode: 0, targetBuildId: sha }), "HOLD");
  assert.equal(verdictFromEvidence({ gate: { ...shippedGate(sha), targetDecision: { ...shippedGate(sha).targetDecision, evidence: [] } }, matrixExitCode: 0, targetBuildId: sha }), "INCONCLUSIVE");
});

test("profile evidence counts require a real run, journey outcome, and finite score", () => {
  assert.equal(isCompleteProfileEvidence({ profileId: "high-wifi", runId: "run-1", error: null, journey: "pass", score: 71 }), true);
  assert.equal(isCompleteProfileEvidence({ profileId: "high-wifi", runId: "run-1", error: null, journey: undefined, score: undefined }), false);
  assert.equal(isCompleteProfileEvidence({ profileId: "high-wifi", runId: null, error: "harness", journey: null, score: null }), false);
  const check = checkRunConclusion({ verdict: "INCONCLUSIVE", mode: "advisory", buildId: "a".repeat(40), completedProfiles: 1, requiredProfiles: 2 });
  assert.match(check.summary, /1\/2 completed/);
});

test("GitHub action runs the target gate, binds the actual build SHA, and completes a commit Check Run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-gh-action-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const contractPath = path.join(workspace, "target.json");
  await writeFile(contractPath, JSON.stringify({
    schemaVersion: 1,
    authorization: { authorized: true },
    target: { url: "https://staging.example.org/scene", allowedOrigins: ["https://staging.example.org"], buildId: "mutable" },
  }));
  const calls = [];
  const checkUpdates = [];
  const sha = "a".repeat(40);
  const env = {
    ATLAS_ACTION_MODE: "blocking",
    ATLAS_ACTION_CONTRACT_PATH: "target.json",
    ATLAS_ACTION_TARGET_BUILD_ID: sha,
    ATLAS_ACTION_GITHUB_TOKEN: "test-token-that-is-not-a-real-secret",
    GITHUB_SHA: sha,
    GITHUB_REPOSITORY: "studio/experience",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_RUN_ID: "1234",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKSPACE: workspace,
    GITHUB_ACTION_PATH: path.join(process.cwd(), ".github", "actions", "atlas-target-qa"),
    GITHUB_ACTION_REF: "test-action-ref",
    GITHUB_STEP_SUMMARY: path.join(root, "summary.md"),
    GITHUB_OUTPUT: path.join(root, "output.txt"),
  };
  try {
    const result = await runAction(env, {
      async request(_env, _token, route, options) {
        calls.push({ route, options });
        if (options.method === "POST") return { id: 99 };
        checkUpdates.push(options.body);
        return {};
      },
      async runCommand(_childEnv, cli, args) {
        assert.equal(cli, path.join(process.cwd(), "bin", "atlas.js"));
        const command = args[0];
        const out = args.at(-1);
        if (command === "matrix") {
          await mkdir(out, { recursive: true });
          await writeFile(path.join(out, "report.json"), "{}\n");
          return 0;
        }
        await mkdir(out, { recursive: true });
        await writeFile(path.join(out, "report.json"), JSON.stringify({
          decision: "ship", shipped: true,
    targetBinding: { buildId: sha },
    targetDecision: { verdict: "SHIP", requiredProfiles: ["high-wifi"], evidence: [{ profileId: "high-wifi", runId: "run-1", error: null, journey: "pass", score: 91 }] },
        }));
        return 0;
      },
    });
    assert.equal(result.verdict, "SHIP");
    assert.equal(result.conclusion, "success");
    assert.equal(calls[0].options.body.head_sha, sha);
    assert.equal(calls[1].options.body.conclusion, "success");
    assert.match(calls[1].options.body.output.summary, /1\/1 completed/);
    const hydrated = JSON.parse(await readFile(path.join(result.artifactDir, "target-contract.json"), "utf8"));
    assert.equal(hydrated.target.buildId, sha);
    assert.equal((await readFile(env.GITHUB_OUTPUT, "utf8")).includes("verdict=SHIP"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("advisory HOLD is neutral while harness failure stays failed and inconclusive", async () => {
  for (const scenario of [
    { mode: "advisory", matrixExit: 0, decision: "hold", expected: ["HOLD", "neutral"] },
    { mode: "advisory", matrixExit: 1, decision: "ship", expected: ["INCONCLUSIVE", "failure"] },
    { mode: "advisory", matrixExit: 0, decision: "hold", incomplete: true, expected: ["INCONCLUSIVE", "failure"] },
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "atlas-gh-action-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "target.json"), JSON.stringify({ authorization: { authorized: true }, target: { url: "https://staging.example.org/", allowedOrigins: ["https://staging.example.org"] } }));
    const env = {
      ATLAS_ACTION_MODE: scenario.mode,
      ATLAS_ACTION_CONTRACT_PATH: "target.json",
      ATLAS_ACTION_TARGET_BUILD_ID: "b".repeat(40),
      ATLAS_ACTION_GITHUB_TOKEN: "test-token-that-is-not-a-real-secret",
      GITHUB_SHA: "c".repeat(40), GITHUB_REPOSITORY: "studio/experience", GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: "1", GITHUB_WORKSPACE: workspace,
      GITHUB_ACTION_PATH: path.join(process.cwd(), ".github", "actions", "atlas-target-qa"), GITHUB_STEP_SUMMARY: path.join(root, "summary.md"), GITHUB_OUTPUT: path.join(root, "output.txt"),
    };
    const checkUpdates = [];
    try {
      const result = await runAction(env, {
        async request(_env, _token, _route, options) { if (options.method === "POST") return { id: 2 }; checkUpdates.push(options.body); return {}; },
        async runCommand(_childEnv, _cli, args) {
          const out = args.at(-1);
          await mkdir(out, { recursive: true });
          if (args[0] === "matrix") { await writeFile(path.join(out, "report.json"), "{}\n"); return scenario.matrixExit; }
          const sha = "b".repeat(40);
          const targetDecision = scenario.incomplete
            ? { verdict: "HOLD", requiredProfiles: ["high-wifi", "low-cpu-3g"], evidence: [
                { profileId: "high-wifi", runId: "run-1", error: null, journey: "fail", score: 90 },
                { profileId: "low-cpu-3g", runId: null, error: "harness failed", journey: null, score: null },
              ] }
            : scenario.decision === "hold" ? { verdict: "HOLD", requiredProfiles: ["high-wifi"], evidence: [{ profileId: "high-wifi", runId: "run-1", error: null, journey: "fail", score: 90 }] } : shippedGate(sha).targetDecision;
          await writeFile(path.join(out, "report.json"), JSON.stringify({ decision: scenario.decision, shipped: scenario.decision === "ship", targetBinding: { buildId: sha }, targetDecision }));
          return scenario.decision === "ship" ? 0 : 1;
        },
      });
      assert.deepEqual([result.verdict, result.conclusion], scenario.expected);
      if (scenario.incomplete) assert.match(checkUpdates[0].output.summary, /1\/2 completed/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

function shippedGate(buildId) {
  return {
    decision: "ship", shipped: true,
    targetBinding: { buildId },
    targetDecision: { verdict: "SHIP", requiredProfiles: ["high-wifi"], evidence: [{ profileId: "high-wifi", runId: "run-1", error: null, journey: "pass", score: 91 }] },
  };
}

function heldGate(buildId) {
  return {
    decision: "hold", shipped: false,
    targetBinding: { buildId },
    targetDecision: { verdict: "HOLD", requiredProfiles: ["high-wifi"], evidence: [{ profileId: "high-wifi", runId: "run-1", error: null, journey: "fail", score: 91 }] },
  };
}
