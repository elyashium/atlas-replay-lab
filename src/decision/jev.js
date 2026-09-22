/**
 * JevDecisionEngine — the optional, model-backed implementation of the same
 * DecisionEngine interface the rule engine implements.
 *
 * Design notes that matter:
 *
 *  - One batched call per decision. Jev evaluates every question in a batch
 *    independently and in parallel in a single forward pass, so asking three
 *    (tier router) or six (trace judge) questions costs close to what asking
 *    one costs. Splitting them into separate calls would be strictly worse.
 *
 *  - `rationale` is always empty. Jev has no generation phase and cannot emit
 *    text. Anything that looks like a reason in this engine's output would be
 *    invented by this file, not by the model, so it emits none. The
 *    probability distributions are the explanation.
 *
 *  - Confidence is derived locally from the returned distribution using the
 *    same functions the rule engine uses, so a confidence from either engine
 *    means the same thing and the guard can threshold on both identically.
 *
 *  - Path resolution is NOT asked of the model. Which fallback path is even
 *    renderable is a pure function of capability flags; delegating it to a
 *    model would be adding uncertainty to something already certain.
 *
 * @typedef {import("../../types/atlas.js").CapabilitySnapshot} CapabilitySnapshot
 * @typedef {import("../../types/atlas.js").DecisionContext} DecisionContext
 * @typedef {import("../../types/atlas.js").DecisionEngine} DecisionEngine
 * @typedef {import("../../types/atlas.js").ServeTier} ServeTier
 * @typedef {import("../../types/atlas.js").TierDecision} TierDecision
 * @typedef {import("../../types/atlas.js").Trace} Trace
 * @typedef {import("../../types/atlas.js").TraceVerdict} TraceVerdict
 * @typedef {import("../../types/atlas.js").RootCause} RootCause
 * @typedef {import("./jev-transport.js").JevTransport} JevTransport
 */

import { resolvePath } from "../capability/buckets.js";
import {
  OUTCOME_OPTIONS,
  RISK_LEVELS,
  ROOT_CAUSE_OPTIONS,
  SEVERITY_LEVELS,
  TIER_OPTIONS,
  confidenceOfChoice,
  confidenceOfNoul,
  expectedScore,
  round6,
  tierQuestions,
  traceQuestions,
} from "./questions.js";
import { DEFAULT_MODEL } from "./jev-transport.js";

/** @implements {DecisionEngine} */
export class JevDecisionEngine {
  /** @type {"model"} */
  kind = "model";
  name = "jev";

  /**
   * @param {{ transport: JevTransport; model?: string }} opts
   */
  constructor(opts) {
    if (!opts?.transport) throw new Error("JevDecisionEngine requires a transport");
    this.transport = opts.transport;
    this.model = opts.model ?? process.env.TYPESAFE_MODEL ?? DEFAULT_MODEL;
    /** Per-run telemetry about the engine itself, surfaced in the report. */
    this.stats = { calls: 0, totalLatencyMs: 0, inputTokens: 0, outputTokens: 0, model: this.model };
  }

  /**
   * @param {CapabilitySnapshot} state
   * @param {DecisionContext} ctx
   * @returns {Promise<TierDecision>}
   */
  async routeTier(state, ctx) {
    const questions = tierQuestions(ctx.manifest.budgets);
    // The state sent off-box is exactly the capability snapshot: coarse,
    // non-identifying, and already the shape the schema declares. Nothing is
    // added here, so nothing unexpected can leak.
    const res = await this.#call({ state: tierStateForJev(state, ctx), questions });

    const tierDist = normalizeDistribution(readDistribution(res.answers.tier), TIER_OPTIONS);
    const tier = /** @type {ServeTier} */ (
      readChoiceValue(res.answers.tier, TIER_OPTIONS) ?? argmaxKey(tierDist)
    );
    const pCamera = readProbability(res.answers.cameraPathSafe);
    const riskDist = normalizeDistribution(readScoreDistribution(res.answers.firstFrameRisk, RISK_LEVELS), RISK_LEVELS);

    return {
      tier,
      tierAnswer: { value: tier, distribution: tierDist },
      cameraPathSafe: { pTrue: round6(pCamera) },
      firstFrameRisk: {
        score: readScore(res.answers.firstFrameRisk) ?? expectedScore(riskDist, RISK_LEVELS),
        levels: [...RISK_LEVELS],
        distribution: riskDist,
      },
      path: resolvePath(state, ctx.manifest, tier),
      confidence: confidenceOfChoice(tierDist),
      engine: this.name,
      rationale: [], // Jev emits typed answers only; see the header comment.
    };
  }

