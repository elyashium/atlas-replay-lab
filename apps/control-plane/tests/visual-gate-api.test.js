import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encodePng } from "../../../src/image/png.js";
import { buildApp } from "../src/server.js";

const origin = "http://127.0.0.1:3000";
const orgId = "123e4567-e89b-42d3-a456-426614174000";
const currentRunId = "223e4567-e89b-42d3-a456-426614174000";
const baselineRunId = "323e4567-e89b-42d3-a456-426614174000";
const currentArtifactId = "423e4567-e89b-42d3-a456-426614174000";
const baselineArtifactId = "523e4567-e89b-42d3-a456-426614174000";
const cookie = "atlas_session=0123456789abcdef0123456789abcdef0123456789abcdef";
const relativePath = "matrix/runs/high-wifi/screenshots/component-viewer.png";
const baselinePng = encodePng({ width: 2, height: 2, data: Buffer.alloc(16, 0) });
const currentPng = encodePng({ width: 2, height: 2, data: Buffer.from([255, 255, 255, 255, ...Array(12).fill(0)]) });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function contract(buildId, maxPixelDiffRatio = 0.1) {
  return {
    schemaVersion: 1, id: "owned-stage", name: "Owned staging", environment: "staging",
    authorization: { authorized: true }, target: { url: "https://stage.example.test/", allowedOrigins: ["https://stage.example.test"], buildId },
    journey: { steps: [{ type: "waitForVisible", selector: "[data-ready]" }], success: { selector: "[data-ready]" }, fallback: { selector: "[data-fallback]", requiredOn: [] } },
    profiles: ["high-wifi"], budgets: { journeyTimeoutMs: 5000, stepTimeoutMs: 2000 },
    policy: { version: "release-v1", criticalProfiles: ["high-wifi"], minimumScore: 50, visualGate: { version: "1", maxPixelDiffRatio } },
    mediaConsent: false, screenshots: { consent: true, redactSelectors: ["[data-private]"], componentSelectors: [{ id: "viewer", selector: "[data-viewer]" }] },
  };
}

