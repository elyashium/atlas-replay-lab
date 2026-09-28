import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKING_SEVERITY_INDEX,
  DECISION_CONFIDENCE_FLOOR,
  RELEASE_POLICY,
  RELEASE_POLICY_VERSION,
  SCORE_FLOOR,
  comfortReference,
  policyStamp,
  resolvePolicy,
} from "../src/gate/policy.js";
import * as gate from "../src/gate/release-gate.js";
import { genericManifest } from "../src/manifest/generic.manifest.js";
import {
  BUILD_BINDING_VERSION,
  buildBinding,
  classifyBuildLabel,
  requireImmutableBuild,
} from "../src/targets/build-binding.js";

/* ── the policy ──────────────────────────────────────────────────────────── */

test("release-gate.js still exports the thresholds it always did", () => {
  // The values moved into policy.js; every existing import site must keep
  // resolving, or moving a number becomes a breaking change.
  assert.equal(gate.SCORE_FLOOR, SCORE_FLOOR);
  assert.equal(gate.BLOCKING_SEVERITY_INDEX, BLOCKING_SEVERITY_INDEX);
  assert.equal(gate.DECISION_CONFIDENCE_FLOOR, DECISION_CONFIDENCE_FLOOR);
  assert.equal(gate.RELEASE_POLICY_VERSION, RELEASE_POLICY_VERSION);
});

test("the policy is frozen at every level that is hashed", () => {
  // A stamp over a mutable object proves nothing, so the freeze is asserted
  // rather than assumed from the Object.freeze call sites.
  assert.throws(() => {
    // @ts-expect-error deliberately violating the type to test the freeze
    RELEASE_POLICY.thresholds.scoreFloor = 0;
  }, TypeError);
  assert.throws(() => {
    // @ts-expect-error deliberately violating the type to test the freeze
    RELEASE_POLICY.coverage.criticalProfiles.push("invented-profile");
  }, TypeError);
  assert.equal(RELEASE_POLICY.thresholds.scoreFloor, SCORE_FLOOR);
});

test("policyStamp carries a version and a content hash that tracks the content", () => {
  const stamp = policyStamp();
  assert.equal(stamp.id, "atlas.release-policy");
  assert.equal(stamp.version, RELEASE_POLICY_VERSION);
  assert.match(stamp.contentHash, /^[0-9a-f]{16}$/);
  assert.equal(policyStamp().contentHash, stamp.contentHash, "stamping twice must agree");

  // The hash is what actually proves two runs were graded alike: a threshold
  // edited without a version bump must still change it.
  const edited = { ...RELEASE_POLICY, thresholds: { ...RELEASE_POLICY.thresholds, scoreFloor: 70 } };
  assert.notEqual(policyStamp(/** @type {any} */ (edited)).contentHash, stamp.contentHash);
});

test("critical profiles in the policy match the runner, not a hand-copied list", async () => {
  const { PROFILES } = await import("../src/runner/profiles.js");
  assert.deepEqual(
    [...RELEASE_POLICY.coverage.criticalProfiles],
    PROFILES.filter((p) => p.critical).map((p) => p.id),
  );
  assert.ok(RELEASE_POLICY.coverage.criticalProfiles.length > 0);
});

test("the policy refuses to own the business end state", () => {
  // A release bar that could redefine "the user finished" could pass a broken
  // app by lowering its own definition of working.
  assert.equal(RELEASE_POLICY.hardInvariants.businessEndState, "from-manifest");
  assert.match(RELEASE_POLICY.hardInvariants.businessEndStateNote, /manifest/);
});

test("every disposition for an unknown outcome blocks", () => {
  const d = RELEASE_POLICY.dispositions;
  for (const key of ["inconclusiveVerdict", "harnessLoss", "workerLost", "timeout", "replayDidNotReproduce"]) {
    assert.equal(d[key], "block", `${key} must block: unknown is not yes`);
  }
});

