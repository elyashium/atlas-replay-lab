/**
 * The release policy, versioned and content-hashed.
 *
 * Phase 3 item 1 asks for "a versioned release-gate policy with critical-profile
 * coverage, declared hard business/fallback invariants, comfort/visual
 * thresholds, score floor, and raw component evidence", persisted into every
 * run. Until now those numbers were four `export const`s scattered through
 * `release-gate.js` with no version attached to them, which has a specific
 * consequence: a stored `SHIP` from last month and a stored `SHIP` from today
 * are indistinguishable even if the score floor moved from 50 to 70 in between.
 * A verdict without the policy that produced it is an opinion, not evidence.
 *
 * So this file holds the numbers, stamps them with a version and a content hash,
 * and `release-gate.js` reads them from here. The gate still owns the *rules* —
 * how the numbers are applied, which is code and belongs in code. This file owns
 * the *thresholds*, which are the part a team argues about and changes without
 * touching a rule.
 *
 * ## Two versions, on purpose
 *
 * `version` is hand-written and human-meaningful: it is what a report says and
 * what a person cites in a discussion. `contentHash` is computed and is what
 * actually proves two runs were graded the same way. They can disagree — someone
 * edits a threshold and forgets to bump the version — and when they do, the hash
 * is right. `policyStamp()` always emits both, precisely so that disagreement is
 * visible rather than papered over by trusting the string.
 *
 * ## What is deliberately not here
 *
 * **The business invariant.** `checkout-complete` on Orbital and
 * `session-complete` on a generic run come from the manifest, because they are
 * properties of the experience, not of the release bar. A policy that could
 * redefine what "the user finished" means would be a policy that can pass a
 * broken app by lowering its definition of working.
 *
 * **Comfort thresholds.** `src/gate/comfort.js` derives them per-manifest via
 * `comfortPolicy()`, which prefers the manifest's declared `invariants.comfort`
 * and falls back to its own defaults. `comfortReference()` below records which
 * of those two sources decided, so the gate report can say where the number came
 * from — it does not restate the numbers and create a third source of truth.
 *
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 */

import { sha256 } from "../util/hash.js";
import { SEVERITY_LEVELS } from "../decision/questions.js";
import { SEVERE_TIMING_BUDGET_MULTIPLIER } from "../decision/budget-policy.js";
import { COMFORT_POLICY_VERSION, comfortPolicy } from "./comfort.js";
import { PROFILES } from "../runner/profiles.js";

/**
 * Bump this when a threshold below changes.
 *
 * Date-prefixed rather than a bare integer because the question a reader asks
 * six months from now is "which bar was in force in September", not "which bar
 * was the fourth one". The `.N` suffix disambiguates two changes on one day.
 */
export const RELEASE_POLICY_VERSION = "2026-09-28.1";

/**
 * `releaseBlocking` index at which a finding blocks. 3 = "major".
 * The single number most likely to be argued about, so it is arguable in one
 * place.
 */
export const BLOCKING_SEVERITY_INDEX = SEVERITY_LEVELS.indexOf("major");

/**
 * Below this, a decision goes to a human instead of shipping. Matches the
 * guard's own floor so the gate and the runtime agree on what "unsure" means.
 */
export const DECISION_CONFIDENCE_FLOOR = 0.55;

/** Below this Atlas score, a run does not ship. */
export const SCORE_FLOOR = 50;

/**
 * The policy as one frozen object.
 *
 * Frozen because it is hashed: a policy that a caller can mutate after the stamp
 * is taken is a policy whose hash means nothing. `Object.freeze` is shallow, so
 * the nested objects are frozen individually below rather than trusting the
 * outer call.
 */
