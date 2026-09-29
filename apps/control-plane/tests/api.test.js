import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.js";

const ORIGIN = "http://127.0.0.1:3000";
const tokenCookie = "atlas_session=0123456789abcdef0123456789abcdef0123456789abcdef";

function fakePool({ member = true, projects = [], projectTargets = [], verifiedTarget = false, targetContract = { schemaVersion: 1, id: "owned-target", name: "Owned target", environment: "staging", authorization: { authorized: true }, target: { url: "https://stage.example.org/", allowedOrigins: ["https://stage.example.org"], buildId: "a1b2c3d4" }, journey: { steps: [{ type: "waitForVisible", selector: "[data-ready]" }], success: { selector: "[data-ready]" }, fallback: { selector: "[data-fallback]", requiredOn: [] } }, profiles: ["high-wifi"], budgets: { journeyTimeoutMs: 5000, stepTimeoutMs: 2000 }, policy: { version: "1", criticalProfiles: ["high-wifi"], minimumScore: 50 }, mediaConsent: false, screenshots: { consent: false, redactSelectors: [] } } } = {}) {
  const calls = [];
  const runsByKey = new Map();
  return {
    calls,
    targetContract,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT u.id,u.email FROM sessions")) return { rows: [{ id: "user-1", email: "qa@example.org" }], rowCount: 1 };
      if (sql.includes("SELECT role FROM memberships")) return member ? { rows: [{ role: "owner" }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (sql.includes("SELECT project_id,contract,verified_at FROM targets")) return verifiedTarget ? { rows: [{ project_id: "project-1", contract: targetContract, verified_at: "2026-09-27T00:00:00Z" }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (sql.includes("FROM projects WHERE organization_id=$1 AND id=$2")) return { rows: [{ id: "project-1", name: "Studio staging" }], rowCount: 1 };
      if (sql.includes("FROM targets WHERE organization_id=$1 AND project_id=$2")) return { rows: projectTargets, rowCount: projectTargets.length };
      if (sql.includes("FROM runs WHERE organization_id=$1 AND project_id=$2")) return { rows: [], rowCount: 0 };
      if (sql === "SELECT 1") return { rows: [{ "?column?": 1 }], rowCount: 1 };
      if (sql.includes("FROM projects WHERE organization_id=$1 ORDER BY")) return { rows: projects, rowCount: projects.length };
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return { query: async (sql, params = []) => {
        calls.push({ sql, params });
        if (sql.includes("INSERT INTO runs")) {
          const key = params[8];
          if (runsByKey.has(key)) return { rows: [], rowCount: 0 };
          const run = { id: params[0], targetId: params[3], status: "queued", verdict: null, binding: params[6] };
          runsByKey.set(key, run);
          return { rows: [run], rowCount: 1 };
        }
        if (sql.includes("SELECT id,target_id AS \"targetId\",status,verdict,binding_snapshot AS binding FROM runs WHERE organization_id=$1 AND idempotency_key=$2")) {
          const run = runsByKey.get(params[1]);
          return { rows: run ? [run] : [], rowCount: run ? 1 : 0 };
        }
        return { rows: [], rowCount: 1 };
      }, release() {} };
    },
    async end() {},
  };
}

test("writes require same-origin JSON requests", async () => {
  const pool = fakePool();
  const app = buildApp({ pool, appOrigin: ORIGIN });
  try {
    const response = await app.inject({ method: "POST", url: "/v1/projects", payload: { name: "Studio" } });
    assert.equal(response.statusCode, 403);
    assert.equal(pool.calls.length, 0);
  } finally { await app.close(); }
});

test("project listing requires a session and organization membership", async () => {
  const pool = fakePool({ member: false });
  const app = buildApp({ pool, appOrigin: ORIGIN });
  try {
    const response = await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie: tokenCookie, "x-atlas-organization": "123e4567-e89b-42d3-a456-426614174000" } });
    assert.equal(response.statusCode, 404);
    assert.equal(pool.calls.some((call) => call.sql.includes("FROM projects")), false);
  } finally { await app.close(); }
});

test("tenant project list query is scoped to the selected organization", async () => {
  const pool = fakePool({ projects: [{ id: "p1", name: "Staging", createdAt: "2026-09-27T00:00:00Z" }] });
  const app = buildApp({ pool, appOrigin: ORIGIN });
  try {
    const response = await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie: tokenCookie, "x-atlas-organization": "123e4567-e89b-42d3-a456-426614174000" } });
    assert.equal(response.statusCode, 200);
    const listCall = pool.calls.find((call) => call.sql.includes("FROM projects WHERE organization_id=$1 ORDER BY"));
    assert.ok(listCall);
    assert.equal(listCall.params[0], "123e4567-e89b-42d3-a456-426614174000");
  } finally { await app.close(); }
});

