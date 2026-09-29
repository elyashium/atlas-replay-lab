import test from "node:test";
import assert from "node:assert/strict";
import { createSupabaseAuth } from "../src/supabase-auth.js";
import { buildApp } from "../src/server.js";

const origin = "http://127.0.0.1:3000";
const authUserId = "523e4567-e89b-42d3-a456-426614174000";

test("Supabase auth verifier requires a paired secure URL and publishable key", () => {
  assert.equal(createSupabaseAuth({}), null);
  assert.throws(() => createSupabaseAuth({ url: "https://demo.supabase.co" }), /configured together/);
  assert.throws(() => createSupabaseAuth({ url: "http://demo.supabase.co", anonKey: "public" }), /HTTPS/);
  assert.doesNotThrow(() => createSupabaseAuth({ url: "http://127.0.0.1:54321", anonKey: "public" }));
});

test("Supabase access tokens are verified remotely and unconfirmed identities fail closed", async () => {
  const calls = [];
  const auth = createSupabaseAuth({
    url: "https://demo.supabase.co", anonKey: "publishable-test-key",
    client: { auth: { getUser: async (token) => {
      calls.push(token);
      return token === "confirmed-token-long-enough"
        ? { data: { user: { id: authUserId, email: "qa@example.org", email_confirmed_at: "2026-01-01T00:00:00Z" } }, error: null }
        : { data: { user: { id: authUserId, email: "qa@example.org", email_confirmed_at: null } }, error: null };
    } } },
  });
  assert.deepEqual(await auth.getUser("confirmed-token-long-enough"), { id: authUserId, email: "qa@example.org" });
  assert.equal(await auth.getUser("unconfirmed-token-long-enough"), null);
  assert.equal(await auth.getUser("short"), null);
  assert.deepEqual(calls, ["confirmed-token-long-enough", "unconfirmed-token-long-enough"]);
});

test("Supabase mode exposes only public client config and rejects local-cookie auth", async () => {
  const auth = {
    provider: "supabase",
    clientConfig: { url: "https://demo.supabase.co", anonKey: "publishable-test-key" },
    getUser: async (token) => token === "confirmed-token-long-enough" ? { id: authUserId, email: "qa@example.org" } : null,
  };
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("FROM auth_identities")) return { rows: [{ id: "user-1", email: "qa@example.org" }], rowCount: 1 };
      if (sql.includes("FROM memberships")) return { rows: [{ role: "owner" }], rowCount: 1 };
      if (sql.includes("FROM projects WHERE organization_id=$1 ORDER BY")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
  const app = buildApp({ pool, appOrigin: origin, supabaseAuth: auth });
  try {
    const config = await app.inject({ method: "GET", url: "/v1/auth/config" });
    assert.deepEqual(config.json(), { provider: "supabase", ...auth.clientConfig });
    assert.match(config.headers["content-security-policy"], /connect-src 'self' https:\/\/demo\.supabase\.co/);
    const blockedLocal = await app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin, "content-type": "application/json" }, payload: { email: "qa@example.org", password: "not-used" } });
    assert.equal(blockedLocal.statusCode, 409);
    const cookieOnly = await app.inject({ method: "GET", url: "/v1/projects", headers: { cookie: "atlas_session=0123456789abcdef0123456789abcdef0123456789abcdef", "x-atlas-organization": "123e4567-e89b-42d3-a456-426614174000" } });
    assert.equal(cookieOnly.statusCode, 401);
    const authenticated = await app.inject({ method: "GET", url: "/v1/projects", headers: { authorization: "Bearer confirmed-token-long-enough", "x-atlas-organization": "123e4567-e89b-42d3-a456-426614174000" } });
    assert.equal(authenticated.statusCode, 200, authenticated.body);
    assert.equal(queries.some((query) => JSON.stringify(query.params).includes("confirmed-token-long-enough")), false);
  } finally { await app.close(); }
});
