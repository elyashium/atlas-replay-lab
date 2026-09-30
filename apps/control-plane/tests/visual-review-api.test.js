import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { decodePng, encodePng } from "../../../src/image/png.js";
import { buildApp } from "../src/server.js";

const origin = "http://127.0.0.1:3000";
const orgId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "223e4567-e89b-42d3-a456-426614174000";
const runId = "323e4567-e89b-42d3-a456-426614174000";
const artifactId = "423e4567-e89b-42d3-a456-426614174000";
const referenceRunId = "523e4567-e89b-42d3-a456-426614174000";
const referenceArtifactId = "623e4567-e89b-42d3-a456-426614174000";
const cookie = "atlas_session=0123456789abcdef0123456789abcdef0123456789abcdef";
const png = encodePng({ width: 2, height: 2, data: Buffer.from([20, 30, 40, 255, 60, 70, 80, 255, 90, 100, 110, 255, 120, 130, 140, 255]) });

function reviewPool({ role = "owner", sourceArtifact = null, referenceArtifact = null } = {}) {
  const reviews = new Map();
  const reviewRecords = new Map();
  const dispositions = new Map();
  const calls = [];
  let quota = 0;
  const pool = {
    reviews, reviewRecords, dispositions, calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT u.id,u.email FROM sessions")) return { rows: [{ id: "user-1", email: "qa@example.org" }], rowCount: 1 };
      if (sql.includes("SELECT role FROM memberships")) return { rows: [{ role }], rowCount: 1 };
      if (sql.includes("SELECT id FROM projects WHERE organization_id=$1 AND id=$2")) return { rows: [{ id: projectId }], rowCount: 1 };
      if (sql.includes("SELECT a.sha256,regexp_replace")) {
        const artifact = params[1] === projectId ? params[2] === runId ? sourceArtifact : params[2] === referenceRunId ? referenceArtifact : null : null;
        return artifact ? { rows: [artifact], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT status,result FROM visual_reviews")) {
        const row = reviewRecords.get(params[2]);
        return row && params[1] === projectId ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
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
            sourceRunId: params[13], sourceArtifactId: params[14], sourceArtifactName: params[15],
            referenceRunId: params[16], referenceArtifactId: params[17], referenceArtifactName: params[18],
            createdAt: "2026-09-29T00:00:00.000Z",
          };
          reviews.set(params[9], row);
          reviewRecords.set(params[0], row);
          return { rows: [row], rowCount: 1 };
        }
        if (sql.includes("SELECT id FROM visual_reviews WHERE organization_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE")) return { rows: [{ id: params[2] }], rowCount: 1 };
        if (sql.includes("SELECT disposition FROM visual_finding_dispositions")) {
          const value = dispositions.get(`${params[1]}:${params[2]}`);
          return { rows: value ? [{ disposition: value }] : [], rowCount: value ? 1 : 0 };
        }
        if (sql.includes("INSERT INTO visual_finding_dispositions")) {
          dispositions.set(`${params[1]}:${params[2]}`, params[3]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("DELETE FROM visual_finding_dispositions")) {
          dispositions.delete(`${params[1]}:${params[2]}`);
          return { rows: [], rowCount: 1 };
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

test("visual-review route accepts bounded multi-megabyte PNG payloads without raising other API body limits", async () => {
  const currentBytes = encodePng({ width: 512, height: 512, data: randomBytes(512 * 512 * 4) });
  const referenceBytes = encodePng({ width: 512, height: 512, data: randomBytes(512 * 512 * 4) });
  assert.ok(currentBytes.length > 256 * 1024);
  assert.ok(referenceBytes.length > 256 * 1024);
  assert.ok(currentBytes.length < 10 * 1024 * 1024);
  const app = buildApp({
    pool: reviewPool(), appOrigin: origin, groqApiKey: "test-only",
    visualReviewer: async () => ({ provider: "groq", requestedModel: "qwen/test", returnedModel: "qwen/test", issues: [], verdictEffect: "none" }),
  });
  try {
    const reviewed = await request(app, {
      providerConsent: true,
      imageBase64: currentBytes.toString("base64"),
      referenceImageBase64: referenceBytes.toString("base64"),
      criteria: "Use the same component bounds.",
    });
    assert.equal(reviewed.statusCode, 201, reviewed.body);
    assert.equal(reviewed.json().review.status, "complete");
    const unrelated = await app.inject({
      method: "POST", url: "/v1/projects",
      headers: { origin, "content-type": "application/json", cookie, "x-atlas-organization": orgId },
      payload: { name: "oversized body", extra: "x".repeat(300 * 1024) },
    });
    assert.equal(unrelated.statusCode, 413);
  } finally { await app.close(); }
});

test("OpenAPI documents expiry outcomes for visual-review and code-proposal retries", async () => {
  const app = buildApp({ pool: reviewPool(), appOrigin: origin });
  try {
    const response = await app.inject({ method: "GET", url: "/api/openapi.json" });
    assert.equal(response.statusCode, 200);
    const spec = response.json();
    assert.match(spec.paths["/v1/projects/{projectId}/visual-reviews"].post.responses["410"].description, /expired/);
    assert.match(spec.paths["/v1/projects/{projectId}/visual-reviews/{reviewId}/code-proposals"].post.responses["404"].description, /expired/);
    assert.match(spec.paths["/v1/projects/{projectId}/visual-reviews/{reviewId}/code-proposals"].post.responses["410"].description, /expired/);
    assert.match(spec.paths["/v1/targets/{targetId}/runs"].post.responses["410"].description, /expired/);
    assert.match(spec.paths["/v1/runs/{runId}"].get.responses["404"].description, /expired/);
  } finally { await app.close(); }
});

test("team finding dispositions are authorized, auditable, replaceable, and verdict-neutral", async () => {
  const pool = reviewPool();
  const app = buildApp({ pool, appOrigin: origin, groqApiKey: "test-only", visualReviewer: async () => ({
    provider: "groq", requestedModel: "qwen/test", returnedModel: "qwen/test",
    issues: [{ category: "hierarchy", kind: "subjective", severity: "minor", confidence: "medium", observation: "Fixture finding.", recommendation: "Review visually.", region: null }], verdictEffect: "none",
  }) });
  try {
    const created = await request(app, { providerConsent: true, imageBase64: png.toString("base64") });
    const reviewId = created.json().review.id;
    const set = (disposition) => app.inject({
      method: "PUT", url: `/v1/projects/${projectId}/visual-reviews/${reviewId}/findings/0/disposition`,
      headers: { origin, "content-type": "application/json", cookie, "x-atlas-organization": orgId },
      payload: { disposition },
    });
    const confirmed = await set("confirmed");
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmed.json().disposition, "confirmed");
    assert.equal(confirmed.json().verdictEffect, "none");
    assert.equal(pool.dispositions.get(`${reviewId}:0`), "confirmed");
    const repeated = await set("confirmed");
    assert.equal(repeated.json().changed, false);
    const replaced = await set("false-positive");
    assert.equal(replaced.json().changed, true);
    assert.equal(pool.dispositions.get(`${reviewId}:0`), "false-positive");
    const invalid = await set("ship");
    assert.equal(invalid.statusCode, 400);
    const missing = await app.inject({ method: "PUT", url: `/v1/projects/${projectId}/visual-reviews/${reviewId}/findings/1/disposition`, headers: { origin, "content-type": "application/json", cookie, "x-atlas-organization": orgId }, payload: { disposition: "confirmed" } });
    assert.equal(missing.statusCode, 404);
    const clear = await set(null);
    assert.equal(clear.json().disposition, null);
    assert.equal(pool.dispositions.has(`${reviewId}:0`), false);
    const audits = pool.calls.filter((call) => ["visual-finding.disposition-set", "visual-finding.disposition-cleared"].includes(call.params[2]));
    assert.equal(audits.length, 3, "same-state retries do not add duplicate audit events");
  } finally { await app.close(); }

  const viewer = buildApp({ pool: reviewPool({ role: "viewer" }), appOrigin: origin, groqApiKey: "test-only" });
  try {
    const denied = await viewer.inject({ method: "PUT", url: `/v1/projects/${projectId}/visual-reviews/${runId}/findings/0/disposition`, headers: { origin, "content-type": "application/json", cookie, "x-atlas-organization": orgId }, payload: { disposition: "confirmed" } });
    assert.equal(denied.statusCode, 403);
  } finally { await viewer.close(); }
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

test("reference review adds deterministic pixel evidence without granting it release effect", async () => {
  const pool = reviewPool();
  const altered = decodePng(png);
  altered.data = Buffer.from(altered.data);
  altered.data[0] = 230;
  const current = encodePng(altered);
  const app = buildApp({ pool, appOrigin: origin, groqApiKey: "test-only", visualReviewer: async () => ({
    provider: "groq", requestedModel: "qwen/test", returnedModel: "qwen/test",
    issues: [], verdictEffect: "none",
  }) });
  try {
    const response = await request(app, {
      providerConsent: true,
      imageBase64: current.toString("base64"),
      referenceImageBase64: png.toString("base64"),
      criteria: "Keep the component structure stable.",
    });
    assert.equal(response.statusCode, 201, response.body);
    const comparison = response.json().review.result.pixelComparison;
    assert.equal(comparison.pixelDiffRatio, 0.25);
    assert.ok(comparison.perceptualScore < 1);
    assert.deepEqual(comparison.width, 2);
    assert.equal(comparison.height, 2);
    assert.equal(comparison.channelTolerance, 6);
    assert.deepEqual(comparison.verdictEffect, "none");
    assert.match(comparison.basis, /deterministic RGBA/);
  } finally { await app.close(); }
});

test("captured screenshot provenance must be a same-project PNG with matching bytes and is recorded", async () => {
  const source = { runId, artifactId };
  const imageSha256 = createHash("sha256").update(png).digest("hex");
  const pool = reviewPool({ sourceArtifact: { sha256: imageSha256, artifactName: "component-ready.png" } });
  let providerCalls = 0;
  const app = buildApp({ pool, appOrigin: origin, groqApiKey: "test-only", visualReviewer: async () => {
    providerCalls += 1;
    return { provider: "groq", requestedModel: "qwen/test", returnedModel: "qwen/test", issues: [], verdictEffect: "none" };
  } });
  try {
    const response = await request(app, { providerConsent: true, imageBase64: png.toString("base64"), sourceArtifact: source });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual({
      runId: response.json().review.sourceRunId,
      artifactId: response.json().review.sourceArtifactId,
      name: response.json().review.sourceArtifactName,
    }, { runId, artifactId, name: "component-ready.png" });
    const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO visual_reviews"));
    assert.deepEqual(insert.params.slice(13, 16), [runId, artifactId, "component-ready.png"]);
    assert.equal(providerCalls, 1);
  } finally { await app.close(); }

  const mismatchPool = reviewPool({ sourceArtifact: { sha256: "f".repeat(64), artifactName: "component-ready.png" } });
  let mismatchProviderCalls = 0;
  const mismatchApp = buildApp({ pool: mismatchPool, appOrigin: origin, groqApiKey: "test-only", visualReviewer: async () => { mismatchProviderCalls += 1; } });
  try {
    const mismatch = await request(mismatchApp, { providerConsent: true, imageBase64: png.toString("base64"), sourceArtifact: source });
    assert.equal(mismatch.statusCode, 409);
    assert.equal(mismatchProviderCalls, 0);
  } finally { await mismatchApp.close(); }

  const missingApp = buildApp({ pool: reviewPool(), appOrigin: origin, groqApiKey: "test-only", visualReviewer: async () => { throw new Error("must not call"); } });
  try {
    const missing = await request(missingApp, { providerConsent: true, imageBase64: png.toString("base64"), sourceArtifact: source });
    assert.equal(missing.statusCode, 404);
  } finally { await missingApp.close(); }

  const otherProjectId = "523e4567-e89b-42d3-a456-426614174000";
  const crossProjectApp = buildApp({ pool: reviewPool({ sourceArtifact: { sha256: imageSha256, artifactName: "component-ready.png" } }), appOrigin: origin, groqApiKey: "test-only", visualReviewer: async () => { throw new Error("must not call"); } });
  try {
    const crossProject = await request(crossProjectApp, { providerConsent: true, imageBase64: png.toString("base64"), sourceArtifact: source }, { project: otherProjectId });
    assert.equal(crossProject.statusCode, 404);
  } finally { await crossProjectApp.close(); }
});

test("run-to-run visual comparison verifies matching provenance and stores both artifact identities", async () => {
  const altered = decodePng(png);
  altered.data = Buffer.from(altered.data);
  altered.data[0] = 230;
  const current = encodePng(altered);
  const targetId = "723e4567-e89b-42d3-a456-426614174000";
  const relativePath = "matrix/runs/high-wifi/screenshots/component-ready.png";
  const pool = reviewPool({
    sourceArtifact: { sha256: createHash("sha256").update(current).digest("hex"), artifactName: "component-ready.png", relativePath, targetId, contractVersion: 2 },
    referenceArtifact: { sha256: createHash("sha256").update(png).digest("hex"), artifactName: "component-ready.png", relativePath, targetId, contractVersion: 2 },
  });
  let providerOptions;
  const app = buildApp({ pool, appOrigin: origin, groqApiKey: "test-only", visualReviewer: async (options) => {
    providerOptions = options;
    return { provider: "groq", requestedModel: "qwen/test", returnedModel: "qwen/test", issues: [], verdictEffect: "none" };
  } });
  try {
    const response = await request(app, {
      providerConsent: true,
      imageBase64: current.toString("base64"),
      sourceArtifact: { runId, artifactId },
      referenceImageBase64: png.toString("base64"),
      referenceSourceArtifact: { runId: referenceRunId, artifactId: referenceArtifactId },
      criteria: "Keep the component structure stable.",
    });
    assert.equal(response.statusCode, 201, response.body);
    const review = response.json().review;
    assert.equal(review.sourceRunId, runId);
    assert.equal(review.referenceRunId, referenceRunId);
    assert.equal(review.referenceArtifactId, referenceArtifactId);
    assert.equal(review.referenceArtifactName, "component-ready.png");
    assert.equal(review.result.pixelComparison.pixelDiffRatio, 0.25);
    assert.deepEqual(providerOptions.referenceImage, png);
    const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO visual_reviews"));
    assert.deepEqual(insert.params.slice(16, 19), [referenceRunId, referenceArtifactId, "component-ready.png"]);
  } finally { await app.close(); }

  const mismatch = reviewPool({
    sourceArtifact: { sha256: createHash("sha256").update(current).digest("hex"), artifactName: "component-ready.png", relativePath, targetId, contractVersion: 2 },
    referenceArtifact: { sha256: createHash("sha256").update(png).digest("hex"), artifactName: "component-ready.png", relativePath: "matrix/runs/low-cpu-3g/screenshots/component-ready.png", targetId, contractVersion: 2 },
  });
  let providerCalls = 0;
  const mismatchApp = buildApp({ pool: mismatch, appOrigin: origin, groqApiKey: "test-only", visualReviewer: async () => { providerCalls += 1; } });
  try {
    const response = await request(mismatchApp, {
      providerConsent: true, imageBase64: current.toString("base64"), sourceArtifact: { runId, artifactId },
      referenceImageBase64: png.toString("base64"), referenceSourceArtifact: { runId: referenceRunId, artifactId: referenceArtifactId },
      criteria: "Keep the component structure stable.",
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /same target, contract version, profile/);
    assert.equal(providerCalls, 0);
  } finally { await mismatchApp.close(); }
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
