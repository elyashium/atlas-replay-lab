import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/server.js";
import { createPool } from "../src/db.js";
import { purgeExpiredRecords } from "../src/maintenance.js";

  const databaseUrl = process.env.DATABASE_URL;
const origin = "http://127.0.0.1:3000";

test("Postgres onboarding is tenant-scoped, idempotent, fail-closed and expires metadata", { skip: !databaseUrl && "set DATABASE_URL and run migrations to enable Postgres integration" }, async () => {
  const pool = createPool(databaseUrl);
  const suffix = randomUUID();
  const emailA = `qa-a-${suffix}@example.org`;
  const emailB = `qa-b-${suffix}@example.org`;
  const organizationIds = [];
  let runId;
  let challenge = "";
  const dns = {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    resolveTxt: async () => challenge ? [[challenge]] : [],
  };
  const runningApp = buildApp({ pool, appOrigin: origin, secureCookies: false, dns, closePool: false });
  try {
    const write = (path, { body = {}, cookie = "", organizationId = "", headers = {} } = {}) => runningApp.inject({
      method: "POST", url: path, payload: body,
      headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(organizationId ? { "x-atlas-organization": organizationId } : {}), ...headers },
    });
    const accountA = await write("/v1/auth/register", { body: { email: emailA, password: "a sufficiently long local test password", organizationName: "QA Org A" } });
    assert.equal(accountA.statusCode, 201, accountA.body);
    const orgA = accountA.json().organization.id;
    organizationIds.push(orgA);
    const cookieA = accountA.headers["set-cookie"].split(";")[0];
    const project = await write("/v1/projects", { cookie: cookieA, organizationId: orgA, body: { name: "Staging scene" } });
    assert.equal(project.statusCode, 201, project.body);
    const projectId = project.json().project.id;

    const contract = {
      schemaVersion: 1,
      id: "postgres-target",
      name: "Owned staging target",
      environment: "staging",
      authorization: { authorized: true, note: "Authorized owned staging check" },
      target: { url: "https://studio-owned.example.org/", allowedOrigins: ["https://studio-owned.example.org"], buildId: "a1b2c3d4" },
      journey: { steps: [{ type: "waitForVisible", selector: "[data-ready]", timeoutMs: 2000 }], success: { selector: "[data-ready]" }, fallback: { selector: "[data-fallback]", requiredOn: ["webgl-unavailable"] } },
      profiles: ["high-wifi", "low-cpu-3g", "webgl-unavailable"],
      budgets: { journeyTimeoutMs: 5000, stepTimeoutMs: 2000 },
      mediaConsent: false,
      policy: { version: "1", criticalProfiles: ["high-wifi", "low-cpu-3g", "webgl-unavailable"], minimumScore: 50 },
      screenshots: { consent: false, redactSelectors: [] },
    };
    const targetResponse = await write(`/v1/projects/${projectId}/targets`, { cookie: cookieA, organizationId: orgA, body: { contract } });
    assert.equal(targetResponse.statusCode, 201, targetResponse.body);
    const target = targetResponse.json();
    challenge = target.dnsVerification.value;
    const targetId = target.target.id;
    const projectDetail = await runningApp.inject({ method: "GET", url: `/v1/projects/${projectId}`, headers: { cookie: cookieA, "x-atlas-organization": orgA } });
    assert.equal(projectDetail.statusCode, 200, projectDetail.body);
    assert.equal(projectDetail.json().targets[0].verificationToken, challenge);

    const runUrl = `/v1/targets/${targetId}/runs`;
    const notVerified = await write(runUrl, { cookie: cookieA, organizationId: orgA, headers: { "idempotency-key": "release-build-a1b2c3" } });
    assert.equal(notVerified.statusCode, 409);
    const verified = await write(`/v1/targets/${targetId}/verify`, { cookie: cookieA, organizationId: orgA });
    assert.equal(verified.statusCode, 200, verified.body);
    assert.equal(verified.json().verified, true);
    const verifiedDetail = await runningApp.inject({ method: "GET", url: `/v1/projects/${projectId}`, headers: { cookie: cookieA, "x-atlas-organization": orgA } });
    assert.equal(verifiedDetail.statusCode, 200, verifiedDetail.body);
    assert.equal(verifiedDetail.json().targets[0].verificationToken, null);

    const firstRun = await write(runUrl, { cookie: cookieA, organizationId: orgA, headers: { "idempotency-key": "release-build-a1b2c3" } });
    assert.equal(firstRun.statusCode, 202, firstRun.body);
    assert.equal(firstRun.json().run.status, "queued");
    assert.equal(firstRun.json().run.verdict, null);
    runId = firstRun.json().run.id;
    const duplicate = await write(runUrl, { cookie: cookieA, organizationId: orgA, headers: { "idempotency-key": "release-build-a1b2c3" } });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(duplicate.json().run.id, runId);
    const privateReport = await runningApp.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: { cookie: cookieA, "x-atlas-organization": orgA } });
    assert.equal(privateReport.statusCode, 200);
    assert.equal(privateReport.json().evidenceStatus, "not-run");
    assert.equal(privateReport.json().run.binding.build.id, "a1b2c3d4");
    assert.equal(privateReport.json().run.binding.build.immutable, true);
    assert.ok(privateReport.json().run.binding.releasePolicy.contentHash);

    const accountB = await write("/v1/auth/register", { body: { email: emailB, password: "another sufficiently long test password", organizationName: "QA Org B" } });
    assert.equal(accountB.statusCode, 201, accountB.body);
    const orgB = accountB.json().organization.id;
    organizationIds.push(orgB);
    const cookieB = accountB.headers["set-cookie"].split(";")[0];
    const crossTenant = await runningApp.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: { cookie: cookieB, "x-atlas-organization": orgB } });
    assert.equal(crossTenant.statusCode, 404);

    const artifactId = randomUUID();
    await pool.query("INSERT INTO artifacts(id,organization_id,run_id,object_key,media_type,byte_length,sha256) VALUES($1,$2,$3,$4,'application/json',2,$5)", [artifactId, orgA, runId, `dev/${orgA}/${runId}/${artifactId}`, "0".repeat(64)]);
    await pool.query("UPDATE runs SET retention_expires_at=now()-interval '1 second' WHERE organization_id=$1 AND id=$2", [orgA, runId]);
    const purge = await purgeExpiredRecords(pool);
    assert.equal(purge.runs, 1);
    const expiredRun = await runningApp.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: { cookie: cookieA, "x-atlas-organization": orgA } });
    assert.equal(expiredRun.statusCode, 404);
    const artifact = await pool.query("SELECT id FROM artifacts WHERE id=$1", [artifactId]);
    assert.equal(artifact.rowCount, 0);
    const retentionAudit = await pool.query("SELECT action FROM audit_events WHERE resource_id=$1 AND action='run.retention.purged'", [runId]);
    assert.equal(retentionAudit.rowCount, 1);
  } finally {
    for (const id of organizationIds) await pool.query("DELETE FROM organizations WHERE id=$1", [id]);
    await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [[emailA, emailB]]);
    await runningApp.close();
    await pool.end();
  }
});
