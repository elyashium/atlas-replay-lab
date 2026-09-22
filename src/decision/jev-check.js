/**
 * `atlas jev-check` — validate a TypeSafe API key and prove the live Jev
 * decision path works end to end, without running the matrix.
 *
 * This is deliberately the ONE command where a missing key is an error rather
 * than a fallback: every other command degrades to the rule-based engine, so
 * without this there would be no command that tells a human "your key works".
 *
 * It performs two live calls:
 *  1. `GET /v1/models` — cheap key validation (no decision spent).
 *  2. One minimal `systemone` call (a single noul over a tiny state) — proves
 *     the question/answer shape in `jev-transport.js` matches the deployment
 *     and records end-to-end latency plus token usage.
 *
 * Nothing here touches the browser, the matrix, or any fixture.
 *
 * @typedef {import("./jev-transport.js").JevTransport} JevTransport
 */

import { HttpJevTransport, DEFAULT_MODEL } from "./jev-transport.js";
import { logger, banner } from "../util/log.js";

const log = logger("jev-check");

/**
 * @param {{ env?: NodeJS.ProcessEnv; model?: string; quiet?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean; model: string; answeredBy?: string; latencyMs: number; inputTokens: number }>}
 */
export async function runJevCheck(opts = {}) {
  const env = opts.env ?? process.env;
  const apiKey = env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "TYPESAFE_API_KEY is not set. Get a key from the TypeSafe console " +
        "(console.typesafe.ai/settings/keys, after waitlist approval), export it, and retry. " +
        "Everything else in Atlas runs without it; only this check requires it.",
    );
  }
  const model = opts.model ?? env.TYPESAFE_MODEL ?? DEFAULT_MODEL;
  const transport = new HttpJevTransport({ apiKey });

  banner("jev-check");
  log.info(`model: ${model} (versioned id like jev-1.13.0 pins the deployment; aliases move)`);

  const key = await transport.checkKey();
  log.info(`key: ok (GET /v1/models, ${key.latencyMs}ms)`);

  const started = Date.now();
  const res = await transport.send({
    model,
    state: { probe: "atlas jev-check smoke call — no user data" },
    questions: {
      alive: {
        type: "noul",
        instructions: "Is this message a connectivity probe rather than a real workload?",
        criteria: { true: "The state says it is a probe.", false: "The state is a real workload." },
      },
    },
  });
  const latencyMs = res.latencyMs ?? Date.now() - started;
  const answer = /** @type {any} */ (res.answers?.alive);
  const pTrue = typeof answer?.noul === "number" ? answer.noul : null;
  if (pTrue === null) throw new Error("live Jev response did not contain answers.alive.noul — the API shape has drifted; see jev-transport.js");
  const usage = /** @type {any} */ (res.usage ?? {});
  const inputTokens = usage.input_tokens ?? usage.inputTokens ?? 0;

  log.info(`smoke decision: alive.noul=${pTrue} (expected ≈1) in ${latencyMs}ms`);
  log.info(`tokens in: ${inputTokens} (output tokens are free)`);
  if (typeof res.model === "string" && res.model) log.info(`answered by: ${res.model} — record this if you tune thresholds`);

  return { ok: true, model, answeredBy: typeof res.model === "string" ? res.model : undefined, latencyMs, inputTokens };
}