export const RELEASE_POLICY = Object.freeze({
  id: "atlas.release-policy",
  version: RELEASE_POLICY_VERSION,

  /** Which profiles must have produced evidence before anything can ship. */
  coverage: Object.freeze({
    criticalProfiles: Object.freeze(PROFILES.filter((p) => p.critical).map((p) => p.id)),
    // Stated as policy rather than left implicit in the runner: the baseline run
    // bypasses the tier router on purpose and is expected to fail. Grading it
    // would make the gate unpassable, which would make it decoration.
    baselineExcludedFromGrading: true,
    // A critical profile with no trace is an absence of evidence, not a pass.
    missingCriticalEvidence: "block",
  }),

  /** Numbers, and only numbers. Every one of them is a judgement call. */
  thresholds: Object.freeze({
    scoreFloor: SCORE_FLOOR,
    blockingSeverityIndex: BLOCKING_SEVERITY_INDEX,
    blockingSeverityLevel: SEVERITY_LEVELS[BLOCKING_SEVERITY_INDEX],
    decisionConfidenceFloor: DECISION_CONFIDENCE_FLOOR,
    severeTimingBudgetMultiplier: SEVERE_TIMING_BUDGET_MULTIPLIER,
  }),

  /**
   * The invariants that no tier, profile or device class excuses.
   *
   * The distinction the gate turns on: degrading the *visuals* is the entire
   * point of the tier ladder, so a low tier is never grounds for a finding.
   * Losing the end state or the safe fallback is a different kind of failure and
   * a low tier is not an excuse for it.
   */
  hardInvariants: Object.freeze({
    businessEndState: "from-manifest",
    businessEndStateNote:
      "The end state itself is declared by the experience manifest, not by this policy. A release " +
      "bar that could redefine what 'the user finished' means could pass a broken app by lowering " +
      "its own definition of working.",
    xrFallbackMustHold: true,
    fallbackRequiredOnProfiles: "from-target-contract",
  }),

  /** Comfort is per-manifest; this records only where to look. */
  comfort: Object.freeze({
    source: "src/gate/comfort.js",
    policyVersion: COMFORT_POLICY_VERSION,
    note:
      "Thresholds come from the manifest's invariants.comfort when it declares them and from " +
      "comfort.js defaults otherwise. comfortReference() records which, per run.",
  }),

  /**
   * What the gate must do when it cannot tell. Every entry here is the same
   * answer stated for a different failure: unknown is not yes.
   */
  dispositions: Object.freeze({
    inconclusiveVerdict: "block",
    harnessLoss: "block",
    workerLost: "block",
    timeout: "block",
    replayDidNotReproduce: "block",
    quantisedTimingMismatch: "info",
    guardOverride: "info",
    budgetBreach: "warn",
    severeTimingBreachOnCriticalProfile: "block",
    note:
      "A gate that reads 'we don't know' as 'yes' is not a gate. Harness failures block with a " +
      "distinct reason code from product failures, because the fix usually belongs to the harness.",
  }),

  /**
   * What must be attached to a verdict for it to count as evidence. Phase 3
   * item 1's "raw component evidence" clause: a SHIP with no component numbers
   * behind it cannot be re-examined later, so it is not evidence of anything.
   */
  evidence: Object.freeze({
    requirePerRunTrace: true,
    requireScoreComponents: true,
    requireComfortDimensions: true,
    requireManifestIdentity: true,
    requirePolicyStamp: true,
    requireEngineIdentity: true,
  }),
});

/**
 * `{ id, version, contentHash }` — the three fields that let a stored verdict be
 * traced back to the exact bar it was graded against.
 *
 * @param {typeof RELEASE_POLICY} [policy]
 */
export function policyStamp(policy = RELEASE_POLICY) {
  return {
    id: policy.id,
    version: policy.version,
    contentHash: sha256(policy, 16),
  };
}

/**
 * Where a given manifest's comfort thresholds actually came from, for the
 * report. Returns the resolved numbers *and* the source, because "30fps floor"
 * and "30fps floor because nobody declared one" are different facts.
 *
 * @param {ExperienceManifest} manifest
 */
export function comfortReference(manifest) {
  const resolved = comfortPolicy(manifest);
  return {
    policyVersion: COMFORT_POLICY_VERSION,
    source: resolved.source,
    sustainedFpsFloor: resolved.sustainedFpsFloor,
    sustainedWindowMs: resolved.sustainedWindowMs,
    p95InputToFrameMs: resolved.p95InputToFrameMs,
    requireUsableXrFallback: resolved.requireUsableXrFallback,
  };
}

/**
 * Applies a target contract's own policy on top of the repository default.
 *
 * A customer contract carries `policy.version`, `policy.criticalProfiles` and
 * `policy.minimumScore` (see `src/targets/contract.js`). Those are the
 * customer's bar for their own app and they override the defaults — but only
 * upward for the score floor. A contract that sets `minimumScore: 0` is
 * declaring it does not care about the score; it is not being allowed to
 * disable Atlas's floor for runs Atlas grades, so the effective floor is the
 * higher of the two.
 *
 * That asymmetry is the same fail-closed rule the decision guard uses: a
 * downstream input may tighten a bar and may never loosen one.
 *
 * @param {{ version?: string; criticalProfiles?: string[]; minimumScore?: number } | null | undefined} contractPolicy
 */
export function resolvePolicy(contractPolicy) {
  const base = policyStamp();
  if (!contractPolicy) {
    return {
      ...base,
      effectiveScoreFloor: SCORE_FLOOR,
      criticalProfiles: [...RELEASE_POLICY.coverage.criticalProfiles],
      contractPolicyVersion: null,
      tightened: [],
    };
  }

  /** @type {string[]} */
  const tightened = [];
  let effectiveScoreFloor = SCORE_FLOOR;
  if (typeof contractPolicy.minimumScore === "number" && contractPolicy.minimumScore > SCORE_FLOOR) {
    effectiveScoreFloor = contractPolicy.minimumScore;
    tightened.push(`scoreFloor ${SCORE_FLOOR} → ${effectiveScoreFloor} (contract)`);
  }

  const criticalProfiles = Array.isArray(contractPolicy.criticalProfiles) && contractPolicy.criticalProfiles.length
    ? [...contractPolicy.criticalProfiles]
    : [...RELEASE_POLICY.coverage.criticalProfiles];

  return {
    ...base,
    effectiveScoreFloor,
    criticalProfiles,
    contractPolicyVersion: contractPolicy.version ?? null,
    tightened,
  };
}