test("comfortReference reports the resolved numbers and where they came from", () => {
  const ref = comfortReference(genericManifest);
  assert.ok(["default", "manifest"].includes(ref.source));
  assert.equal(typeof ref.sustainedFpsFloor, "number");
  assert.equal(typeof ref.sustainedWindowMs, "number");
  // "30fps floor" and "30fps floor because nobody declared one" are different
  // facts, and the report must be able to tell them apart.
  assert.ok(ref.source);
});

test("a contract policy may tighten the score floor and may never loosen it", () => {
  const strict = resolvePolicy({ version: "cust-1", minimumScore: 80, criticalProfiles: ["mid-android-4g"] });
  assert.equal(strict.effectiveScoreFloor, 80);
  assert.deepEqual(strict.criticalProfiles, ["mid-android-4g"]);
  assert.equal(strict.contractPolicyVersion, "cust-1");
  assert.match(strict.tightened.join(" "), /scoreFloor/);

  for (const minimumScore of [0, 10, SCORE_FLOOR - 1, SCORE_FLOOR]) {
    const loose = resolvePolicy({ version: "cust-2", minimumScore, criticalProfiles: ["low-cpu-3g"] });
    assert.equal(loose.effectiveScoreFloor, SCORE_FLOOR, `minimumScore ${minimumScore} must not lower the floor`);
    assert.deepEqual(loose.tightened, []);
  }
});

test("resolvePolicy without a contract falls back to the repository default", () => {
  const base = resolvePolicy(null);
  assert.equal(base.effectiveScoreFloor, SCORE_FLOOR);
  assert.equal(base.contractPolicyVersion, null);
  assert.deepEqual(base.criticalProfiles, [...RELEASE_POLICY.coverage.criticalProfiles]);
  assert.equal(base.version, RELEASE_POLICY_VERSION);
});

/* ── the build binding ───────────────────────────────────────────────────── */

test("immutable build labels are accepted", () => {
  const cases = {
    "7adff4a": "git-sha",
    "b0e64d9c1f2a3b4c5d6e7f8091a2b3c4d5e6f708": "git-sha",
    "sha256:deadbeefcafe1234": "content-hash",
    "1.4.2": "semver",
    "v1.4.2": "semver",
    "1.4.2-rc.1": "semver",
    "build-4821": "monotonic",
    "2026-09-28": "dated",
    "2026-09-28.3": "dated",
  };
  for (const [id, kind] of Object.entries(cases)) {
    const verdict = classifyBuildLabel(id);
    assert.equal(verdict.immutable, true, `${id}: ${verdict.why}`);
    assert.equal(verdict.kind, kind, id);
  }
});

test("mutable labels are refused, because they name a pointer and not a build", () => {
  for (const id of ["latest", "main", "master", "HEAD", "staging", "prod", "stable", "nightly", "v2", "1.4", "2"]) {
    const verdict = classifyBuildLabel(id);
    assert.equal(verdict.immutable, false, `${id} must be refused`);
    assert.equal(verdict.kind, "mutable-label", `${id} classified as ${verdict.kind}`);
    assert.ok(verdict.why.length > 10, "a refusal must say why in a sentence");
  }
});

test("a label the classifier cannot place is refused, not accepted", () => {
  for (const id of ["my build", "release/candidate", "★", "zzzz"]) {
    assert.equal(classifyBuildLabel(id).immutable, false, id);
  }
  assert.equal(classifyBuildLabel(undefined).kind, "absent");
  assert.equal(classifyBuildLabel("").kind, "absent");
  assert.equal(classifyBuildLabel(42).kind, "unclassified");
});

test("a branch name with a build counter is a build, not a branch", () => {
  // `main` is a pointer; `main-4821` is one build produced from it. The
  // whole-string match on the mutable list is what keeps these apart.
  assert.equal(classifyBuildLabel("main-4821").immutable, true);
  assert.equal(classifyBuildLabel("main").immutable, false);
});

