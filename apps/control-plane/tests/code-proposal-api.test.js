import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildApp } from "../src/server.js";

const origin = "http://127.0.0.1:3000";
const orgId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "223e4567-e89b-42d3-a456-426614174000";
const reviewId = "323e4567-e89b-42d3-a456-426614174000";
const cookie = "atlas_session=0123456789abcdef0123456789abcdef0123456789abcdef";
const finding = { category: "hierarchy", kind: "subjective", severity: "minor", confidence: "medium", observation: "The primary action is hard to distinguish.", recommendation: "Increase its visual emphasis.", region: null };
const source = "export function Button(){ return <button className=\"blue\">Buy</button>; }\n// unrelated internal note that should not be retained\n";
const diff = [
  "diff --git a/Button.jsx b/Button.jsx", "index aaa..bbb 100644", "--- a/Button.jsx", "+++ b/Button.jsx", "@@ -1 +1 @@",
  "-export function Button(){ return <button className=\"blue\">Buy</button>; }",
  "+export function Button(){ return <button className=\"teal\">Buy</button>; }",
].join("\n");

function proposalPool({ role = "owner", limit = 5, reviewIssues = [finding] } = {}) {
  const proposals = new Map();
  const calls = [];
  let used = 0;
  return {
    proposals, calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT u.id,u.email FROM sessions")) return { rows: [{ id: "user-1", email: "dev@example.org" }], rowCount: 1 };
      if (sql.includes("SELECT role FROM memberships")) return { rows: [{ role }], rowCount: 1 };
      if (sql.includes("SELECT id,status,result FROM visual_reviews")) return { rows: [{ id: reviewId, status: "complete", result: { issues: reviewIssues } }], rowCount: 1 };
      if (sql.includes("SELECT id,project_id AS \"projectId\",visual_review_id AS \"visualReviewId\",request_sha256 AS \"requestSha256\"")) {
        const row = proposals.get(params[1]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes("INSERT INTO code_proposal_usage")) {
        if (used >= limit) return { rows: [], rowCount: 0 };
        used += 1;
        return { rows: [{ request_count: used }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return { query: async (sql, params = []) => {
        calls.push({ sql, params });
        if (sql.includes("INSERT INTO code_proposals")) {
          const row = {
            id: params[0], projectId: params[2], visualReviewId: params[3], status: params[4],
            requestedModel: params[5], returnedModel: params[6], fileName: params[7], sourceSha256: params[8], requestSha256: params[9],
            result: params[11], error: params[12], createdAt: "2026-09-29T00:00:00.000Z",
          };
          proposals.set(params[10], row);
          return { rows: [row], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }, release() {} };
    },
    async end() {},
  };
}

function send(app, body, { key = "proposal-key-001", id = reviewId } = {}) {
  return app.inject({
    method: "POST", url: `/v1/projects/${projectId}/visual-reviews/${id}/code-proposals`,
    headers: { origin, "content-type": "application/json", cookie, "x-atlas-organization": orgId, "idempotency-key": key },
    payload: body,
  });
}

test("code proposal requires separate source consent and refuses credential-like source before provider egress", async () => {
  let providerCalls = 0;
  const app = buildApp({ pool: proposalPool(), appOrigin: origin, groqApiKey: "test-only", codeProposer: async () => { providerCalls += 1; } });
  try {
    const noConsent = await send(app, { fileName: "Button.jsx", source });
    assert.equal(noConsent.statusCode, 400);
    const secret = await send(app, { sourceConsent: true, fileName: "Button.js", source: "const key='gsk_123456789012345678901234';" });
    assert.equal(secret.statusCode, 400);
    const path = await send(app, { sourceConsent: true, fileName: "../Button.jsx", source });
    assert.equal(path.statusCode, 400);
    const oversized = await send(app, { sourceConsent: true, fileName: "Button.jsx", source: "x".repeat(64 * 1024 + 1) });
    assert.equal(oversized.statusCode, 400);
    assert.equal(providerCalls, 0);
  } finally { await app.close(); }
});

test("code proposal stores only source hash, one-file diff and consent audit, and repeated request is idempotent", async () => {
  const pool = proposalPool();
  let providerCalls = 0;
  let providerOptions;
  const app = buildApp({ pool, appOrigin: origin, groqApiKey: "test-only", codeProposer: async (options) => {
    providerCalls += 1; providerOptions = options;
    return { provider: "groq", requestedModel: "openai/test", returnedModel: "openai/test", fileName: "Button.jsx", sourceSha256: createHash("sha256").update(options.source).digest("hex"), summary: "Apply the referenced accent to the primary button.", unifiedDiff: diff, status: "proposal", applied: false, testsRun: false, verdictEffect: "none" };
  } });
  const body = { sourceConsent: true, fileName: "Button.jsx", source, task: "Only change the button accent." };
  try {
    const created = await send(app, body);
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().proposal.status, "proposal");
    assert.equal(created.json().proposal.result.applied, false);
    assert.equal(created.json().proposal.result.testsRun, false);
    assert.equal(providerOptions.consentToSendCode, true);
    assert.equal(providerOptions.findings.includes(finding.observation), true);
    assert.equal(providerOptions.apiKey, "test-only");
    const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO code_proposals"));
    assert.ok(insert);
    assert.equal(JSON.stringify(insert.params).includes("unrelated internal note"), false);
    assert.equal(pool.proposals.get("proposal-key-001").projectId, projectId);
    assert.equal(pool.proposals.get("proposal-key-001").visualReviewId, reviewId);
    const retry = await send(app, body);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().proposal.id, created.json().proposal.id);
    assert.equal(providerCalls, 1);
    const changed = await send(app, { ...body, task: "Do something else." });
    assert.equal(changed.statusCode, 409);
    assert.equal(providerCalls, 1);
  } finally { await app.close(); }
});

test("a failed code-provider result stays inconclusive and a review without findings cannot request a patch", async () => {
  const app = buildApp({ pool: proposalPool(), appOrigin: origin, groqApiKey: "test-only", codeProposer: async () => { throw new Error("provider payload with sensitive details"); } });
  try {
    const response = await send(app, { sourceConsent: true, fileName: "Button.jsx", source });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().proposal.status, "inconclusive");
    assert.equal(response.json().proposal.result.unifiedDiff, "");
    assert.equal(response.json().proposal.error, "Groq code proposal returned an invalid or unsupported response");
    const noFindingsApp = buildApp({ pool: proposalPool({ reviewIssues: [] }), appOrigin: origin, groqApiKey: "test-only", codeProposer: async () => { throw new Error("must not call"); } });
    const noFindings = await send(noFindingsApp, { sourceConsent: true, fileName: "Button.jsx", source }, { key: "empty-findings-001" });
    assert.equal(noFindings.statusCode, 409);
    await noFindingsApp.close();
  } finally { await app.close(); }
});

test("code proposal access checks roles and enforces a configurable daily organization limit", async () => {
  let calls = 0;
  const viewer = buildApp({ pool: proposalPool({ role: "viewer" }), appOrigin: origin, groqApiKey: "test-only", codeProposer: async () => { calls += 1; } });
  try { assert.equal((await send(viewer, { sourceConsent: true, fileName: "Button.jsx", source })).statusCode, 403); }
  finally { await viewer.close(); }
  const pool = proposalPool({ limit: 2 });
  const app = buildApp({ pool, appOrigin: origin, groqApiKey: "test-only", codeProposalDailyLimit: 2, codeProposer: async ({ source: code }) => {
    calls += 1;
    return { provider: "groq", requestedModel: "openai/test", returnedModel: "openai/test", fileName: "Button.jsx", sourceSha256: createHash("sha256").update(code).digest("hex"), summary: "No safe edit can be supported.", unifiedDiff: "", status: "no-change", applied: false, testsRun: false, verdictEffect: "none" };
  } });
  try {
    assert.equal((await send(app, { sourceConsent: true, fileName: "Button.jsx", source }, { key: "quota-proposal-01" })).statusCode, 201);
    assert.equal((await send(app, { sourceConsent: true, fileName: "Button.jsx", source }, { key: "quota-proposal-02" })).statusCode, 201);
    assert.equal((await send(app, { sourceConsent: true, fileName: "Button.jsx", source }, { key: "quota-proposal-03" })).statusCode, 429);
    assert.equal(calls, 2);
  } finally { await app.close(); }
});
