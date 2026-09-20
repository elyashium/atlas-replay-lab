/**
 * Transport layer for TypeSafe AI's Jev ("System One" model).
 *
 * ── Read this before trusting the wire format ────────────────────────────────
 * This project was built offline. The request/response shape below is a
 * reconstruction from TypeSafe's documented question primitives (choice /
 * score / noul, batched against one state, typed answers with probability
 * distributions and no text output) rather than something verified against a
 * live endpoint.
 *
 * What the reconstruction is based on, so a human with a key knows what to
 * check first:
 *
 *  - The documented client call is shaped `systemOne({ state, questions })`,
 *    where each question is `{ type, instructions, criteria }` and `criteria`
 *    maps each declared option to its description. That is the shape
 *    `src/decision/questions.js` emits and this file forwards unchanged.
 *  - Documented answer access is `result.<id>.choice` with
 *    `result.<id>.probabilities` for a choice, and `result.<id>.noul` for a
 *    noul. The adapters in `jev.js` read those names first and fall back to
 *    plausible aliases.
 *  - The endpoint path and envelope (`POST /v1/answer`, `{model, state,
 *    questions}` → `{answers}`) are the least certain part and the most likely
 *    thing to need correcting. Jev is also reachable through Vercel AI Gateway,
 *    Cloudflare Workers AI, Netlify AI Gateway and OpenRouter; pointing
 *    TYPESAFE_BASE_URL at one of those is the intended way to switch.
 *
 * All of it is deliberately isolated in this one file, so correcting the shape
 * touches nothing in the engine, the guard, or anything downstream.
 *
 * Nothing else in Atlas imports this file directly.
 *
 * @typedef {import("./questions.js").Question} Question
 * @typedef {{ answers: Record<string, RawAnswer>; usage?: { inputTokens?: number }; latencyMs?: number }} JevResponse
 * @typedef {Record<string, unknown>} RawAnswer
 * @typedef {{ state: unknown; questions: Record<string, Question>; model: string }} JevRequest
 * @typedef {{ name: string; send(req: JevRequest): Promise<JevResponse> }} JevTransport
 */

import { readFile } from "node:fs/promises";
import { sha256 } from "../util/hash.js";
import { logger } from "../util/log.js";

const log = logger("jev");

export const DEFAULT_MODEL = "jev-1";
export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
/** Vendor-reported end-to-end range is 70-500ms; allow generous headroom. */
export const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Live HTTP transport. Only constructed when TYPESAFE_API_KEY is present.
 *
 * @implements {JevTransport}
 */
export class HttpJevTransport {
  name = "http";

  /**
   * @param {{ apiKey: string; baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch }} opts
   */
  constructor(opts) {
    if (!opts.apiKey) throw new Error("HttpJevTransport requires an apiKey");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.TYPESAFE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("global fetch is unavailable; Node 18+ is required for the live Jev transport");
    }
  }

  /**
   * @param {JevRequest} req
   * @returns {Promise<JevResponse>}
   */
  async send(req) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/answer`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          "user-agent": "atlas-replay-lab/0.1 (proof-of-work prototype)",
        },
        body: JSON.stringify({ model: req.model, state: req.state, questions: req.questions }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Jev HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      /** @type {JevResponse} */
      const json = /** @type {any} */ (await res.json());
      json.latencyMs = Date.now() - startedAt;
      return json;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Fixture transport used by the test suite and by `atlas compare` when no key
 * is configured. Fixtures are hand-authored and clearly labelled as
 * illustrative — they are NOT captured from a live Jev deployment, and the
 * comparison report says so on every line it touches.
 *
 * @implements {JevTransport}
 */
export class FixtureJevTransport {
  name = "fixture";

  /**
   * @param {{ fixtures: FixtureFile; strict?: boolean }} opts
   */
  constructor(opts) {
    this.fixtures = opts.fixtures;
    /** Throw instead of synthesising when a fixture is missing. */
    this.strict = opts.strict ?? true;
    /** @type {string[]} */
    this.misses = [];
  }

  /**
   * @param {string} file
   * @returns {Promise<FixtureJevTransport>}
   */
  static async fromFile(file, strict = true) {
    /** @type {FixtureFile} */
    const fixtures = JSON.parse(await readFile(file, "utf8"));
    return new FixtureJevTransport({ fixtures, strict });
  }

  /**
   * @param {JevRequest} req
   * @returns {Promise<JevResponse>}
   */
  async send(req) {
    const key = fixtureKey(req);
    const hit = this.fixtures.cases.find((c) => c.key === key);
    if (hit) return { ...hit.response, latencyMs: hit.response.latencyMs ?? 0 };
    this.misses.push(key);
    if (this.strict) {
      throw new FixtureMissError(
        `no Jev fixture for key ${key}; add one to ${this.fixtures.$id} or run with a live TYPESAFE_API_KEY`,
        key,
      );
    }
    throw new FixtureMissError(`no Jev fixture for key ${key}`, key);
  }
}

export class FixtureMissError extends Error {
  /** @param {string} message @param {string} key */
  constructor(message, key) {
    super(message);
    this.name = "FixtureMissError";
    this.key = key;
  }
}

/**
 * @typedef {{ $id: string; $note: string; cases: Array<{ key: string; label: string; request: JevRequest; response: JevResponse }> }} FixtureFile
 */

/**
 * Stable key for a (state, questions) pair, so fixtures can be matched without
 * depending on key ordering or whitespace.
 *
 * @param {JevRequest} req
 * @returns {string}
 */
export function fixtureKey(req) {
  return sha256({ state: req.state, questions: req.questions, model: req.model }, 16);
}

/**
 * Decides which transport to use. Returns null when Jev is not configured —
 * callers fall back to the rule-based engine and log why.
 *
 * @param {{ apiKey?: string | undefined; env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ transport: JevTransport; mode: "live" } | { transport: null; mode: "absent"; reason: string }}
 */
export function resolveTransport(opts = {}) {
  const env = opts.env ?? process.env;
  const apiKey = opts.apiKey ?? env.TYPESAFE_API_KEY;
  if (!apiKey) {
    return {
      transport: null,
      mode: "absent",
      reason: "TYPESAFE_API_KEY is not set",
    };
  }
  log.info("TYPESAFE_API_KEY detected: the Jev decision engine is ACTIVE for this run.");
  log.warn(
    "Trace JSON will be sent to a third-party API. This is off by default; see PRIVACY.md.",
  );
  return { transport: new HttpJevTransport({ apiKey }), mode: "live" };
}