  /**
   * @param {Trace} trace
   * @param {DecisionContext} ctx
   * @returns {Promise<TraceVerdict>}
   */
  async judgeTrace(trace, ctx) {
    const questions = traceQuestions(ctx.manifest);
    const res = await this.#call({ state: summariseTraceForJev(trace, ctx), questions });

    const outcomeDist = normalizeDistribution(readDistribution(res.answers.outcome), OUTCOME_OPTIONS);
    const causeDist = normalizeDistribution(readDistribution(res.answers.rootCause), ROOT_CAUSE_OPTIONS);
    const sevDist = normalizeDistribution(readScoreDistribution(res.answers.releaseBlocking, SEVERITY_LEVELS), SEVERITY_LEVELS);
    const pVisual = readProbability(res.answers.visualInvariantHeld);
    const pInteraction = readProbability(res.answers.interactionInvariantHeld);
    const pBusiness = readProbability(res.answers.businessInvariantHeld);

    return {
      outcome: {
        value: /** @type {any} */ (readChoiceValue(res.answers.outcome, OUTCOME_OPTIONS) ?? argmaxKey(outcomeDist)),
        distribution: outcomeDist,
      },
      rootCause: {
        value: /** @type {RootCause} */ (readChoiceValue(res.answers.rootCause, ROOT_CAUSE_OPTIONS) ?? argmaxKey(causeDist)),
        distribution: causeDist,
      },
      releaseBlocking: {
        score: readScore(res.answers.releaseBlocking) ?? expectedScore(sevDist, SEVERITY_LEVELS),
        levels: [...SEVERITY_LEVELS],
        distribution: sevDist,
      },
      visualInvariantHeld: { pTrue: round6(pVisual) },
      interactionInvariantHeld: { pTrue: round6(pInteraction) },
      businessInvariantHeld: { pTrue: round6(pBusiness) },
      confidence: round6(
        Math.min(
          confidenceOfChoice(outcomeDist),
          confidenceOfChoice(causeDist),
          confidenceOfNoul(pVisual),
          confidenceOfNoul(pInteraction),
          confidenceOfNoul(pBusiness),
        ),
      ),
      engine: this.name,
      rationale: [],
    };
  }

  /**
   * @param {{ state: unknown; questions: Record<string, import("./questions.js").Question> }} req
   */
  async #call(req) {
    const started = Date.now();
    const res = await this.transport.send({ ...req, model: this.model });
    this.stats.calls += 1;
    this.stats.totalLatencyMs += res.latencyMs ?? Date.now() - started;
    this.stats.inputTokens += res.usage?.inputTokens ?? res.usage?.input_tokens ?? 0;
    this.stats.outputTokens += res.usage?.outputTokens ?? res.usage?.output_tokens ?? 0;
    // The API echoes the exact versioned id that answered even when an alias
    // was sent — keep the last one seen so reports record what was tuned
    // against. Aliases move; thresholds should not silently follow them.
    if (typeof res.model === "string" && res.model) this.stats.model = res.model;
    if (!res || typeof res !== "object" || !res.answers) {
      throw new Error("Jev response did not contain an `answers` object");
    }
    for (const key of Object.keys(req.questions)) {
      if (!(key in res.answers)) throw new Error(`Jev response is missing an answer for question "${key}"`);
    }
    return res;
  }

}

