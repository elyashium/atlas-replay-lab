/**
 * Transport layer for TypeSafe AI's Jev ("System One" model).
 *
 * ── Wire format provenance ──────────────────────────────────────────────────
 * Verified Sept 2026 against TypeSafe's public docs plus independent live-call
 * reports (checked against live calls Sept 19, 2026):
 *
 *  - Endpoint: `POST https://api.typesafe.ai/v1/systemone`, bearer auth with
 *    `TYPESAFE_API_KEY`. Models: `jev-latest` (stable alias), `jev-preview`,
 *    or a versioned id such as `jev-1.13.0` (recommended once thresholds are
 *    tuned — aliases move). `GET /v1/models` lists the aliases.
 *  - Body: `{ model, state, questions }` where each question is
 *    `{ type, instructions, criteria }`: noul takes optional
 *    `{ true, false }` criteria; choice takes a required map of
 *    option-name → description (2–255 options); score takes a required
 *    ordered array of level descriptions (2–10 levels).
 *  - Answers come back under `answers` keyed by the caller's own question
 *    ids: choice → `{ choice, confidence, probabilities }`,
 *    score → `{ score, confidence, legend, probabilities }` (score may be
 *    fractional, e.g. 1.05), noul → `{ noul }` (a 0–1 probability, no
 *    confidence field). `usage` carries `{ input_tokens, output_tokens }`
 *    (output is reported but not billed) and `model` echoes the exact
 *    versioned id that answered — log it when tuning thresholds.
 *  - State+question budget: 64k tokens per request, 32k for state plus the
 *    longest question. Rate limits published as 1200 req/min, 250k tok/s.
 *    Errors arrive as JSON under a `detail` key (401/403 auth, 400 usage or
 *    max_tokens_exceeded, 422 missing fields, 429 rate limit, 529 overload).
 *
 *  - Jev is also reachable through Vercel AI Gateway, Cloudflare Workers AI,
 *    Netlify AI Gateway and OpenRouter with different endpoints/field names;
 *    pointing TYPESAFE_BASE_URL at one of those is the intended way to switch,
 *    but the default below is TypeSafe's own API.
 *
 * This repository itself has still never run against a live Jev deployment
 * (no key in this environment) — the shape above is verified from docs, not
 * from a call made here. `atlas jev-check` performs the first live call.
 *
 * All of it is deliberately isolated in this one file, so correcting the shape
 * touches nothing in the engine, the guard, or anything downstream.
 *
 * Nothing else in Atlas imports this file directly.
 *
 * @typedef {import("./questions.js").Question} Question
 * @typedef {{ answers: Record<string, RawAnswer>; model?: string; usage?: { inputTokens?: number; input_tokens?: number; outputTokens?: number; output_tokens?: number }; latencyMs?: number }} JevResponse
 * @typedef {Record<string, unknown>} RawAnswer
 * @typedef {{ state: unknown; questions: Record<string, Question>; model: string }} JevRequest
 * @typedef {{ name: string; send(req: JevRequest): Promise<JevResponse> }} JevTransport
 */

import { readFile } from "node:fs/promises";
import { sha256 } from "../util/hash.js";
import { logger } from "../util/log.js";

const log = logger("jev");

export const DEFAULT_MODEL = "jev-latest";
export const PINNED_MODEL = "jev-1.13.0";
export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const SYSTEMONE_PATH = "/v1/systemone";
export const MODELS_PATH = "/v1/models";
/** Price per TypeSafe's published pricing: $0.042 / 1M input tokens, output free. */
export const INPUT_USD_PER_MTOK = 0.042;
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
      const res = await this.fetchImpl(`${this.baseUrl}${SYSTEMONE_PATH}`, {
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
        throw new Error(mapHttpError(res.status, body));
      }
      /** @type {JevResponse} */
      const json = /** @type {any} */ (await res.json());
      json.latencyMs = Date.now() - startedAt;
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Validates a key without spending a decision: `GET /v1/models` is
   * authenticated and cheap. Used by `atlas jev-check`.
   * @returns {Promise<{ ok: boolean; models?: unknown; latencyMs: number }>}
   */
  async checkKey() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${MODELS_PATH}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "user-agent": "atlas-replay-lab/0.1 (proof-of-work prototype)",
        },
        signal: controller.signal,
      });
      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(mapHttpError(res.status, body));
      }
      return { ok: true, models: await res.json().catch(() => null), latencyMs };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Maps an HTTP failure to an actionable message, from the error shapes
 * reproduced against the official endpoint (errors arrive as JSON under a
 * `detail` key).
 * @param {number} status
 * @param {string} body
 */
export function mapHttpError(status, body) {
  const detail = body.slice(0, 300) || "(empty body)";
  if (status === 401) return `Jev HTTP 401 (bad or revoked key): ${detail}`;
  if (status === 403) return `Jev HTTP 403 (missing Authorization header — key never sent): ${detail}`;
  if (status === 429) return `Jev HTTP 429 (rate limit: 1200 req/min, 250k tok/s): ${detail}`;
  if (status === 529) return `Jev HTTP 529 (service overloaded, retry with backoff): ${detail}`;
  if (status === 400 && /max_tokens_exceeded/i.test(body)) {
    return `Jev HTTP 400 (state too large — 64k tokens/request, 32k state+longest-question): ${detail}`;
  }
  if (status === 400 && /unknown model/i.test(body)) {
    return `Jev HTTP 400 (unknown model — use jev-latest, jev-preview, or a versioned id like jev-1.13.0): ${detail}`;
  }
  if (status === 422) return `Jev HTTP 422 (missing model/questions or a Choice without criteria): ${detail}`;
  return `Jev HTTP ${status}: ${detail}`;
}

/**
 * Estimated spend for a run. Output tokens are reported but free.
 * @param {number} inputTokens
 */
export function estimateCostUsd(inputTokens) {
  return Math.round(((inputTokens / 1_000_000) * INPUT_USD_PER_MTOK + Number.EPSILON) * 1e9) / 1e9;
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