function setup({ currentBytes = currentPng, referenceBytes = baselinePng, policy = contract("build-2"), relative = relativePath, referenceRelative = relative, role = "owner", currentVerdict = "SHIP" } = {}) {
  const currentContract = policy;
  const baselineContract = structuredClone(currentContract);
  baselineContract.target.buildId = "build-1";
  const artifacts = [
    { id: currentArtifactId, runId: currentRunId, objectKey: `${currentRunId}/${relative}`, mediaType: "image/png", byteLength: currentBytes.length, sha256: hash(currentBytes) },
    { id: baselineArtifactId, runId: baselineRunId, objectKey: `${baselineRunId}/${referenceRelative}`, mediaType: "image/png", byteLength: referenceBytes.length, sha256: hash(referenceBytes) },
  ];
  const runs = [
    { id: currentRunId, projectId: "project-1", targetId: "target-1", status: "completed", verdict: currentVerdict, contractVersion: "1", contract: currentContract, retentionExpiresAt: "2099-01-01T00:00:00Z" },
    { id: baselineRunId, projectId: "project-1", targetId: "target-1", status: "completed", verdict: "SHIP", contractVersion: "1", contract: baselineContract, retentionExpiresAt: "2099-01-01T00:00:00Z" },
  ];
  const calls = [];
  const saved = new Map();
  const pool = {
    calls, saved,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT u.id,u.email FROM sessions")) return { rows: [{ id: "user-1", email: "qa@example.org" }], rowCount: 1 };
      if (sql.includes("SELECT role FROM memberships")) return { rows: [{ role }], rowCount: 1 };
      if (sql.includes("FROM runs WHERE organization_id=$1 AND id=ANY")) return { rows: runs.filter((run) => params[1].includes(run.id)), rowCount: 2 };
      if (sql.includes("FROM artifacts WHERE organization_id=$1 AND id=ANY")) return { rows: artifacts.filter((artifact) => params[1].includes(artifact.id) && params[2].includes(artifact.runId)), rowCount: 2 };
      if (sql.includes("FROM visual_gate_evaluations WHERE organization_id=$1 AND run_id=$2")) {
        const row = saved.get(`${params[0]}:${params[1]}:${params[2]}:${params[3]}`);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return { async query(sql, params = []) {
        calls.push({ sql, params });
        if (sql.includes("FROM visual_gate_evaluations WHERE organization_id=$1 AND run_id=$2")) {
          const row = saved.get(`${params[0]}:${params[1]}:${params[2]}:${params[3]}`);
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        if (sql.includes("INSERT INTO visual_gate_evaluations")) {
          const row = { id: params[0], runId: params[3], referenceRunId: params[4], artifactId: params[5], referenceArtifactId: params[6], relativePath: params[7], verdict: params[8], policy: params[9], evidence: params[10], createdAt: "2026-09-30T00:00:00Z" };
          const key = `${orgId}:${params[3]}:${params[4]}:${params[7]}`;
          if (saved.has(key)) return { rows: [], rowCount: 0 };
          saved.set(key, row);
          return { rows: [row], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }, release() {} };
    },
    async end() {},
  };
  const objects = new Map([[`${currentRunId}/${relative}`, currentBytes], [`${baselineRunId}/${referenceRelative}`, referenceBytes]]);
  let reads = 0;
  const artifactStore = { async getObject(key) { reads += 1; if (!objects.has(key)) throw Object.assign(new Error("missing"), { name: "NoSuchKey" }); return objects.get(key); } };
  return { pool, artifactStore, get reads() { return reads; } };
}

function evaluate(app, { referenceRunId = baselineRunId, artifactId = currentArtifactId, referenceArtifactId = baselineArtifactId } = {}) {
  return app.inject({
    method: "POST", url: `/v1/runs/${currentRunId}/visual-gate-evaluations`,
    headers: { origin, "content-type": "application/json", cookie, "x-atlas-organization": orgId },
    payload: { referenceRunId, artifactId, referenceArtifactId },
  });
}

test("component visual gate compares hash-verified same-path PNGs against the contract threshold and records an immutable verdict", async () => {
  const fixture = setup();
  const app = buildApp({ pool: fixture.pool, appOrigin: origin, artifactStore: fixture.artifactStore });
  try {
    const response = await evaluate(app);
    assert.equal(response.statusCode, 201, response.body);
    const result = response.json().evaluation;
    assert.equal(result.verdict, "HOLD");
    assert.equal(result.evidence.pixelDiffRatio, 0.25);
    assert.equal(result.policy.maxPixelDiffRatio, 0.1);
    assert.equal(result.evidence.scope, "one component capture; this is not an aggregate target release verdict");
    assert.equal(fixture.reads, 2);
    assert.equal(fixture.pool.calls.some((call) => call.sql.includes("INSERT INTO audit_events") && call.params[2] === "visual-gate.evaluated"), true);
    const retry = await evaluate(app);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().evaluation?.id, result.id, `${retry.body}; ${JSON.stringify(fixture.pool.calls.slice(-5))}`);
    assert.equal(fixture.pool.saved.size, 1);
  } finally { await app.close(); }
});

test("visual gate rejects a mismatched profile/component path before reading artifacts", async () => {
  const fixture = setup({ referenceRelative: "matrix/runs/low-cpu-3g/screenshots/component-viewer.png" });
  const app = buildApp({ pool: fixture.pool, appOrigin: origin, artifactStore: fixture.artifactStore });
  try {
    const response = await evaluate(app);
    assert.equal(response.statusCode, 409);
    assert.equal(fixture.reads, 0);
  } finally { await app.close(); }
});

test("visual gate cannot loosen an existing target HOLD", async () => {
  const fixture = setup({ currentBytes: baselinePng, referenceBytes: baselinePng, currentVerdict: "HOLD" });
  const app = buildApp({ pool: fixture.pool, appOrigin: origin, artifactStore: fixture.artifactStore });
  try {
    const response = await evaluate(app);
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().evaluation.verdict, "HOLD");
    assert.equal(response.json().evaluation.evidence.reason, "current_run_did_not_ship");
  } finally { await app.close(); }
});