/**
 * The router state is the capability snapshot plus the small amount of
 * manifest context the question text already references, so the model is not
 * being asked to guess numbers it was never given.
 *
 * Exported rather than private because the fixture builder must reproduce this
 * object *exactly* — `fixtureKey` hashes it, so a second implementation that
 * differed by one field would produce fixtures that never match at runtime and
 * fail as "no fixture for key ...", which reads like a missing fixture rather
 * than the drift it actually is. One implementation, two callers.
 *
 * @param {CapabilitySnapshot} state
 * @param {DecisionContext} ctx
 */
export function tierStateForJev(state, ctx) {
  return {
    capability: state,
    experience: {
      id: ctx.manifest.id,
      version: ctx.manifest.version,
      budgets: ctx.manifest.budgets,
      tiers: ctx.manifest.tiers.map((t) => ({
        id: t.id,
        requires: t.requires,
        particleCount: t.params.particleCount,
        textureSize: t.params.textureSize,
        targetFps: t.params.targetFps,
        totalAssetBytes: t.assets.reduce((s, a) => s + a.approxBytes, 0),
      })),
    },
    origin: ctx.origin,
  };
}

/**
 * Trims a trace down to the fields the six questions actually need.
 *
 * Two reasons, both real: the state+questions budget for a single Jev call is
 * roughly 32k tokens and a full frame-level trace can exceed that on a long
 * session; and the less that leaves the box, the smaller the privacy surface.
 * Frame-level events are summarised into counts rather than shipped.
 *
 * @param {Trace} trace
 * @param {DecisionContext} ctx
 */
export function summariseTraceForJev(trace, ctx) {
  const notable = trace.events.filter((e) => e.kind !== "frame");
  const MAX_EVENTS = 240;
  const events = notable.length <= MAX_EVENTS
    ? notable
    : [...notable.slice(0, MAX_EVENTS - 60), ...notable.slice(-60)];
  return {
    manifest: {
      id: ctx.manifest.id,
      version: ctx.manifest.version,
      budgets: ctx.manifest.budgets,
      invariants: {
        visual: ctx.manifest.invariants.visual,
        interaction: {
          ...ctx.manifest.invariants.interaction,
          // The transition list is long and the model does not need to
          // re-derive legality; the recorded verdict below states it.
          allowedTransitions: undefined,
        },
        business: ctx.manifest.invariants.business,
      },
    },
    profile: trace.resource["atlas.profile.id"],
    runKind: trace.resource["atlas.run.kind"],
    emulated: trace.resource["atlas.emulated"],
    capability: trace.capability,
    capabilityBucket: trace.capabilityBucket.id,
    servedTier: trace.servedTier,
    servedPath: trace.servedPath,
    states: trace.states,
    metrics: trace.metrics,
    checkpoints: trace.checkpoints.map((c) => ({
      id: c.id,
      tOffsetMs: c.tOffsetMs,
      state: c.state,
      focalCoverage: c.focalCoverage,
      alphaEdgeDrift: c.alphaEdgeDrift,
      screenshotCaptured: Boolean(c.screenshotPath),
    })),
    eventCount: trace.events.length,
    frameEventCount: trace.events.length - notable.length,
    eventsTruncated: notable.length > MAX_EVENTS,
    events,
    inputClasses: trace.inputClasses,
    durationMs: trace.durationMs,
  };
}

/* ── tolerant response adapters ──────────────────────────────────────────── */
/* Field names below are the verified live shape (choice/confidence/
   probabilities, score/confidence/legend/probabilities, noul); the extra
   aliases stay as defence against gateway rewrites (Vercel/OpenRouter/
   Cloudflare rename some fields). */

/**
 * @param {unknown} answer
 * @returns {Record<string, number>}
 */
