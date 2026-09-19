/**
 * Engine selection — the single place that decides who answers.
 *
 * Default posture: the rule-based engine. Jev only enters the picture when
 * TYPESAFE_API_KEY is present, and even then it enters wrapped in the guard.
 * There is no configuration in which a missing key, a down API, or a slow
 * response can break the experience — it can only make the decision less
 * informed.
 *
 * @typedef {import("../../types/atlas.js").DecisionEngine} DecisionEngine
 */

import { RuleBasedDecisionEngine } from "./rule-based.js";
import { JevDecisionEngine } from "./jev.js";
import { GuardedDecisionEngine } from "./guarded.js";
import { resolveTransport, FixtureJevTransport } from "./jev-transport.js";
import { fromRoot } from "../util/fsx.js";
import { logger } from "../util/log.js";

const log = logger("decision");

export const FIXTURE_PATH = fromRoot("src", "decision", "fixtures", "jev-responses.json");

/**
 * @typedef {object} EngineSelection
 * @property {DecisionEngine} engine        the engine to use
 * @property {RuleBasedDecisionEngine} rules always available, for comparison
 * @property {DecisionEngine | null} jev     the raw (unguarded) Jev engine, if configured
 * @property {"rule-based" | "jev-live" | "jev-fixture"} mode
 * @property {string} status                 one human-readable line for the report
 */

/**
 * @param {{ env?: NodeJS.ProcessEnv; allowFixture?: boolean; quiet?: boolean }} [opts]
 * @returns {Promise<EngineSelection>}
 */
export async function selectEngine(opts = {}) {
  const env = opts.env ?? process.env;
  const rules = new RuleBasedDecisionEngine();

  const resolved = resolveTransport({ env });
  if (resolved.transport) {
    const jev = new JevDecisionEngine({ transport: resolved.transport });
    const engine = new GuardedDecisionEngine({ primary: jev, fallback: rules });
    return {
      engine,
      rules,
      jev,
      mode: "jev-live",
      status: "Jev engine ACTIVE (live TYPESAFE_API_KEY), wrapped in GuardedDecisionEngine.",
    };
  }

  // Optional: exercise the full Jev code path against hand-authored fixtures.
  // Never the default, and always labelled as illustrative rather than live.
  if (opts.allowFixture && env.ATLAS_JEV_FIXTURES === "1") {
    try {
      const transport = await FixtureJevTransport.fromFile(FIXTURE_PATH, false);
      const jev = new JevDecisionEngine({ transport });
      const engine = new GuardedDecisionEngine({ primary: jev, fallback: rules });
      if (!opts.quiet) {
        log.warn(
          "ATLAS_JEV_FIXTURES=1: running the Jev code path against hand-authored fixtures. " +
            "These are illustrative, NOT captured from a live Jev deployment.",
        );
      }
      return {
        engine,
        rules,
        jev,
        mode: "jev-fixture",
        status:
          "Jev code path exercised against hand-authored fixtures (illustrative, not live). " +
          "Unmatched states fall through to the rule-based engine via the guard.",
      };
    } catch (e) {
      log.warn(`could not load Jev fixtures (${e instanceof Error ? e.message : String(e)}); using rules only.`);
    }
  }

  if (!opts.quiet) {
    log.info(`Jev engine inactive (${resolved.reason}). Using RuleBasedDecisionEngine.`);
  }
  return {
    engine: rules,
    rules,
    jev: null,
    mode: "rule-based",
    status: `RuleBasedDecisionEngine (${resolved.reason}). No external calls were made.`,
  };
}

export { RuleBasedDecisionEngine, JevDecisionEngine, GuardedDecisionEngine };
