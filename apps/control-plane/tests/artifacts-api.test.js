import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/server.js";

const ORIGIN = "http://127.0.0.1:3000";
const COOKIE = "atlas_session=0123456789abcdef0123456789abcdef0123456789abcdef";
const ORG = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_ORG = "223e4567-e89b-42d3-a456-426614174000";
const RUN = "323e4567-e89b-42d3-a456-426614174000";

test("run artifact reads are tenant-scoped, integrity-checked, and audited", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-artifact-api-"));
  const directory = path.join(root, RUN, "matrix");
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from('{"verdict":"HOLD"}\n');
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(directory, "report.json"), bytes);
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT u.id,u.email FROM sessions")) return { rows: [{ id: "user-a", email: "qa@example.org" }], rowCount: 1 };
      if (sql.includes("SELECT role FROM memberships")) return { rows: params[0] === ORG ? [{ role: "owner" }] : [], rowCount: params[0] === ORG ? 1 : 0 };
      if (sql.includes("FROM artifacts a JOIN runs")) return params[0] === ORG ? { rows: [{ object_key: `${RUN}/matrix/report.json`, media_type: "application/json", byte_length: bytes.length, sha256 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
    async end() {},
  };
  const app = buildApp({ pool, appOrigin: ORIGIN, artifactRoot: root });
  const url = `/v1/runs/${RUN}/artifacts/423e4567-e89b-42d3-a456-426614174000`;
  try {
    const wrongTenant = await app.inject({ method: "GET", url, headers: { cookie: COOKIE, "x-atlas-organization": OTHER_ORG } });
    assert.equal(wrongTenant.statusCode, 404);
    const response = await app.inject({ method: "GET", url, headers: { cookie: COOKIE, "x-atlas-organization": ORG } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, bytes.toString());
    assert.equal(response.headers["content-disposition"], 'attachment; filename="report.json"');
    assert.match(response.headers["content-security-policy"], /sandbox/);
    assert.equal(calls.some((call) => call.sql.includes("artifact.downloaded") && call.params[1] === "user-a"), true);

    await writeFile(path.join(directory, "report.json"), "modified");
    const tampered = await app.inject({ method: "GET", url, headers: { cookie: COOKIE, "x-atlas-organization": ORG } });
    assert.equal(tampered.statusCode, 410);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