export function readDistribution(answer) {
  const a = /** @type {Record<string, unknown>} */ (answer ?? {});
  const candidate = a.probabilities ?? a.distribution ?? a.probs ?? a.scores;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (candidate))) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  }
  if (Array.isArray(candidate)) {
    // [{option, probability}, ...] form.
    /** @type {Record<string, number>} */
    const out = {};
    for (const item of candidate) {
      const o = /** @type {Record<string, unknown>} */ (item ?? {});
      const key = o.option ?? o.value ?? o.level ?? o.label;
      const p = o.probability ?? o.p ?? o.score;
      if (typeof key === "string" && typeof p === "number") out[key] = p;
    }
    return out;
  }
  return {};
}

/**
 * Reads a score answer's distribution against the declared level names.
 *
 * Live score answers key `probabilities` by CRITERION INDEX ("0".."n", see the
 * answer's `legend`), not by level name — so reading them directly against
 * `levels` yields an all-zero map and a fake-uniform fallback. When the keys
 * already name the levels (as hand-authored fixtures do), the map is used
 * as-is; otherwise indices are resolved positionally, which is sound because
 * the request sends criteria index-aligned with `levels` (see questions.js).
 *
 * @param {unknown} answer
 * @param {readonly string[]} levels
 * @returns {Record<string, number>}
 */
export function readScoreDistribution(answer, levels) {
  const raw = readDistribution(answer);
  if (levels.every((l) => typeof raw[l] === "number")) return raw;
  /** @type {Record<string, number>} */
  const out = {};
  levels.forEach((level, i) => {
    const v = raw[String(i)];
    if (typeof v === "number" && Number.isFinite(v)) out[level] = v;
  });
  return out;
}

/**
 * @param {unknown} answer
 * @param {readonly string[]} allowed
 * @returns {string | null}
 */
export function readChoiceValue(answer, allowed) {
  const a = /** @type {Record<string, unknown>} */ (answer ?? {});
  for (const key of ["value", "selected", "option", "choice", "answer"]) {
    const v = a[key];
    if (typeof v === "string" && allowed.includes(v)) return v;
  }
  return null;
}

/**
 * @param {unknown} answer
 * @returns {number}
 */
export function readProbability(answer) {
  const a = /** @type {Record<string, unknown>} */ (answer ?? {});
  // "noul" first: it is the field name TypeSafe's own documented examples use
  // (`result.cameraSafe.noul`). The rest are defensive aliases.
  for (const key of ["noul", "pTrue", "probability", "p", "value", "score"]) {
    const v = a[key];
    if (typeof v === "number" && Number.isFinite(v)) return clamp01(v);
  }
  if (typeof answer === "number") return clamp01(answer);
  throw new Error("Jev noul answer did not contain a probability");
}

/**
 * @param {unknown} answer
 * @returns {number | null}
 */
export function readScore(answer) {
  const a = /** @type {Record<string, unknown>} */ (answer ?? {});
  const v = a.score ?? a.value;
  return typeof v === "number" && Number.isFinite(v) ? round6(v) : null;
}

/**
 * Fills in any missing options with zero and renormalises to sum to 1, so a
 * downstream consumer can always treat the map as a proper distribution.
 *
 * @param {Record<string, number>} dist
 * @param {readonly string[]} options
 * @returns {Record<string, number>}
 */
export function normalizeDistribution(dist, options) {
  /** @type {Record<string, number>} */
  const out = {};
  let sum = 0;
  for (const o of options) {
    const v = Math.max(0, dist[o] ?? 0);
    out[o] = v;
    sum += v;
  }
  if (sum <= 0) {
    // Degenerate response: report a uniform distribution rather than a fake
    // certainty. The guard will see the low confidence and take over.
    const p = round6(1 / options.length);
    for (const o of options) out[o] = p;
    return out;
  }
  for (const o of options) out[o] = round6(out[o] / sum);
  return out;
}

/** @param {Record<string, number>} dist */
function argmaxKey(dist) {
  const keys = Object.keys(dist);
  return keys.reduce((best, k) => (dist[k] > dist[best] ? k : best), keys[0]);
}

/** @param {number} v */
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
