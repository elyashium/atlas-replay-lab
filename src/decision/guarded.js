/**
 * GuardedDecisionEngine — the wrapper that makes a model-backed decision safe
 * to put on a request path.
 *
 * Three guards, in order of how often they fire:
 *
 *  1. **Hard feasibility.** A tier the device physically cannot render is
 *     never served, whatever the model answered. This is not a confidence
 *     question; it is a capability fact, and the deterministic engine already
 *     knows it. A model that answers "high" on a WebGL-less device gets
 *     overridden, not trusted.
 *
 *  2. **Confidence floor.** Jev returns a calibrated distribution on every
 *     answer, which means "how sure is this" is available for free at
 *     decision time. Below the floor, the rule engine answers instead. This
 *     is the cheap version of the offline-evaluation guardrail that a bandit
 *     policy would otherwise need a training pipeline to get.
 *
 *  3. **Failure containment.** Any transport error, timeout, or malformed
 *     response falls through to the rule engine. A third-party API being down
 *     degrades quality of decision, never availability of the experience.
 *
 * Every override is recorded in `decision.guard` so the report can show how
 * often the model was actually trusted, rather than asserting that it was.
 *
 * @typedef {import("../../types/atlas.js").CapabilitySnapshot} CapabilitySnapshot
 * @typedef {import("../../types/atlas.js").DecisionContext} DecisionContext
 * @typedef {import("../../types/atlas.js").DecisionEngine} DecisionEngine
 * @typedef {import("../../types/atlas.js").GuardReport} GuardReport
 * @typedef {import("../../types/atlas.js").TierDecision} TierDecision
 * @typedef {import("../../types/atlas.js").Trace} Trace
 * @typedef {import("../../types/atlas.js").TraceVerdict} TraceVerdict
 */

import { resolvePath } from "../capability/buckets.js";
import { RuleBasedDecisionEngine, tierRenderable } from "./rule-based.js";
import { logger } from "../util/log.js";

const log = logger("guard");

export const DEFAULT_TIER_CONFIDENCE_FLOOR = 0.55;
export const DEFAULT_VERDICT_CONFIDENCE_FLOOR = 0.6;

/** @implements {DecisionEngine} */
export class GuardedDecisionEngine {
  /** @type {"guarded"} */
  kind = "guarded";

  /**
   * @param {{
   *   primary: DecisionEngine;
   *   fallback?: DecisionEngine;
   *   tierConfidenceFloor?: number;
   *   verdictConfidenceFloor?: number;
   * }} opts
   */
  constructor(opts) {
    this.primary = opts.primary;
    this.fallback = opts.fallback ?? new RuleBasedDecisionEngine();
    this.tierFloor = opts.tierConfidenceFloor ?? Number(process.env.ATLAS_TIER_CONFIDENCE_FLOOR ?? DEFAULT_TIER_CONFIDENCE_FLOOR);
    this.verdictFloor = opts.verdictConfidenceFloor ?? Number(process.env.ATLAS_VERDICT_CONFIDENCE_FLOOR ?? DEFAULT_VERDICT_CONFIDENCE_FLOOR);
    this.name = `guarded(${this.primary.name}->${this.fallback.name})`;
    this.stats = { total: 0, trusted: 0, overriddenLowConfidence: 0, overriddenInfeasible: 0, overriddenError: 0 };
  }

