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

  const databaseUrl = process.env.DATABASE_URL;
const origin = "http://127.0.0.1:3000";

test("Postgres onboarding is tenant-scoped, idempotent, fail-closed and expires metadata", { skip: !databaseUrl && "set DATABASE_URL and run migrations to enable Postgres integration" }, async () => {
  const pool = createPool(databaseUrl);
  const suffix = randomUUID();
  const emailA = `qa-a-${suffix}@example.org`;
  const emailB = `qa-b-${suffix}@example.org`;
  const organizationIds = [];
  const artifactRoot = await mkdtemp(path.join(tmpdir(), "atlas-pg-artifacts-"));
  let runId;
  let challenge = "";
  const dns = {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    resolveTxt: async () => challenge ? [[challenge]] : [],
  };
  const runningApp = buildApp({ pool, appOrigin: origin, secureCookies: false, dns, closePool: false, artifactRoot });
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

    const accountB = await write("/v1/auth/register", { body: { email: emailB, password: "another sufficiently long test password", organizationName: "QA Org B" } });
    assert.equal(accountB.statusCode, 201, accountB.body);
    const orgB = accountB.json().organization.id;
    organizationIds.push(orgB);
    const cookieB = accountB.headers["set-cookie"].split(";")[0];
    const crossTenant = await runningApp.inject({ method: "GET", url: `/v1/runs/${runId}`, headers: { cookie: cookieB, "x-atlas-organization": orgB } });
    assert.equal(crossTenant.statusCode, 404);
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
    await runningApp.close();
    await pool.end();
    await rm(artifactRoot, { recursive: true, force: true });
  }
});
