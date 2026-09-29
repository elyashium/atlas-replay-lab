import test from "node:test";
import assert from "node:assert/strict";
import { checkRunConclusion, conclusionForTargetVerdict, verdictFromEvidence } from "../src/github/target-check.js";

test("target check fails closed when the browser matrix or gate evidence is unavailable", () => {
  assert.equal(verdictFromEvidence({ gate: { decision: "ship", shipped: true }, matrixExitCode: 1 }), "INCONCLUSIVE");
  assert.equal(verdictFromEvidence({ gate: null, matrixExitCode: 0 }), "INCONCLUSIVE");
  assert.equal(verdictFromEvidence({ gate: { decision: "inconclusive", shipped: false }, matrixExitCode: 0 }), "INCONCLUSIVE");
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
  assert.equal(verdictFromEvidence({ gate: { decision: "ship", shipped: true }, matrixExitCode: 0 }), "SHIP");
  assert.equal(verdictFromEvidence({ gate: { decision: "ship", shipped: false }, matrixExitCode: 0 }), "INCONCLUSIVE");
  assert.equal(verdictFromEvidence({ gate: { decision: "hold", shipped: false }, matrixExitCode: 0 }), "HOLD");
});
