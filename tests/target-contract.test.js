import test from "node:test";
import assert from "node:assert/strict";
import { safeTargetUrl, validateTargetContract } from "../src/targets/contract.js";
import { targetPolicyDecision } from "../src/runner/run-matrix.js";
import { createTargetManifest } from "../src/manifest/target.manifest.js";
import { validateManifest } from "../src/manifest/validate.js";

const contract = () => ({
  schemaVersion: 1,
  id: "owned-stage",
  name: "Owned staging scene",
  environment: "staging",
  authorization: { authorized: true },
  target: { url: "https://stage.example.test/ar", allowedOrigins: ["https://stage.example.test"] },
  journey: {
    steps: [{ type: "waitForVisible", selector: "[data-scene-ready]" }],
    success: { selector: "[data-purchase-ready]" },
    fallback: { selector: "[data-static-fallback]", requiredOn: ["webgl-unavailable"] },
  },
  profiles: ["high-wifi", "low-cpu-3g", "webgl-unavailable"],
  budgets: { journeyTimeoutMs: 45000, stepTimeoutMs: 12000 },
  mediaConsent: false,
  policy: { version: "2026-09-01", criticalProfiles: ["high-wifi", "low-cpu-3g", "webgl-unavailable"], minimumScore: 50 },
  screenshots: { consent: true, redactSelectors: ["[data-private]"] },
});

test("target contracts demand consent, scope and explicit journey semantics", () => {
  assert.equal(validateTargetContract(contract()).ok, true);
  const invalid = contract();
  invalid.authorization.authorized = false;
  invalid.target.allowedOrigins = ["https://other.example.test"];
  invalid.journey.steps = [{ type: "click", selector: "#buy", valueFromEnv: "PASSWORD" }];
  invalid.screenshots.redactSelectors = [];
  const result = validateTargetContract(invalid);
  assert.equal(result.ok, false);
  assert.match(result.issues.join(" "), /authorization/);
  assert.match(result.issues.join(" "), /origin/);
  assert.match(result.issues.join(" "), /redactSelectors/);
});

test("credentials in URL and query strings are refused; artifact URL scrubber removes secrets", () => {
  const invalid = contract();
  invalid.target.url = "https://user:password@stage.example.test/ar?token=secret";
  const result = validateTargetContract(invalid);
  assert.match(result.issues.join(" "), /credentials/);
  assert.match(result.issues.join(" "), /query strings/);
  assert.equal(safeTargetUrl(new URL("https://stage.example.test/ar?token=secret#private")), "https://stage.example.test/ar");
});

test("target policy fails closed for failed and missing critical journey evidence", () => {
  const c = contract();
  const good = [
    { profileId: "high-wifi", runId: "a", drive: { journeyOutcome: "pass" }, targetScore: 82 },
    { profileId: "low-cpu-3g", runId: "b", drive: { journeyOutcome: "pass" }, targetScore: 66 },
    { profileId: "webgl-unavailable", runId: "c", drive: { journeyOutcome: "pass" }, targetScore: 61 },
  ];
  assert.equal(targetPolicyDecision(c, good).verdict, "SHIP");
  assert.equal(targetPolicyDecision(c, [{ ...good[0], drive: { journeyOutcome: "fail" } }, good[1]]).verdict, "HOLD");
  assert.equal(targetPolicyDecision(c, [good[0]]).verdict, "INCONCLUSIVE");
  assert.equal(targetPolicyDecision(c, [{ ...good[0], targetScore: null }, good[1]]).verdict, "INCONCLUSIVE");
});

test("target trace manifest permits the declared journey end after interactivity", () => {
  const manifest = createTargetManifest();
  const result = validateManifest(manifest);
  assert.equal(result.ok, true, result.issues.map((issue) => issue.message).join("; "));
  assert.equal(manifest.id, "atlas-owned-target");
  assert.ok(manifest.invariants.interaction.allowedTransitions.some(([from, to]) => from === "interactive" && to === "session-complete"));
});
