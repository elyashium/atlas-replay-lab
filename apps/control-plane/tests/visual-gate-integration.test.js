import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodePng } from "../../../src/image/png.js";
import { buildApp } from "../src/server.js";
import { createPool } from "../src/db.js";

const databaseUrl = process.env.DATABASE_URL;
const origin = "http://127.0.0.1:3000";
const unchanged = encodePng({ width: 2, height: 2, data: Buffer.alloc(16, 0) });
const changed = encodePng({ width: 2, height: 2, data: Buffer.from([255, 255, 255, 255, ...Array(12).fill(0)]) });

test("Postgres persists an audited, run-bound visual gate without changing the underlying run verdict", { skip: !databaseUrl && "set DATABASE_URL and run migrations to enable Postgres integration" }, async () => {
  const pool = createPool(databaseUrl);
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "atlas-visual-gate-"));
  const email = `visual-gate-${randomUUID()}@example.org`;
  let organizationId;
  const app = buildApp({
    pool, appOrigin: origin, closePool: false, artifactRoot,
    dns: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
  });
  const write = (url, { method = "POST", body = {}, cookie = "", org = "", headers = {} } = {}) => app.inject({
    method, url, payload: body,
    headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(org ? { "x-atlas-organization": org } : {}), ...headers },
  });
  try {
    const account = await write("/v1/auth/register", { body: { email, password: "a sufficiently long integration password", organizationName: "Visual Gate Integration" } });
    assert.equal(account.statusCode, 201, account.body);
    organizationId = account.json().organization.id;
    const cookie = account.headers["set-cookie"].split(";")[0];
    const projectResponse = await write("/v1/projects", { cookie, org: organizationId, body: { name: "Visual release checks" } });
    assert.equal(projectResponse.statusCode, 201, projectResponse.body);
    const projectId = projectResponse.json().project.id;
    const contract = {
      schemaVersion: 1, id: "visual-gate-stage", name: "Visual gate staging", environment: "staging",
      authorization: { authorized: true }, target: { url: "https://visual-gate.example.org/", allowedOrigins: ["https://visual-gate.example.org"], buildId: "build-2" },
      journey: { steps: [{ type: "waitForVisible", selector: "[data-ready]" }], success: { selector: "[data-ready]" }, fallback: { selector: "[data-fallback]", requiredOn: [] } },
      profiles: ["high-wifi"], budgets: { journeyTimeoutMs: 5000, stepTimeoutMs: 2000 },
      policy: { version: "release-v1", criticalProfiles: ["high-wifi"], minimumScore: 50, visualGate: { version: "1", maxPixelDiffRatio: 0.1 } },
      mediaConsent: false, screenshots: { consent: true, redactSelectors: ["[data-private]"], componentSelectors: [{ id: "viewer", selector: "[data-viewer]" }] },
    };
    const targetResponse = await write(`/v1/projects/${projectId}/targets`, { cookie, org: organizationId, body: { contract } });
    assert.equal(targetResponse.statusCode, 201, targetResponse.body);
    const targetId = targetResponse.json().target.id;
    const userId = account.json().user.id;
    const baselineId = randomUUID();
    const currentId = randomUUID();
    const baselineContract = structuredClone(contract);
    baselineContract.target.buildId = "build-1";
    const binding = { bindingVersion: 1, bindingHash: "a".repeat(16) };
    for (const [id, runContract] of [[baselineId, baselineContract], [currentId, contract]]) {
      await pool.query("INSERT INTO runs(id,organization_id,project_id,target_id,status,verdict,contract_version,contract_snapshot,binding_snapshot,requested_by,idempotency_key,finished_at,retention_expires_at) VALUES($1,$2,$3,$4,'completed','SHIP','1',$5,$6,$7,$8,now(),now()+interval '1 day')", [id, organizationId, projectId, targetId, runContract, binding, userId, `visual-gate-${id}`]);
    }
    const pathSuffix = "matrix/runs/high-wifi/screenshots/component-viewer.png";
    const baselineObjectKey = `${baselineId}/${pathSuffix}`;
    const currentObjectKey = `${currentId}/${pathSuffix}`;
    for (const [runId, objectKey, bytes] of [[baselineId, baselineObjectKey, unchanged], [currentId, currentObjectKey, changed]]) {
      const destination = path.join(artifactRoot, runId, ...objectKey.split("/").slice(1));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    const [baselineArtifact, currentArtifact] = [randomUUID(), randomUUID()];
    await pool.query("INSERT INTO artifacts(id,organization_id,run_id,object_key,media_type,byte_length,sha256) VALUES($1,$2,$3,$4,'image/png',$5,$6),($7,$2,$8,$9,'image/png',$10,$11)", [baselineArtifact, organizationId, baselineId, baselineObjectKey, unchanged.length, await sha256(unchanged), currentArtifact, currentId, currentObjectKey, changed.length, await sha256(changed)]);
    const evaluation = await write(`/v1/runs/${currentId}/visual-gate-evaluations`, { cookie, org: organizationId, body: { referenceRunId: baselineId, artifactId: currentArtifact, referenceArtifactId: baselineArtifact } });
    assert.equal(evaluation.statusCode, 201, evaluation.body);
    assert.equal(evaluation.json().evaluation.verdict, "HOLD");
    const retry = await write(`/v1/runs/${currentId}/visual-gate-evaluations`, { cookie, org: organizationId, body: { referenceRunId: baselineId, artifactId: currentArtifact, referenceArtifactId: baselineArtifact } });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().evaluation.id, evaluation.json().evaluation.id);
    assert.equal((await pool.query("SELECT verdict FROM runs WHERE id=$1", [currentId])).rows[0].verdict, "SHIP");
    assert.equal((await pool.query("SELECT id FROM visual_gate_evaluations WHERE id=$1", [evaluation.json().evaluation.id])).rowCount, 1);
    assert.equal((await pool.query("SELECT id FROM audit_events WHERE resource_id=$1 AND action='visual-gate.evaluated'", [evaluation.json().evaluation.id])).rowCount, 1);
  } finally {
    if (organizationId) await pool.query("DELETE FROM organizations WHERE id=$1", [organizationId]);
    await app.close(); await pool.end(); await rm(artifactRoot, { recursive: true, force: true });
  }
});

async function sha256(bytes) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}