const contract = () => ({
  schemaVersion: 1,
  id: "acme-staging",
  environment: "staging",
  profiles: ["mid-android-4g", "low-cpu-3g"],
  policy: { version: "acme-1", criticalProfiles: ["mid-android-4g"], minimumScore: 60 },
  target: {
    url: "https://staging.acme.test/ar",
    buildId: "7adff4a",
    allowedOrigins: ["https://staging.acme.test"],
  },
});

test("buildBinding records every field, present or null, and hashes the set", () => {
  const binding = buildBinding({ contract: contract(), policy: policyStamp(), engine: { name: "guarded-jev" } });
  assert.equal(binding.bindingVersion, BUILD_BINDING_VERSION);
  assert.equal(binding.build.id, "7adff4a");
  assert.equal(binding.build.immutable, true);
  assert.equal(binding.contract.policyVersion, "acme-1");
  assert.equal(binding.releasePolicy.version, RELEASE_POLICY_VERSION);
  assert.match(binding.bindingHash, /^[0-9a-f]{16}$/);

  // A null that is present is a statement; a missing key is an ambiguity.
  assert.equal(binding.repository.commit, null);
  assert.ok("commit" in binding.repository);
  assert.ok("browserRevision" in binding.atlas);

  // Identity in one equality check.
  const same = buildBinding({ contract: contract(), policy: policyStamp(), engine: { name: "guarded-jev" } });
  assert.equal(same.bindingHash, binding.bindingHash);
  const other = buildBinding({ contract: contract(), policy: policyStamp(), engine: { name: "rules" } });
  assert.notEqual(other.bindingHash, binding.bindingHash);
});

test("a submitted run is refused when its build label cannot name the bits", () => {
  const c = contract();
  c.target.buildId = "latest";
  const verdict = requireImmutableBuild(
    buildBinding({ contract: c, policy: policyStamp(), engine: { name: "rules" } }),
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.issues.join(" "), /not immutable/);
  assert.match(verdict.issues.join(" "), /moving pointer/);
});

test("absent is allowed only when the caller says this is not release evidence", () => {
  const c = contract();
  delete c.target.buildId;
  const binding = buildBinding({ contract: c, policy: policyStamp(), engine: { name: "rules" } });

  assert.equal(requireImmutableBuild(binding).ok, false, "a submitted run must name its build");
  assert.match(requireImmutableBuild(binding).issues.join(" "), /required for a submitted run/);
  assert.equal(requireImmutableBuild(binding, { allowAbsentBuildId: true }).ok, true, "a local run need not");
});

test("a well-formed binding passes, and the strict flags add what they say", () => {
  const binding = buildBinding({ contract: contract(), policy: policyStamp(), engine: { name: "guarded-jev" } });
  assert.equal(requireImmutableBuild(binding).ok, true, requireImmutableBuild(binding).issues.join("; "));

  assert.match(requireImmutableBuild(binding, { requireRepository: true }).issues.join(" "), /repository/);
  assert.match(requireImmutableBuild(binding, { requireBrowser: true }).issues.join(" "), /browser/);

  const full = buildBinding({
    contract: contract(),
    policy: policyStamp(),
    engine: { name: "guarded-jev", version: "0.1.0" },
    browser: { product: "Chrome", revision: "140.0.7339.80" },
    repository: { url: "https://github.test/acme/app", commit: "b0e64d9" },
  });
  assert.equal(requireImmutableBuild(full, { requireRepository: true, requireBrowser: true }).ok, true);
});

test("a binding with no engine identity is refused even when everything else is fine", () => {
  // Without it, the verdict cannot be reproduced even in principle: the rules
  // that produced it are not identified.
  const binding = buildBinding({ contract: contract(), policy: policyStamp() });
  const verdict = requireImmutableBuild(binding);
  assert.equal(verdict.ok, false);
  assert.match(verdict.issues.join(" "), /engine identity/);
});

test("an unauthorized environment is refused by the binding, not only by the contract", () => {
  const c = contract();
  c.environment = "production";
  const verdict = requireImmutableBuild(
    buildBinding({ contract: c, policy: policyStamp(), engine: { name: "rules" } }),
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.issues.join(" "), /not an authorized staging target/);
});