test("project detail exposes an unverified DNS challenge but never a verified token", async () => {
  const projectTargets = [
    { id: "target-pending", baseUrl: "https://stage.example.org/", hostname: "stage.example.org", verified: false, verificationToken: "atlas-verify=public-proof-value", name: "Staging" },
    { id: "target-verified", baseUrl: "https://verified.example.org/", hostname: "verified.example.org", verified: true, verificationToken: null, name: "Verified" },
  ];
  const pool = fakePool({ projectTargets });
  const app = buildApp({ pool, appOrigin: ORIGIN });
  try {
    const response = await app.inject({ method: "GET", url: "/v1/projects/123e4567-e89b-42d3-a456-426614174000", headers: { cookie: tokenCookie, "x-atlas-organization": "123e4567-e89b-42d3-a456-426614174000" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().targets[0].verificationToken, "atlas-verify=public-proof-value");
    assert.equal(response.json().targets[1].verificationToken, null);
    const targetQuery = pool.calls.find((call) => call.sql.includes("FROM targets WHERE organization_id=$1 AND project_id=$2"));
    assert.match(targetQuery.sql, /CASE WHEN verified_at IS NULL THEN verification_token ELSE NULL END/);
  } finally { await app.close(); }
});

test("target onboarding refuses a hostname with any non-public DNS answer", async () => {
  const pool = fakePool();
  const app = buildApp({ pool, appOrigin: ORIGIN, dns: { lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }], resolveTxt: async () => [] } });
  try {
    const response = await app.inject({
      method: "POST", url: "/v1/projects/123e4567-e89b-42d3-a456-426614174000/targets",
      headers: { origin: ORIGIN, "content-type": "application/json", cookie: tokenCookie, "x-atlas-organization": "123e4567-e89b-42d3-a456-426614174000" },
      payload: { contract: pool.targetContract },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /public addresses/);
    assert.equal(pool.calls.some((call) => call.sql.includes("INSERT INTO targets")), false);
  } finally { await app.close(); }
});

test("health endpoint reports unavailable when Postgres is down", async () => {
  const pool = fakePool();
  pool.query = async (sql) => { if (sql === "SELECT 1") throw new Error("offline"); return { rows: [], rowCount: 0 }; };
  const app = buildApp({ pool, appOrigin: ORIGIN });
  try {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { status: "unavailable" });
  } finally { await app.close(); }
});

test("responses set privacy-oriented browser security headers", async () => {
  const app = buildApp({ pool: fakePool(), appOrigin: ORIGIN });
  try {
    const response = await app.inject({ method: "GET", url: "/" });
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(response.headers["permissions-policy"], "camera=(), microphone=(), geolocation=()");
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.match(response.headers["content-security-policy"], /img-src 'self' data: blob:/);
  } finally { await app.close(); }
});

test("run submissions require an idempotency key and retries resolve to the same queued row", async () => {
  const pool = fakePool({ verifiedTarget: true });
  const app = buildApp({ pool, appOrigin: ORIGIN });
  const url = "/v1/targets/123e4567-e89b-42d3-a456-426614174000/runs";
  const headers = { origin: ORIGIN, "content-type": "application/json", cookie: tokenCookie, "x-atlas-organization": "123e4567-e89b-42d3-a456-426614174000" };
  try {
    const missing = await app.inject({ method: "POST", url, headers, payload: {} });
    assert.equal(missing.statusCode, 400);
    const first = await app.inject({ method: "POST", url, headers: { ...headers, "idempotency-key": "release-commit-123" }, payload: {} });
    const retry = await app.inject({ method: "POST", url, headers: { ...headers, "idempotency-key": "release-commit-123" }, payload: {} });
    assert.equal(first.statusCode, 202);
    assert.equal(first.json().run.status, "queued");
    assert.equal(first.json().run.verdict, null);
    assert.equal(first.json().run.binding.build.immutable, true);
    assert.ok(first.json().run.binding.releasePolicy.contentHash);
    assert.equal(first.json().run.binding.atlas.engine, "RuleBasedDecisionEngine");
    assert.equal(first.json().run.binding.atlas.engineVersion, "0.1.0");
    assert.match(first.json().run.message, /not enabled/);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().run.id, first.json().run.id);
  } finally { await app.close(); }
});

test("run submission refuses a mutable target build before writing a queue row", async () => {
  const contract = { schemaVersion: 1, target: { buildId: "latest" } };
  const pool = fakePool({ verifiedTarget: true, targetContract: contract });
  const app = buildApp({ pool, appOrigin: ORIGIN });
  const headers = { origin: ORIGIN, "content-type": "application/json", cookie: tokenCookie, "x-atlas-organization": "123e4567-e89b-42d3-a456-426614174000", "idempotency-key": "release-build-latest" };
  try {
    const response = await app.inject({ method: "POST", url: "/v1/targets/123e4567-e89b-42d3-a456-426614174000/runs", headers, payload: {} });
    assert.equal(response.statusCode, 409);
    assert.match(response.json().issues.join(" "), /not immutable/);
    assert.equal(pool.calls.some((call) => call.sql.includes("INSERT INTO runs")), false);
  } finally { await app.close(); }
});

test("idempotency keys cannot alias different targets in the same organization", async () => {
  const pool = fakePool({ verifiedTarget: true });
  const app = buildApp({ pool, appOrigin: ORIGIN });
  const headers = { origin: ORIGIN, "content-type": "application/json", cookie: tokenCookie, "x-atlas-organization": "123e4567-e89b-42d3-a456-426614174000", "idempotency-key": "same-release-key" };
  try {
    const first = await app.inject({ method: "POST", url: "/v1/targets/123e4567-e89b-42d3-a456-426614174000/runs", headers, payload: {} });
    const reused = await app.inject({ method: "POST", url: "/v1/targets/223e4567-e89b-42d3-a456-426614174000/runs", headers, payload: {} });
    assert.equal(first.statusCode, 202);
    assert.equal(reused.statusCode, 409);
    assert.match(reused.json().error, /different target/);
  } finally { await app.close(); }
});
