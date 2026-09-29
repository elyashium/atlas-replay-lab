import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/server.js";
import { createPool } from "../src/db.js";

const databaseUrl = process.env.DATABASE_URL;
const origin = "http://127.0.0.1:3000";

test("a confirmed Supabase identity provisions one tenant and authorizes it without local cookies", { skip: !databaseUrl && "set DATABASE_URL and run migrations to enable Postgres integration" }, async () => {
  const pool = createPool(databaseUrl);
  const suffix = randomUUID();
  const externalId = randomUUID();
  const email = `supabase-${suffix}@example.org`;
  const organizationName = `Supabase Studio ${suffix.slice(0, 8)}`;
  let verificationCalls = 0;
  const supabaseAuth = {
    provider: "supabase",
    clientConfig: { url: "https://demo.supabase.co", anonKey: "publishable-test-key" },
    async getUser(token) {
      verificationCalls += 1;
      return token === "confirmed-integration-token" ? { id: externalId, email } : null;
    },
  };
  const app = buildApp({ pool, appOrigin: origin, supabaseAuth, closePool: false });
  const write = (path, { body = {}, token = "confirmed-integration-token", org = "" } = {}) => app.inject({
    method: "POST", url: path, payload: body,
    headers: { origin, "content-type": "application/json", authorization: `Bearer ${token}`, ...(org ? { "x-atlas-organization": org } : {}) },
  });
  try {
    const notProvisioned = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer confirmed-integration-token" } });
    assert.equal(notProvisioned.statusCode, 401);
    const needsName = await write("/v1/auth/provision");
    assert.equal(needsName.statusCode, 400, needsName.body);
    const provisioned = await write("/v1/auth/provision", { body: { organizationName } });
    assert.equal(provisioned.statusCode, 201, provisioned.body);
    const userId = provisioned.json().user.id;
    const organizationId = provisioned.json().organizations[0].id;
    assert.equal(provisioned.json().organizations[0].role, "owner");

    const currentUser = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer confirmed-integration-token" } });
    assert.equal(currentUser.statusCode, 200, currentUser.body);
    assert.equal(currentUser.json().user.id, userId);
    assert.equal(currentUser.json().organizations.length, 1);
    const projects = await app.inject({ method: "GET", url: "/v1/projects", headers: { authorization: "Bearer confirmed-integration-token", "x-atlas-organization": organizationId } });
    assert.equal(projects.statusCode, 200, projects.body);
    const repeated = await write("/v1/auth/provision", { body: { organizationName: "A second workspace must not appear" } });
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.json().organizations.length, 1);
    const localCookie = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: "atlas_session=0123456789abcdef0123456789abcdef0123456789abcdef" } });
    assert.equal(localCookie.statusCode, 401);
    assert.ok(verificationCalls >= 4);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM auth_identities WHERE provider='supabase' AND subject=$1 AND user_id=$2", [externalId, userId])).rows[0].count, 1);
  } finally {
    await pool.query("DELETE FROM organizations WHERE name=$1", [organizationName]);
    await pool.query("DELETE FROM users WHERE email=$1", [email]);
    await app.close();
    await pool.end();
  }
});
