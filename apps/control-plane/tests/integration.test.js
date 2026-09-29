import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/server.js";
import { createPool } from "../src/db.js";
import { purgeExpiredRecords } from "../src/maintenance.js";
import { claimNextRun, heartbeatRun, recoverExpiredRuns } from "../src/local-worker.js";
import { recordFailedRun, recordSuccessfulRun } from "../src/worker-runtime.js";
import { encodePng } from "../../../src/image/png.js";

  const databaseUrl = process.env.DATABASE_URL;
const origin = "http://127.0.0.1:3000";

test("Postgres onboarding is tenant-scoped, idempotent, fail-closed and expires metadata", { skip: !databaseUrl && "set DATABASE_URL and run migrations to enable Postgres integration" }, async () => {
  const pool = createPool(databaseUrl);
  const suffix = randomUUID();
  const emailA = `qa-a-${suffix}@example.org`;
  const emailB = `qa-b-${suffix}@example.org`;
  const organizationIds = [];
  const artifactRoot = await mkdtemp(path.join(tmpdir(), "atlas-pg-artifacts-"));
  let shareReplicaPool;
  let shareReplicaApp;
  let runId;
  let challenge = "";
  const dns = {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    resolveTxt: async () => challenge ? [[challenge]] : [],
  };
  const runningApp = buildApp({ pool, appOrigin: origin, secureCookies: false, dns, closePool: false, artifactRoot, sharedReportRateLimitPerMinute: 2 });
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
    assert.equal(privateReport.json().evidenceStatus, "pending");
    assert.equal(privateReport.json().run.binding.build.id, "a1b2c3d4");
    assert.equal(privateReport.json().run.binding.build.immutable, true);
    assert.ok(privateReport.json().run.binding.releasePolicy.contentHash);
    const cancelled = await write(`/v1/runs/${runId}/cancel`, { cookie: cookieA, organizationId: orgA });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().status, "cancelled");
    const cancelledStatus = await pool.query("SELECT status,verdict FROM runs WHERE id=$1", [runId]);
    assert.equal(cancelledStatus.rows[0].status, "cancelled");
    assert.equal(cancelledStatus.rows[0].verdict, null);
    const activeRun = await write(runUrl, { cookie: cookieA, organizationId: orgA, headers: { "idempotency-key": "release-build-a1b2c3-second" } });
    assert.equal(activeRun.statusCode, 202);
    const activeRunId = activeRun.json().run.id;
    await pool.query("UPDATE runs SET status='running',worker_id='worker-test',lease_expires_at=now()+interval '2 minutes',started_at=now() WHERE id=$1", [activeRunId]);
    const cancelRequest = await write(`/v1/runs/${activeRunId}/cancel`, { cookie: cookieA, organizationId: orgA });
    assert.equal(cancelRequest.statusCode, 200);
    assert.equal(cancelRequest.json().status, "running");
    assert.equal(cancelRequest.json().cancellationRequested, true);
    assert.equal(await heartbeatRun(pool, activeRunId, "worker-test"), true);
    const cancelledRun = await pool.query("SELECT id,organization_id,attempt_count FROM runs WHERE id=$1", [activeRunId]);
    const cancelledOutcome = await recordFailedRun(pool, cancelledRun.rows[0], "worker-test", Object.assign(new Error("cancelled"), { code: "worker_cancelled" }));
    assert.equal(cancelledOutcome.status, "cancelled");

    const retryQueued = await write(runUrl, { cookie: cookieA, organizationId: orgA, headers: { "idempotency-key": "release-build-harness-retry" } });
    const retryRun1 = await claimNextRun(pool, "worker-retry-test");
    assert.equal(retryRun1.id, retryQueued.json().run.id);
    const retryOutcome = await recordFailedRun(pool, retryRun1, "worker-retry-test", Object.assign(new Error("timeout"), { code: "worker_timeout" }));
    assert.deepEqual(retryOutcome, { errorCode: "worker_timeout", cancelled: false, retry: true, status: "queued" });
    const retryRun2 = await claimNextRun(pool, "worker-retry-test");
    assert.equal(retryRun2.id, retryRun1.id);
    const exhaustedOutcome = await recordFailedRun(pool, retryRun2, "worker-retry-test", Object.assign(new Error("timeout"), { code: "worker_timeout" }));
    assert.deepEqual(exhaustedOutcome, { errorCode: "worker_timeout", cancelled: false, retry: false, status: "failed" });
    const retryStatus = await pool.query("SELECT status,verdict,error_code FROM runs WHERE id=$1", [retryRun1.id]);
    assert.deepEqual(retryStatus.rows[0], { status: "failed", verdict: "INCONCLUSIVE", error_code: "worker_timeout" });
    const leaseRunResponse = await write(runUrl, { cookie: cookieA, organizationId: orgA, headers: { "idempotency-key": "release-build-a1b2c3-lease" } });
    assert.equal(leaseRunResponse.statusCode, 202);
    const leaseRunId = leaseRunResponse.json().run.id;
    const claimOne = await claimNextRun(pool, "worker-pg-test");
    assert.equal(claimOne.id, leaseRunId);
    assert.equal(claimOne.attempt_count, 1);
    assert.equal(await claimNextRun(pool, "worker-pg-other"), null);
    assert.equal(await heartbeatRun(pool, leaseRunId, "worker-pg-test"), false);
    await pool.query("UPDATE runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [leaseRunId]);
    assert.equal(await recoverExpiredRuns(pool, { call: async () => "" }), 1);
    const claimTwo = await claimNextRun(pool, "worker-pg-test");
    assert.equal(claimTwo.id, leaseRunId);
    assert.equal(claimTwo.attempt_count, 2);
    await pool.query("UPDATE runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [leaseRunId]);
    assert.equal(await recoverExpiredRuns(pool, { call: async () => "" }), 1);
    const exhausted = await pool.query("SELECT status,verdict,error_code FROM runs WHERE id=$1", [leaseRunId]);
    assert.deepEqual(exhausted.rows[0], { status: "failed", verdict: "INCONCLUSIVE", error_code: "worker_lease_expired" });

    const workerQueued = await write(runUrl, { cookie: cookieA, organizationId: orgA, headers: { "idempotency-key": "release-build-worker-flow" } });
    assert.equal(workerQueued.statusCode, 202, workerQueued.body);
    const workerRun = await claimNextRun(pool, "worker-integration-test");
    assert.equal(workerRun.id, workerQueued.json().run.id);
    const workerResult = {
      status: "completed", verdict: "HOLD", decisionSource: "deterministic-release-gate",
      evidenceScope: "Synthetic integration fixture; browser worker was not run.",
      profiles: { completed: 1, total: 1 },
    };
    const artifactContents = [
      ["report.html", Buffer.from("<!doctype html><title>synthetic report</title>\n"), "text/html"],
      ["job-result.json", Buffer.from(`${JSON.stringify(workerResult)}\n`), "application/json"],
    ];
    const workerOutput = path.join(artifactRoot, workerRun.id);
    await mkdir(workerOutput, { recursive: true });
    const workerArtifacts = [];
    for (const [name, bytes, mediaType] of artifactContents) {
      await writeFile(path.join(workerOutput, name), bytes);
      workerArtifacts.push({
        id: randomUUID(), objectKey: `${workerRun.id}/${name}`, mediaType,
        byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    await recordSuccessfulRun(pool, workerRun, "worker-integration-test", { result: workerResult, artifacts: workerArtifacts });
    const completedRun = await runningApp.inject({ method: "GET", url: `/v1/runs/${workerRun.id}`, headers: { cookie: cookieA, "x-atlas-organization": orgA } });
    assert.equal(completedRun.statusCode, 200);
    assert.equal(completedRun.json().run.status, "completed");
    assert.equal(completedRun.json().run.verdict, "HOLD");
    assert.equal(completedRun.json().run.result.evidenceScope, workerResult.evidenceScope);
    assert.equal(completedRun.json().artifacts.length, 2);
    const reportArtifact = workerArtifacts.find((artifact) => artifact.mediaType === "text/html");
    const reportDownload = await runningApp.inject({
      method: "GET", url: `/v1/runs/${workerRun.id}/artifacts/${reportArtifact.id}`,
      headers: { cookie: cookieA, "x-atlas-organization": orgA },
    });
    assert.equal(reportDownload.statusCode, 200, reportDownload.body);
    assert.match(reportDownload.body, /synthetic report/);
    const artifactAudit = await pool.query("SELECT action,details->>'sha256' AS sha256 FROM audit_events WHERE resource_id=$1 AND action='artifact.downloaded'", [workerRun.id]);
    assert.equal(artifactAudit.rowCount, 1);
    assert.equal(artifactAudit.rows[0].sha256, reportArtifact.sha256);

    const shareCreated = await write(`/v1/runs/${workerRun.id}/share-links`, {
      cookie: cookieA, organizationId: orgA,
      body: { includeSummary: true, artifactIds: [reportArtifact.id], expiresInHours: 24 },
    });
    assert.equal(shareCreated.statusCode, 201, shareCreated.body);
    const shareUrl = new URL(shareCreated.json().url);
    const shareToken = new URLSearchParams(shareUrl.hash.slice(1)).get("share");
    assert.match(shareToken, /^[A-Za-z0-9_-]{43}$/);
    const tokenHash = await pool.query("SELECT token_hash FROM share_links WHERE id=$1", [shareCreated.json().share.id]);
    assert.equal(tokenHash.rows[0].token_hash.toString("hex"), createHash("sha256").update(shareToken).digest("hex"));
    const shareHeaders = { origin, "content-type": "application/json" };
    const openedShare = await runningApp.inject({ method: "POST", url: "/v1/shared-reports/open", payload: { token: shareToken }, headers: shareHeaders });
    assert.equal(openedShare.statusCode, 200, openedShare.body);
    assert.equal(openedShare.json().run.verdict, "HOLD");
    assert.equal(openedShare.json().artifacts.length, 1);
    assert.equal(openedShare.json().artifacts[0].id, reportArtifact.id);
    const sharedDownload = await runningApp.inject({ method: "POST", url: "/v1/shared-reports/artifact", payload: { token: shareToken, artifactId: reportArtifact.id }, headers: shareHeaders });
    assert.equal(sharedDownload.statusCode, 200, sharedDownload.body);
    assert.match(sharedDownload.body, /synthetic report/);
    shareReplicaPool = createPool(databaseUrl);
    shareReplicaApp = buildApp({ pool: shareReplicaPool, appOrigin: origin, sharedReportRateLimitPerMinute: 2, closePool: false });
    const limitedOpen = await shareReplicaApp.inject({ method: "POST", url: "/v1/shared-reports/open", payload: { token: shareToken }, headers: shareHeaders });
    assert.equal(limitedOpen.statusCode, 429);
    assert.equal(limitedOpen.headers["retry-after"], "60");
    const excludedArtifact = workerArtifacts.find((artifact) => artifact.mediaType === "application/json");
    const excludedDownload = await runningApp.inject({ method: "POST", url: "/v1/shared-reports/artifact", payload: { token: shareToken, artifactId: excludedArtifact.id }, headers: shareHeaders });
    assert.equal(excludedDownload.statusCode, 404);
    const shareLog = await pool.query("SELECT action FROM audit_events WHERE resource_type='share-link' AND resource_id=$1 ORDER BY action", [shareCreated.json().share.id]);
    assert.deepEqual(shareLog.rows.map((row) => row.action), ["share-link.artifact-downloaded", "share-link.created", "share-link.opened"]);
    const shareCounts = await pool.query("SELECT access_count FROM share_links WHERE id=$1", [shareCreated.json().share.id]);
    assert.equal(shareCounts.rows[0].access_count, 2);
    const rateLimitRows = await pool.query("SELECT request_count FROM shared_report_request_buckets WHERE share_id=$1", [shareCreated.json().share.id]);
    assert.equal(rateLimitRows.rows[0].request_count, 3);
    const revokedShare = await write(`/v1/runs/${workerRun.id}/share-links/${shareCreated.json().share.id}/revoke`, { cookie: cookieA, organizationId: orgA, body: {} });
    assert.equal(revokedShare.statusCode, 200, revokedShare.body);
    const revokedOpen = await runningApp.inject({ method: "POST", url: "/v1/shared-reports/open", payload: { token: shareToken }, headers: shareHeaders });
    assert.equal(revokedOpen.statusCode, 404);
    const revokedAudit = await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE resource_type='share-link' AND resource_id=$1 AND action='share-link.revoked'", [shareCreated.json().share.id]);
    assert.equal(revokedAudit.rows[0].count, 1);

    const expiringShare = await write(`/v1/runs/${workerRun.id}/share-links`, { cookie: cookieA, organizationId: orgA, body: { includeSummary: true, artifactIds: [], expiresInHours: 24 } });
    assert.equal(expiringShare.statusCode, 201, expiringShare.body);
    const expiringToken = new URLSearchParams(new URL(expiringShare.json().url).hash.slice(1)).get("share");
    await pool.query("UPDATE share_links SET expires_at=now()-interval '1 second' WHERE id=$1", [expiringShare.json().share.id]);
    const expiredOpen = await runningApp.inject({ method: "POST", url: "/v1/shared-reports/open", payload: { token: expiringToken }, headers: shareHeaders });
    assert.equal(expiredOpen.statusCode, 404);

    const accountB = await write("/v1/auth/register", { body: { email: emailB, password: "another sufficiently long test password", organizationName: "QA Org B" } });
    assert.equal(accountB.statusCode, 201, accountB.body);
    const orgB = accountB.json().organization.id;
    organizationIds.push(orgB);
    const cookieB = accountB.headers["set-cookie"].split(";")[0];
    const crossTenant = await runningApp.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: { cookie: cookieB, "x-atlas-organization": orgB } });
    assert.equal(crossTenant.statusCode, 404);
    const crossTenantShare = await write(`/v1/runs/${workerRun.id}/share-links`, { cookie: cookieB, organizationId: orgB, body: { includeSummary: true, artifactIds: [reportArtifact.id], expiresInHours: 24 } });
    assert.equal(crossTenantShare.statusCode, 404);
    const crossTenantArtifact = await runningApp.inject({
      method: "GET", url: `/v1/runs/${workerRun.id}/artifacts/${reportArtifact.id}`,
      headers: { cookie: cookieB, "x-atlas-organization": orgB },
    });
    assert.equal(crossTenantArtifact.statusCode, 404);

    const artifactId = randomUUID();
    const runArtifactDir = path.join(artifactRoot, runId);
    await mkdir(runArtifactDir, { recursive: true });
    await writeFile(path.join(runArtifactDir, "report.json"), "{}\n");
    await pool.query("INSERT INTO artifacts(id,organization_id,run_id,object_key,media_type,byte_length,sha256) VALUES($1,$2,$3,$4,'application/json',2,$5)", [artifactId, orgA, runId, `${runId}/report.json`, "0".repeat(64)]);
    await pool.query("UPDATE runs SET retention_expires_at=now()-interval '1 second' WHERE organization_id=$1 AND id=$2", [orgA, runId]);
    const purge = await purgeExpiredRecords(pool, { artifactRoot });
    assert.equal(purge.runCount, 1);
    assert.equal(purge.artifactDirectories, 1);
    const expiredRun = await runningApp.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: { cookie: cookieA, "x-atlas-organization": orgA } });
    assert.equal(expiredRun.statusCode, 404);
    const artifact = await pool.query("SELECT id FROM artifacts WHERE id=$1", [artifactId]);
    assert.equal(artifact.rowCount, 0);
    const retentionAudit = await pool.query("SELECT action FROM audit_events WHERE resource_id=$1 AND action='run.retention.purged'", [runId]);
    assert.equal(retentionAudit.rowCount, 1);
    const purgeQueue = await pool.query("SELECT run_id FROM artifact_purge_queue WHERE run_id=$1", [runId]);
    assert.equal(purgeQueue.rowCount, 0);
  } finally {
    for (const id of organizationIds) await pool.query("DELETE FROM organizations WHERE id=$1", [id]);
    await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [[emailA, emailB]]);
    if (shareReplicaApp) await shareReplicaApp.close();
    if (shareReplicaPool) await shareReplicaPool.end();
    await runningApp.close();
    await pool.end();
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("separate API instances serialize consented visual-review retries through PostgreSQL", { skip: !databaseUrl && "set DATABASE_URL and run migrations to enable Postgres integration" }, async () => {
  const pools = Array.from({ length: 4 }, () => createPool(databaseUrl));
  const [poolA, poolB, lockPoolA, lockPoolB] = pools;
  const suffix = randomUUID();
  const email = `visual-race-${suffix}@example.org`;
  let providerCalls = 0;
  let codeProviderCalls = 0;
  const review = async () => {
    providerCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 75));
    return { provider: "groq", requestedModel: "qwen/test", returnedModel: "qwen/test", issues: [{ category: "layout", kind: "objective", severity: "minor", confidence: "high", observation: "Fixture finding for idempotency test.", recommendation: "Keep the fixture unchanged.", region: null }], verdictEffect: "none" };
  };
  const propose = async ({ fileName, source }) => {
    codeProviderCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 75));
    return {
      provider: "groq", requestedModel: "qwen/test", returnedModel: "qwen/test", fileName,
      sourceSha256: createHash("sha256").update(source).digest("hex"), summary: "Synthetic test proposal.",
      unifiedDiff: `--- a/${fileName}\n+++ b/${fileName}\n@@ -1 +1 @@\n-old\n+new`, status: "proposal", applied: false, testsRun: false,
    };
  };
  const appA = buildApp({ pool: poolA, idempotencyPool: lockPoolA, appOrigin: origin, closePool: false, groqApiKey: "test-only", visualReviewer: review, codeProposer: propose });
  const appB = buildApp({ pool: poolB, idempotencyPool: lockPoolB, appOrigin: origin, closePool: false, groqApiKey: "test-only", visualReviewer: review, codeProposer: propose });
  let organizationId;
  let userId;
  try {
    const registered = await appA.inject({
      method: "POST", url: "/v1/auth/register", payload: { email, password: "a sufficiently long integration password", organizationName: "Visual race test" },
      headers: { origin, "content-type": "application/json" },
    });
    assert.equal(registered.statusCode, 201, registered.body);
    organizationId = registered.json().organization.id;
    userId = registered.json().user.id;
    const cookie = registered.headers["set-cookie"].split(";")[0];
    const project = await appA.inject({
      method: "POST", url: "/v1/projects", payload: { name: "Visual idempotency project" },
      headers: { origin, "content-type": "application/json", cookie, "x-atlas-organization": organizationId },
    });
    assert.equal(project.statusCode, 201, project.body);
    const projectId = project.json().project.id;
    const pixels = Buffer.alloc(4 * 4 * 4, 120);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    const payload = { providerConsent: true, imageBase64: encodePng({ width: 4, height: 4, data: pixels }).toString("base64") };
    const headers = { origin, "content-type": "application/json", cookie, "x-atlas-organization": organizationId, "idempotency-key": `same-visual-${suffix}` };
    const responseOptions = { method: "POST", url: `/v1/projects/${projectId}/visual-reviews`, payload, headers };

    const [responseA, responseB] = await Promise.all([appA.inject(responseOptions), appB.inject(responseOptions)]);
    assert.deepEqual([responseA.statusCode, responseB.statusCode].sort(), [200, 201]);
    assert.equal(responseA.json().review.id, responseB.json().review.id);
    assert.equal(providerCalls, 1);
    const stored = await poolA.query("SELECT count(*)::int AS count FROM visual_reviews WHERE organization_id=$1", [organizationId]);
    const usage = await poolA.query("SELECT request_count FROM visual_review_usage WHERE organization_id=$1", [organizationId]);
    assert.equal(stored.rows[0].count, 1);
    assert.equal(usage.rows[0].request_count, 1);
    const reviewId = responseA.json().review.id;
    const source = "export const Button = () => <button>Buy</button>;\n";
    const proposalOptions = {
      method: "POST", url: `/v1/projects/${projectId}/visual-reviews/${reviewId}/code-proposals`,
      payload: { sourceConsent: true, fileName: "button.jsx", source },
      headers: { ...headers, "idempotency-key": `same-proposal-${suffix}` },
    };
    const [proposalA, proposalB] = await Promise.all([appA.inject(proposalOptions), appB.inject(proposalOptions)]);
    assert.deepEqual([proposalA.statusCode, proposalB.statusCode].sort(), [200, 201]);
    assert.equal(proposalA.json().proposal.id, proposalB.json().proposal.id);
    assert.equal(codeProviderCalls, 1);
    const proposalUsage = await poolA.query("SELECT request_count FROM code_proposal_usage WHERE organization_id=$1", [organizationId]);
    assert.equal(proposalUsage.rows[0].request_count, 1);
  } finally {
    if (organizationId) await poolA.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    if (userId) await poolA.query("DELETE FROM users WHERE id=$1", [userId]);
    await Promise.all([appA.close(), appB.close()]);
    await Promise.all(pools.map((pool) => pool.end()));
  }
});