  /**
   * @param {CapabilitySnapshot} state
   * @param {DecisionContext} ctx
   * @returns {Promise<TierDecision>}
   */
  async routeTier(state, ctx) {
    this.stats.total += 1;
    const safe = await this.fallback.routeTier(state, ctx);

    /** @type {TierDecision} */
    let primary;
    try {
      primary = await this.primary.routeTier(state, ctx);
    } catch (e) {
      this.stats.overriddenError += 1;
      const reason = `primary engine failed: ${errText(e)}`;
      log.warn(`tier routing fell back to ${this.fallback.name}: ${reason}`);
      return withGuard(safe, {
        primaryEngine: this.primary.name,
        primaryConfidence: 0,
        threshold: this.tierFloor,
        overridden: true,
        reason,
        error: errText(e),
      });
    }

    if (!tierRenderable(state, ctx.manifest, primary.tier)) {
      this.stats.overriddenInfeasible += 1;
      const reason = `primary chose '${primary.tier}', which this device cannot render; served '${safe.tier}' instead`;
      log.warn(reason);
      return withGuard(safe, {
        primaryEngine: this.primary.name,
        primaryConfidence: primary.confidence,
        threshold: this.tierFloor,
        overridden: true,
        reason,
        primaryAnswer: primary.tierAnswer,
      });
    }

    if (primary.confidence < this.tierFloor) {
      this.stats.overriddenLowConfidence += 1;
      const reason =
        `primary confidence ${primary.confidence.toFixed(3)} below floor ${this.tierFloor}; ` +
        `served deterministic '${safe.tier}' instead of '${primary.tier}'`;
      log.info(reason);
      return withGuard(safe, {
        primaryEngine: this.primary.name,
        primaryConfidence: primary.confidence,
        threshold: this.tierFloor,
        overridden: true,
        reason,
        primaryAnswer: primary.tierAnswer,
      });
    }

    this.stats.trusted += 1;
    // Re-resolve the path from capability even on the trusted branch: the path
    // is never the model's to decide.
    return withGuard(
      { ...primary, path: resolvePath(state, ctx.manifest, primary.tier) },
      {
        primaryEngine: this.primary.name,
        primaryConfidence: primary.confidence,
        threshold: this.tierFloor,
        overridden: false,
        reason: "primary answer accepted",
      },
    );
  }

  /**
   * @param {Trace} trace
   * @param {DecisionContext} ctx
   * @returns {Promise<TraceVerdict>}
   */
  async judgeTrace(trace, ctx) {
    const safe = await this.fallback.judgeTrace(trace, ctx);
    /** @type {TraceVerdict} */
    let primary;
    try {
      primary = await this.primary.judgeTrace(trace, ctx);
    } catch (e) {
      const reason = `primary engine failed: ${errText(e)}`;
      log.warn(`trace judging fell back to ${this.fallback.name}: ${reason}`);
      return {
        ...safe,
        guard: {
          primaryEngine: this.primary.name,
          primaryConfidence: 0,
          threshold: this.verdictFloor,
          overridden: true,
          reason,
          error: errText(e),
        },
      };
    }

    // A release gate must fail closed. If the model is unsure, or if the model
    // says "pass" while the deterministic evaluation says a budget was
    // breached, the deterministic verdict wins. The model is allowed to make
    // the gate stricter, never more permissive.
    const modelIsMorePermissive =
      severityRank(primary.outcome.value) < severityRank(safe.outcome.value);

    if (primary.confidence < this.verdictFloor || modelIsMorePermissive) {
      const reason =
        primary.confidence < this.verdictFloor
          ? `primary confidence ${primary.confidence.toFixed(3)} below floor ${this.verdictFloor}`
          : `primary verdict '${primary.outcome.value}' is more permissive than deterministic '${safe.outcome.value}'; gate fails closed`;
      return {
        ...safe,
        guard: {
          primaryEngine: this.primary.name,
          primaryConfidence: primary.confidence,
          threshold: this.verdictFloor,
          overridden: true,
          reason,
          primaryAnswer: primary.outcome,
        },
      };
    }

    return {
      ...primary,
      guard: {
        primaryEngine: this.primary.name,
        primaryConfidence: primary.confidence,
        threshold: this.verdictFloor,
        overridden: false,
        reason: "primary answer accepted",
      },
    };
  }
}

/** Higher = worse. Used to detect a model verdict that would loosen the gate. */
export function severityRank(/** @type {string} */ outcome) {
  switch (outcome) {
    case "pass": return 0;
    case "degraded-but-acceptable": return 1;
    case "inconclusive": return 2;
    case "fail": return 3;
    default: return 2;
  }
}

/**
 * @param {TierDecision} d
 * @param {GuardReport} guard
 * @returns {TierDecision}
 */
function withGuard(d, guard) {
  return { ...d, guard };
}

/** @param {unknown} e */
function errText(e) {
  return e instanceof Error ? e.message : String(e);
}
