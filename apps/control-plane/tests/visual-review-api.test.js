import test from "node:test";
import assert from "node:assert/strict";
import { encodePng } from "../../../src/image/png.js";
import { buildApp } from "../src/server.js";

const origin = "http://127.0.0.1:3000";
const orgId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "223e4567-e89b-42d3-a456-426614174000";
const cookie = "atlas_session=0123456789abcdef0123456789abcdef0123456789abcdef";
const png = encodePng({ width: 2, height: 2, data: Buffer.from([20, 30, 40, 255, 60, 70, 80, 255, 90, 100, 110, 255, 120, 130, 140, 255]) });

function reviewPool({ role = "owner" } = {}) {
  const reviews = new Map();
  const calls = [];
  let quota = 0;
  const pool = {
    reviews, calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT u.id,u.email FROM sessions")) return { rows: [{ id: "user-1", email: "qa@example.org" }], rowCount: 1 };
      if (sql.includes("SELECT role FROM memberships")) return { rows: [{ role }], rowCount: 1 };
      if (sql.includes("SELECT id FROM projects WHERE organization_id=$1 AND id=$2")) return { rows: [{ id: projectId }], rowCount: 1 };
      if (sql.includes("SELECT id,project_id AS \"projectId\",request_sha256 AS \"requestSha256\"")) {
        const row = reviews.get(params[1]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes("INSERT INTO visual_review_usage")) {
        if (quota >= 10) return { rows: [], rowCount: 0 };
        quota += 1;
        return { rows: [{ request_count: quota }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return { query: async (sql, params = []) => {
        calls.push({ sql, params });
        if (sql.includes("INSERT INTO visual_reviews")) {
          const row = {
            id: params[0], projectId: params[2], status: params[3], requestSha256: params[6],
            result: params[10], error: params[11], screenshotSha256: params[7], referenceSha256: params[8],
            createdAt: "2026-09-29T00:00:00.000Z",
          };
          reviews.set(params[9], row);
          return { rows: [row], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }, release() {} };
    },
    async end() {},
  };
  return pool;
}

function request(app, payload, { key = "visual-review-key-1", project = projectId } = {}) {
  return app.inject({
    method: "POST", url: `/v1/projects/${project}/visual-reviews`,
    headers: { origin, "content-type": "application/json", cookie, "x-atlas-organization": orgId, "idempotency-key": key },
    payload,
  });
}

test("visual review requires consent, valid capped PNGs, and an idempotency key before provider egress", async () => {
  let providerCalls = 0;
  const app = buildApp({ pool: reviewPool(), appOrigin: origin, groqApiKey: "test-only", visualReviewer: async () => { providerCalls += 1; throw new Error("should not call"); } });
  try {
    const noConsent = await request(app, { imageBase64: png.toString("base64") });
    assert.equal(noConsent.statusCode, 400);
    const invalid = await request(app, { providerConsent: true, imageBase64: "not-base64" });
    assert.equal(invalid.statusCode, 400);
    const wrongSize = encodePng({ width: 1, height: 1, data: Buffer.from([0, 0, 0, 255]) });
    const mismatchedReference = await request(app, { providerConsent: true, imageBase64: png.toString("base64"), referenceImageBase64: wrongSize.toString("base64"), criteria: "Compare layout." });
    assert.equal(mismatchedReference.statusCode, 400);
    const noKey = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/visual-reviews`, headers: { origin, "content-type": "application/json", cookie, "x-atlas-organization": orgId }, payload: { providerConsent: true, imageBase64: png.toString("base64") } });
    assert.equal(noKey.statusCode, 400);
    assert.equal(providerCalls, 0);
  } finally { await app.close(); }
});

test("consented review stores hashes and advisory findings, not the uploaded screenshot, and retries are idempotent", async () => {
  const pool = reviewPool();
  let providerCalls = 0;
  let providerOptions;
  const app = buildApp({
    pool, appOrigin: origin, groqApiKey: "test-only",
    visualReviewer: async (options) => {
      providerCalls += 1; providerOptions = options;
      return { provider: "groq", requestedModel: "qwen/test", returnedModel: "qwen/test", imageSha256: "a".repeat(64), referenceSha256: "b".repeat(64), criteria: "Keep the teal action dominant.", issues: [{ category: "hierarchy", kind: "subjective", severity: "minor", confidence: "medium", observation: "The action blends into the footer.", recommendation: "Increase visual contrast.", region: null }], verdictEffect: "none" };
    },
  });
  const payload = { providerConsent: true, imageBase64: png.toString("base64"), referenceImageBase64: png.toString("base64"), criteria: "Keep the teal action dominant." };
  try {
    const first = await request(app, payload);
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(first.json().review.status, "complete");
    assert.equal(first.json().review.result.verdictEffect, "none");
    assert.equal(first.json().review.result.issues[0].region, null);
    assert.equal(providerOptions.apiKey, "test-only");
    assert.equal(providerOptions.image.equals(png), true);
    const writes = pool.calls.filter((call) => call.sql.includes("INSERT INTO visual_reviews"));
    assert.equal(writes.length, 1);
    assert.equal(JSON.stringify(writes[0].params).includes(png.toString("base64")), false);
    const retry = await request(app, payload);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().review.id, first.json().review.id);
    assert.equal(providerCalls, 1);
    const conflict = await request(app, { ...payload, criteria: "Different criteria." });
    assert.equal(conflict.statusCode, 409);
    assert.equal(providerCalls, 1);
  } finally { await app.close(); }
});

test("simultaneous retries with the same idempotency key share one provider request", async () => {
  let providerCalls = 0;
  const app = buildApp({ pool: reviewPool(), appOrigin: origin, groqApiKey: "test-only", visualReviewer: async () => {
    providerCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { provider: "groq", requestedModel: "qwen/test", returnedModel: "qwen/test", imageSha256: "e".repeat(64), referenceSha256: null, criteria: null, issues: [], verdictEffect: "none" };
  } });
  const payload = { providerConsent: true, imageBase64: png.toString("base64") };
  try {
    const results = await Promise.all([request(app, payload), request(app, payload)]);
    assert.deepEqual(results.map((response) => response.statusCode).sort(), [200, 201]);
    assert.equal(results[0].json().review.id, results[1].json().review.id);
    assert.equal(providerCalls, 1);
  } finally { await app.close(); }
});

test("provider failure is stored as inconclusive with a sanitized error and no pass claim", async () => {
  const app = buildApp({ pool: reviewPool(), appOrigin: origin, groqApiKey: "test-only", visualReviewer: async () => { throw new Error("provider body contains secret details"); } });
  try {
    const response = await request(app, { providerConsent: true, imageBase64: png.toString("base64") });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().review.status, "inconclusive");
    assert.equal(response.json().review.error, "Groq visual review returned an invalid or unsupported response");
    assert.equal(response.json().review.result.issues.length, 0);
    assert.match(response.json().review.result.confidenceNote, /inconclusive/);
  } finally { await app.close(); }
});

test("visual review is organization-role scoped and enforces a daily organization quota", async () => {
  let calls = 0;
  const viewerApp = buildApp({ pool: reviewPool({ role: "viewer" }), appOrigin: origin, groqApiKey: "test-only", visualReviewer: async () => { calls += 1; } });
  try {
    const denied = await request(viewerApp, { providerConsent: true, imageBase64: png.toString("base64") });
    assert.equal(denied.statusCode, 403);
  } finally { await viewerApp.close(); }

  const pool = reviewPool();
  const app = buildApp({ pool, appOrigin: origin, groqApiKey: "test-only", visualReviewer: async ({ image }) => {
    calls += 1;
    return { provider: "groq", requestedModel: "qwen/test", returnedModel: "qwen/test", imageSha256: "c".repeat(64), referenceSha256: null, criteria: null, issues: [], verdictEffect: "none" };
  } });
  try {
    for (let i = 0; i < 10; i += 1) {
      const response = await request(app, { providerConsent: true, imageBase64: png.toString("base64") }, { key: `quota-key-${i.toString().padStart(2, "0")}` });
      assert.equal(response.statusCode, 201);
    }
    const blocked = await request(app, { providerConsent: true, imageBase64: png.toString("base64") }, { key: "quota-key-10" });
    assert.equal(blocked.statusCode, 429);
    assert.equal(calls, 10);
  } finally { await app.close(); }
});
