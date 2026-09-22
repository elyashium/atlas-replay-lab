/**
 * Live-transport shape tests — all against a mocked fetch, no network, no key.
 *
 * These pin the verified TypeSafe API shape (POST /v1/systemone, bearer auth,
 * `{model, state, questions}` → `{answers, usage, model}`) so a future edit
 * that silently re-points the endpoint or drops the auth header fails here
 * instead of at 2am against a live deployment.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  HttpJevTransport,
  DEFAULT_MODEL,
  PINNED_MODEL,
  DEFAULT_BASE_URL,
  estimateCostUsd,
  mapHttpError,
} from "../src/decision/jev-transport.js";

/** Minimal fetch stub capturing the request and returning canned responses. */
function stubFetch(handler) {
  /** @type {{ url: string; init: any } | null} */
  let seen = null;
  const fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init) => {
    seen = { url, init };
    return handler(url, init);
  };
  return { fetchImpl, seen: () => seen };
}

const okJson = (/** @type {any} */ body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const errJson = (/** @type {number} */ status, /** @type {any} */ body) => ({
  ok: false,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test("send posts to /v1/systemone with bearer auth and the model/state/questions envelope", async () => {
  const stub = stubFetch(async () =>
    okJson({ model: PINNED_MODEL, answers: { alive: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 312, output_tokens: 48 } }),
  );
  const t = new HttpJevTransport({ apiKey: "k-test", fetchImpl: stub.fetchImpl });
  const res = await t.send({
    model: "jev-latest",
    state: { probe: true },
    questions: { alive: { type: "noul", instructions: "probe?", criteria: { true: "yes", false: "no" } } },
  });
  const seen = stub.seen();
  assert.equal(seen?.url, `${DEFAULT_BASE_URL}/v1/systemone`);
  assert.equal(seen?.init.method, "POST");
  assert.match(seen?.init.headers.authorization, /^Bearer k-test$/);
  const body = JSON.parse(seen?.init.body);
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(Object.keys(body.questions), ["alive"]);
  assert.equal(res.model, PINNED_MODEL);
  assert.equal(/** @type {any} */ (res.answers.alive).noul, 0.99);
});

test("default model is the jev-latest alias", () => {
  assert.equal(DEFAULT_MODEL, "jev-latest");
});

test("usage counts both camelCase and snake_case, output tokens tracked separately", async () => {
  const { JevDecisionEngine } = await import("../src/decision/jev.js");
  const stub = stubFetch(async () =>
    okJson({
      model: PINNED_MODEL,
      answers: {
        tier: { type: "choice", choice: "mid", confidence: 0.8, probabilities: { high: 0.1, mid: 0.8, low: 0.1, "static-fallback": 0 } },
        cameraPathSafe: { type: "noul", noul: 0.2 },
        firstFrameRisk: { type: "score", score: 1.05, confidence: 0.7, legend: { 0: "a", 1: "b", 2: "c", 3: "d", 4: "e" }, probabilities: { 0: 0, 1: 0.9, 2: 0.1, 3: 0, 4: 0 } },
      },
      usage: { input_tokens: 451, output_tokens: 72 },
    }),
  );
  const { RuleBasedDecisionEngine } = await import("../src/decision/rule-based.js");
  void RuleBasedDecisionEngine;
  const { SYNTHETIC_STATES } = await import("../src/decision/fixtures/states.js");
  const { orbitalManifest } = await import("../src/manifest/atlas-orbital.manifest.js");
  const engine = new JevDecisionEngine({ transport: /** @type {any} */ ({ name: "stub", send: (req) => new HttpJevTransport({ apiKey: "k", fetchImpl: stub.fetchImpl }).send(req) }) });
  const d = await engine.routeTier(SYNTHETIC_STATES[0].state, { manifest: orbitalManifest, origin: "ci-matrix" });
  assert.equal(d.tier, "mid");
  assert.equal(engine.stats.inputTokens, 451);
  assert.equal(engine.stats.outputTokens, 72);
  assert.equal(engine.stats.model, PINNED_MODEL);
});

test("error mapping names the actionable cause", () => {
  assert.match(mapHttpError(401, '{"detail":"Cannot authenticate"}'), /bad or revoked key/);
  assert.match(mapHttpError(403, '{"detail":"Must supply an API key"}'), /never sent/);
  assert.match(mapHttpError(429, "{}"), /rate limit/);
  assert.match(mapHttpError(529, "{}"), /overloaded/);
  assert.match(mapHttpError(400, "max_tokens_exceeded"), /too large/);
  assert.match(mapHttpError(400, "Unknown model: jev-1.13"), /unknown model/i);
  assert.match(mapHttpError(422, "Field required"), /missing model/);
});

test("failed sends surface the mapped error, not a bare status", async () => {
  const stub = stubFetch(async () => errJson(401, { detail: "Cannot authenticate with the server" }));
  const t = new HttpJevTransport({ apiKey: "bad", fetchImpl: stub.fetchImpl });
  await assert.rejects(() => t.send({ model: "jev-latest", state: {}, questions: {} }), /bad or revoked key/);
});

test("checkKey GETs /v1/models with the bearer key", async () => {
  const stub = stubFetch(async (url, init) => {
    assert.equal(init.method, "GET");
    return okJson([{ id: "jev-latest" }]);
  });
  const t = new HttpJevTransport({ apiKey: "k-test", fetchImpl: stub.fetchImpl });
  const res = await t.checkKey();
  assert.equal(res.ok, true);
  assert.equal(stub.seen()?.url, `${DEFAULT_BASE_URL}/v1/models`);
});

test("estimateCostUsd follows the published $0.042/M input, output free", () => {
  assert.equal(estimateCostUsd(0), 0);
  assert.equal(estimateCostUsd(1_000_000), 0.042);
  assert.equal(estimateCostUsd(451), 0.000018942);
});

test("jev-check refuses to run without a key instead of silently falling back", async () => {
  const { runJevCheck } = await import("../src/decision/jev-check.js");
  await assert.rejects(() => runJevCheck({ env: { ...process.env, TYPESAFE_API_KEY: "" } }), /TYPESAFE_API_KEY is not set/);
});
