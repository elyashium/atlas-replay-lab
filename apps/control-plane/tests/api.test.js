import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.js";

const ORIGIN = "http://127.0.0.1:3000";
const tokenCookie = "atlas_session=0123456789abcdef0123456789abcdef0123456789abcdef";

function fakePool({ member = true, projects = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT u.id,u.email FROM sessions")) return { rows: [{ id: "user-1", email: "qa@example.org" }], rowCount: 1 };
      if (sql.includes("SELECT role FROM memberships")) return member ? { rows: [{ role: "owner" }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (sql === "SELECT 1") return { rows: [{ "?column?": 1 }], rowCount: 1 };
      if (sql.includes("FROM projects WHERE organization_id=$1 ORDER BY")) return { rows: projects, rowCount: projects.length };
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; }, release() {} };
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
