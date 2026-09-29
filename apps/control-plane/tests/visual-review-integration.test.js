import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { encodePng } from "../../../src/image/png.js";
import { buildApp } from "../src/server.js";
import { createPool } from "../src/db.js";
import { purgeExpiredRecords } from "../src/maintenance.js";

const databaseUrl = process.env.DATABASE_URL;
const origin = "http://127.0.0.1:3000";
const image = encodePng({ width: 1, height: 1, data: Buffer.from([5, 20, 40, 255]) });

test("Postgres stores consented visual findings by tenant and purges the report at expiry without storing screenshots", { skip: !databaseUrl && "set DATABASE_URL and run migrations to enable Postgres integration" }, async () => {
  const pool = createPool(databaseUrl);
  const email = `visual-${randomUUID()}@example.org`;
  const otherEmail = `visual-other-${randomUUID()}@example.org`;
  let organizationId;
  let otherOrganizationId;
  let reviewId;
  let proposalId;
  let visualCalls = 0;
  let codeCalls = 0;
  const app = buildApp({
    pool, appOrigin: origin, secureCookies: false, closePool: false, groqApiKey: "test-only",
    visualReviewer: async ({ image: submitted }) => {
      visualCalls += 1;
      assert.equal(Buffer.from(submitted).equals(image), true);
      return { provider: "groq", requestedModel: "qwen/test", returnedModel: "qwen/test", imageSha256: "d".repeat(64), referenceSha256: null, criteria: null, issues: [{ category: "hierarchy", kind: "subjective", severity: "minor", confidence: "medium", observation: "Primary action is visually weak.", recommendation: "Increase its emphasis.", region: null }], verdictEffect: "none" };
    },
    codeProposer: async ({ source, fileName }) => {
      codeCalls += 1;
      return { provider: "groq", requestedModel: "openai/test", returnedModel: "openai/test", fileName, sourceSha256: "e".repeat(64), summary: "Illustrative patch proposal.", unifiedDiff: `--- a/${fileName}\n+++ b/${fileName}\n@@ -1 +1 @@\n-old\n+new`, status: "proposal", applied: false, testsRun: false, verdictEffect: "none" };
    },
  });
  try {
    const write = (path, { body = {}, cookie = "", org = "", headers = {} } = {}) => app.inject({
      method: "POST", url: path, payload: body,
      headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(org ? { "x-atlas-organization": org } : {}), ...headers },
    });
    const created = await write("/v1/auth/register", { body: { email, password: "a sufficiently long visual test password", organizationName: "Visual QA Integration" } });
    assert.equal(created.statusCode, 201, created.body);
    organizationId = created.json().organization.id;
    const cookie = created.headers["set-cookie"].split(";")[0];
    const projectResponse = await write("/v1/projects", { cookie, org: organizationId, body: { name: "Component design review" } });
    assert.equal(projectResponse.statusCode, 201, projectResponse.body);
    const projectId = projectResponse.json().project.id;
    const route = `/v1/projects/${projectId}/visual-reviews`;
    const payload = { providerConsent: true, imageBase64: image.toString("base64") };
    const headers = { "idempotency-key": "integration-visual-001" };
    const submitted = await write(route, { cookie, org: organizationId, body: payload, headers });
    assert.equal(submitted.statusCode, 201, submitted.body);
    assert.equal(submitted.json().review.status, "complete");
    reviewId = submitted.json().review.id;
    const retry = await write(route, { cookie, org: organizationId, body: payload, headers });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().review.id, reviewId);
    assert.equal(visualCalls, 1);

    const source = "export function Button(){ return 'private source note'; }\n";
    const codePath = `${route}/${reviewId}/code-proposals`;
    const codeBody = { sourceConsent: true, fileName: "Button.jsx", source, task: "Adjust visual hierarchy." };
    const codeHeaders = { "idempotency-key": "integration-code-proposal-001" };
    const codeCreated = await write(codePath, { cookie, org: organizationId, body: codeBody, headers: codeHeaders });
    assert.equal(codeCreated.statusCode, 201, codeCreated.body);
    assert.equal(codeCreated.json().proposal.status, "proposal");
    assert.equal(codeCreated.json().proposal.result.applied, false);
    assert.equal(codeCreated.json().proposal.result.testsRun, false);
    proposalId = codeCreated.json().proposal.id;
    const codeRetry = await write(codePath, { cookie, org: organizationId, body: codeBody, headers: codeHeaders });
    assert.equal(codeRetry.statusCode, 200);
    assert.equal(codeRetry.json().proposal.id, proposalId);
    assert.equal(codeCalls, 1);

    const detail = await app.inject({ method: "GET", url: `/v1/projects/${projectId}`, headers: { cookie, "x-atlas-organization": organizationId } });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().visualReviews[0].id, reviewId);
    assert.equal(detail.json().codeProposals[0].id, proposalId);
    const persisted = await pool.query("SELECT result::text, screenshot_sha256, request_sha256 FROM visual_reviews WHERE id=$1", [reviewId]);
    assert.equal(persisted.rowCount, 1);
    assert.match(persisted.rows[0].screenshot_sha256, /^[0-9a-f]{64}$/);
    assert.equal(persisted.rows[0].result.includes(image.toString("base64")), false);
    const storedProposal = await pool.query("SELECT result::text, source_sha256 FROM code_proposals WHERE id=$1", [proposalId]);
    assert.equal(storedProposal.rowCount, 1);
    assert.match(storedProposal.rows[0].source_sha256, /^[0-9a-f]{64}$/);
    assert.equal(storedProposal.rows[0].result.includes(source), false);
    assert.equal(storedProposal.rows[0].result.includes("private source note"), false);
    const egressAudit = await pool.query("SELECT details FROM audit_events WHERE resource_id=$1 AND action='visual-review.completed'", [reviewId]);
    assert.equal(egressAudit.rowCount, 1);
    assert.equal(egressAudit.rows[0].details.egressConsent, true);
    const sourceAudit = await pool.query("SELECT details FROM audit_events WHERE resource_id=$1 AND action='code-proposal.created'", [proposalId]);
    assert.equal(sourceAudit.rowCount, 1);
    assert.equal(sourceAudit.rows[0].details.sourceEgressConsent, true);

    const other = await write("/v1/auth/register", { body: { email: otherEmail, password: "another sufficiently long visual test password", organizationName: "Different Visual Org" } });
    assert.equal(other.statusCode, 201, other.body);
    otherOrganizationId = other.json().organization.id;
    const otherCookie = other.headers["set-cookie"].split(";")[0];
    const denied = await app.inject({ method: "GET", url: `/v1/projects/${projectId}`, headers: { cookie: otherCookie, "x-atlas-organization": otherOrganizationId } });
    assert.equal(denied.statusCode, 404);
    const otherCodeProposal = await write(codePath, { cookie: otherCookie, org: otherOrganizationId, body: codeBody, headers: { "idempotency-key": "cross-org-code-proposal" } });
    assert.equal(otherCodeProposal.statusCode, 404);

    await pool.query("UPDATE code_proposals SET retention_expires_at=now()-interval '1 second' WHERE id=$1", [proposalId]);
    await pool.query("UPDATE visual_reviews SET retention_expires_at=now()-interval '1 second' WHERE id=$1", [reviewId]);
    await purgeExpiredRecords(pool);
    assert.equal((await pool.query("SELECT id FROM code_proposals WHERE id=$1", [proposalId])).rowCount, 0);
    assert.equal((await pool.query("SELECT id FROM visual_reviews WHERE id=$1", [reviewId])).rowCount, 0);
    assert.equal((await pool.query("SELECT id FROM audit_events WHERE resource_id=$1 AND action='visual-review.retention.purged'", [reviewId])).rowCount, 1);
    assert.equal((await pool.query("SELECT id FROM audit_events WHERE resource_id=$1 AND action='code-proposal.retention.purged'", [proposalId])).rowCount, 1);
  } finally {
    if (organizationId) await pool.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    if (otherOrganizationId) await pool.query("DELETE FROM organizations WHERE id=$1", [otherOrganizationId]);
    await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [[email, otherEmail]]);
    await app.close();
    await pool.end();
  }
});
