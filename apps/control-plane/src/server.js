import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookup, resolveTxt } from "node:dns/promises";
import { validateTargetContract } from "../../../src/targets/contract.js";
import { createPool, inTransaction } from "./db.js";
import { clearSessionCookie, hashPassword, hashToken, newId, newSecret, parseCookies, parseOwnedTargetUrl, sessionCookie, verifyPassword, isPublicAddress } from "./security.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildApp({
  pool = createPool(),
  appOrigin = process.env.ATLAS_APP_ORIGIN ?? "http://127.0.0.1:3000",
  secureCookies = process.env.NODE_ENV === "production",
  logger = false,
  dns = { lookup, resolveTxt },
} = {}) {
  const app = Fastify({ logger, bodyLimit: 256 * 1024, trustProxy: false });

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  });

  app.addHook("onRequest", async (request, reply) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      if (request.headers.origin !== appOrigin) return reply.code(403).send({ error: "same-origin request required" });
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return reply.code(415).send({ error: "application/json required" });
      }
    }
  });

  app.get("/healthz", async (_request, reply) => {
    try { await pool.query("SELECT 1"); return { status: "ok", service: "atlas-control-plane" }; }
    catch { return reply.code(503).send({ status: "unavailable" }); }
  });

  app.get("/api/openapi.json", async () => OPENAPI);
  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(await readFile(path.join(here, "../public/index.html"), "utf8")));
  app.get("/app.js", async (_request, reply) => reply.type("text/javascript; charset=utf-8").send(await readFile(path.join(here, "../public/app.js"), "utf8")));
  app.get("/app.css", async (_request, reply) => reply.type("text/css; charset=utf-8").send(await readFile(path.join(here, "../public/app.css"), "utf8")));

  app.post("/v1/auth/register", async (request, reply) => {
    const body = asObject(request.body);
    const email = normalizeEmail(body.email);
    const password = body.password;
    const orgName = cleanName(body.organizationName);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.code(400).send({ error: "valid email required" });
    if (typeof password !== "string" || password.length < 12 || password.length > 256) return reply.code(400).send({ error: "password must be 12 to 256 characters" });
    if (!orgName) return reply.code(400).send({ error: "organizationName is required" });
    const credentials = await hashPassword(password);
    const userId = newId();
    const orgId = newId();
    const token = newSecret();
    try {
      await inTransaction(pool, async (client) => {
        await client.query("INSERT INTO users(id,email,password_salt,password_hash) VALUES($1,$2,$3,$4)", [userId, email, credentials.salt, credentials.hash]);
        await client.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [orgId, orgName]);
        await client.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [orgId, userId]);
        await client.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')", [hashToken(token), userId]);
        await client.query("INSERT INTO audit_events(organization_id,actor_user_id,action,resource_type,resource_id) VALUES($1,$2,'organization.created','organization',$1)", [orgId, userId]);
      });
    } catch (error) {
      if (error?.code === "23505") return reply.code(409).send({ error: "an account with that email already exists" });
      throw error;
    }
    reply.header("set-cookie", sessionCookie(token, { secure: secureCookies, maxAgeSeconds: SESSION_TTL_SECONDS }));
    return reply.code(201).send({ user: { id: userId, email }, organization: { id: orgId, name: orgName, role: "owner" } });
  });

  app.post("/v1/auth/login", async (request, reply) => {
    const body = asObject(request.body);
    const email = normalizeEmail(body.email);
    if (!email || typeof body.password !== "string" || body.password.length > 256) return reply.code(400).send({ error: "email and password are required" });
    const found = await pool.query("SELECT id,email,password_salt,password_hash FROM users WHERE email=$1", [email]);
    const row = found.rows[0];
    const salt = row?.password_salt ?? randomBytes(16);
    const hash = row?.password_hash ?? randomBytes(64);
    const valid = await verifyPassword(body.password, salt, hash);
    if (!row || !valid) return reply.code(401).send({ error: "invalid email or password" });
    const token = newSecret();
    await pool.query("DELETE FROM sessions WHERE expires_at <= now()");
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')", [hashToken(token), row.id]);
    reply.header("set-cookie", sessionCookie(token, { secure: secureCookies, maxAgeSeconds: SESSION_TTL_SECONDS }));
    const orgs = await pool.query("SELECT o.id,o.name,m.role FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 ORDER BY o.created_at", [row.id]);
    return { user: { id: row.id, email: row.email }, organizations: orgs.rows };
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const token = parseCookies(request.headers.cookie).get("atlas_session");
    if (token) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [hashToken(token)]);
    reply.header("set-cookie", clearSessionCookie({ secure: secureCookies }));
    return reply.code(204).send();
  });

  app.get("/v1/me", async (request, reply) => {
    const user = await sessionUser(request, pool);
    if (!user) return reply.code(401).send({ error: "authentication required" });
    const orgs = await pool.query("SELECT o.id,o.name,m.role FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 ORDER BY o.created_at", [user.id]);
    return { user, organizations: orgs.rows };
  });

  app.get("/v1/projects", async (request, reply) => {
    const { user, orgId, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    const result = await pool.query("SELECT id,name,created_at AS \"createdAt\" FROM projects WHERE organization_id=$1 ORDER BY created_at DESC", [orgId]);
    return { projects: result.rows };
  });

  app.post("/v1/projects", async (request, reply) => {
    const { user, orgId, role, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    if (!canWrite(role)) return reply.code(403).send({ error: "organization editor role required" });
    const name = cleanName(asObject(request.body).name);
    if (!name) return reply.code(400).send({ error: "project name is required" });
    const id = newId();
    await inTransaction(pool, async (client) => {
      await client.query("INSERT INTO projects(id,organization_id,name,created_by) VALUES($1,$2,$3,$4)", [id, orgId, name, user.id]);
      await audit(client, orgId, user.id, "project.created", "project", id);
    });
    return reply.code(201).send({ project: { id, name } });
  });

  app.get("/v1/projects/:projectId", async (request, reply) => {
    const { orgId, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    const { projectId } = request.params;
    const result = await pool.query("SELECT id,name,created_at AS \"createdAt\" FROM projects WHERE organization_id=$1 AND id=$2", [orgId, projectId]);
    if (!result.rowCount) return reply.code(404).send({ error: "project not found" });
    const targets = await pool.query("SELECT id,base_url AS \"baseUrl\",verified_at IS NOT NULL AS verified,contract->>'name' AS name,created_at AS \"createdAt\" FROM targets WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at DESC", [orgId, projectId]);
    const runs = await pool.query("SELECT id,target_id AS \"targetId\",status,verdict,contract_version AS \"contractVersion\",created_at AS \"createdAt\",finished_at AS \"finishedAt\" FROM runs WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 50", [orgId, projectId]);
    return { project: result.rows[0], targets: targets.rows, runs: runs.rows };
  });

  app.post("/v1/projects/:projectId/targets", async (request, reply) => {
    const { user, orgId, role, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    if (!canWrite(role)) return reply.code(403).send({ error: "organization editor role required" });
    const { projectId } = request.params;
    const body = asObject(request.body);
    const validation = validateTargetContract(body.contract);
    if (!validation.ok) return reply.code(400).send({ error: "invalid target contract", issues: validation.issues });
    let parsed;
    try { parsed = parseOwnedTargetUrl(validation.contract.target.url); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
    const allowed = validation.contract.target.allowedOrigins;
    if (allowed.some((origin) => new URL(origin).protocol !== "https:")) return reply.code(400).send({ error: "hosted allowedOrigins must all use HTTPS" });
    try {
      const addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
      if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) return reply.code(400).send({ error: "target DNS must resolve only to public addresses" });
    } catch (e) {
      if (e?.statusCode) throw e;
      return reply.code(400).send({ error: "target hostname could not be resolved safely" });
    }
    const exists = await pool.query("SELECT 1 FROM projects WHERE organization_id=$1 AND id=$2", [orgId, projectId]);
    if (!exists.rowCount) return reply.code(404).send({ error: "project not found" });
    const id = newId();
    const verificationToken = `atlas-verify=${newSecret(24)}`;
    const contract = { ...validation.contract, target: { ...validation.contract.target, url: parsed.url.href } };
    await inTransaction(pool, async (client) => {
      await client.query("INSERT INTO targets(id,organization_id,project_id,base_url,hostname,verification_token,contract,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, orgId, projectId, parsed.url.href, parsed.hostname, verificationToken, contract, user.id]);
      await audit(client, orgId, user.id, "target.created", "target", id, { hostname: parsed.hostname });
    });
    return reply.code(201).send({ target: { id, baseUrl: parsed.url.href, verified: false }, dnsVerification: { recordName: `_atlas-verify.${parsed.hostname}`, recordType: "TXT", value: verificationToken } });
  });

  app.post("/v1/targets/:targetId/verify", async (request, reply) => {
    const { user, orgId, role, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    if (!canWrite(role)) return reply.code(403).send({ error: "organization editor role required" });
    const { targetId } = request.params;
    const found = await pool.query("SELECT hostname,verification_token,verified_at FROM targets WHERE organization_id=$1 AND id=$2", [orgId, targetId]);
    const target = found.rows[0];
    if (!target) return reply.code(404).send({ error: "target not found" });
    if (!target.verified_at) {
      try {
        const records = await dns.resolveTxt(`_atlas-verify.${target.hostname}`);
        const verified = records.some((parts) => parts.join("") === target.verification_token);
        if (!verified) return reply.code(409).send({ error: "DNS verification record was not found" });
      } catch { return reply.code(409).send({ error: "DNS verification record could not be read" }); }
      await inTransaction(pool, async (client) => {
        await client.query("UPDATE targets SET verified_at=now() WHERE organization_id=$1 AND id=$2", [orgId, targetId]);
        await audit(client, orgId, user.id, "target.verified", "target", targetId);
      });
    }
    return { targetId, verified: true };
  });

  app.post("/v1/targets/:targetId/runs", async (request, reply) => {
    const { user, orgId, role, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    if (!canWrite(role)) return reply.code(403).send({ error: "organization editor role required" });
    const { targetId } = request.params;
    const found = await pool.query("SELECT project_id,contract,verified_at FROM targets WHERE organization_id=$1 AND id=$2", [orgId, targetId]);
    const target = found.rows[0];
    if (!target) return reply.code(404).send({ error: "target not found" });
    if (!target.verified_at) return reply.code(409).send({ error: "verify target ownership before queueing a run" });
    const id = newId();
    await inTransaction(pool, async (client) => {
      await client.query("INSERT INTO runs(id,organization_id,project_id,target_id,status,contract_version,contract_snapshot,requested_by,retention_expires_at) VALUES($1,$2,$3,$4,'queued',$5,$6,$7,now()+interval '30 days')", [id, orgId, target.project_id, targetId, String(target.contract.schemaVersion), target.contract, user.id]);
      await audit(client, orgId, user.id, "run.queued", "run", id, { targetId });
    });
    return reply.code(202).send({ run: { id, status: "queued", verdict: null, message: "Run accepted. Browser execution is not enabled in this deployment." } });
  });

  app.get("/v1/runs/:runId", async (request, reply) => {
    const { orgId, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    const { runId } = request.params;
    const found = await pool.query("SELECT id,status,verdict,contract_version AS \"contractVersion\",created_at AS \"createdAt\",started_at AS \"startedAt\",finished_at AS \"finishedAt\",contract_snapshot AS contract FROM runs WHERE organization_id=$1 AND id=$2", [orgId, runId]);
    if (!found.rowCount) return reply.code(404).send({ error: "run not found" });
    const artifacts = await pool.query("SELECT id,media_type AS \"mediaType\",byte_length AS \"byteLength\",sha256,created_at AS \"createdAt\" FROM artifacts WHERE organization_id=$1 AND run_id=$2 ORDER BY created_at", [orgId, runId]);
    return { run: found.rows[0], artifacts: artifacts.rows, evidenceStatus: "not-run" };
  });

  app.addHook("onClose", async () => { await pool.end(); });
  return app;
}

async function sessionUser(request, pool) {
  const token = parseCookies(request.headers.cookie).get("atlas_session");
  if (!token || token.length < 32) return null;
  const result = await pool.query("SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()", [hashToken(token)]);
  return result.rows[0] ?? null;
}

async function organizationContext(request, pool) {
  const user = await sessionUser(request, pool);
  if (!user) return { error: { status: 401, message: "authentication required" } };
  const orgId = request.headers["x-atlas-organization"];
  if (typeof orgId !== "string" || !UUID.test(orgId)) return { error: { status: 400, message: "x-atlas-organization header is required" } };
  const member = await pool.query("SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2", [orgId, user.id]);
  if (!member.rowCount) return { error: { status: 404, message: "organization not found" } };
  return { user, orgId, role: member.rows[0].role };
}

function canWrite(role) { return ["owner", "admin", "member"].includes(role); }
function asObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function normalizeEmail(value) { return typeof value === "string" && value.length <= 254 ? value.trim().toLowerCase() : ""; }
function cleanName(value) { return typeof value === "string" && value.trim().length <= 120 ? value.trim() : ""; }
async function audit(client, orgId, userId, action, type, id, details = {}) {
  await client.query("INSERT INTO audit_events(organization_id,actor_user_id,action,resource_type,resource_id,details) VALUES($1,$2,$3,$4,$5,$6)", [orgId, userId, action, type, id, details]);
}

const OPENAPI = {
  openapi: "3.1.0", info: { title: "Atlas Control Plane API", version: "0.1.0", description: "Phase 2 local development slice. Queue records are not browser executions." },
  servers: [{ url: "http://localhost:3000" }],
  paths: {
    "/v1/auth/register": { post: { summary: "Create account and organization", responses: { "201": { description: "Created" } } } },
    "/v1/auth/login": { post: { summary: "Create a session", responses: { "200": { description: "Authenticated" } } } },
    "/v1/projects": { get: { summary: "List projects in selected organization", responses: { "200": { description: "Project list" } } }, post: { summary: "Create project", responses: { "201": { description: "Created" } } } },
    "/v1/projects/{projectId}/targets": { post: { summary: "Register an HTTPS target and DNS ownership challenge", responses: { "201": { description: "Created" } } } },
    "/v1/targets/{targetId}/verify": { post: { summary: "Verify DNS TXT ownership", responses: { "200": { description: "Verified" } } } },
    "/v1/targets/{targetId}/runs": { post: { summary: "Queue a run record", responses: { "202": { description: "Queued; execution disabled" } } } },
    "/v1/runs/{runId}": { get: { summary: "Get private run status and artifact metadata", responses: { "200": { description: "Run detail" } } } },
  },
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const secureCookies = process.env.NODE_ENV === "production";
  if (secureCookies && !process.env.ATLAS_APP_ORIGIN?.startsWith("https://")) throw new Error("production requires ATLAS_APP_ORIGIN with https://");
  const app = buildApp({ secureCookies, logger: true });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
}
