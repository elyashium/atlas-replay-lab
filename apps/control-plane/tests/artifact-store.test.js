import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createArtifactStore, validateObjectKey } from "../src/artifact-store.js";
import { uploadRunArtifacts } from "../src/artifact-upload.js";

test("artifact store stays local by default and requires a bucket for S3 settings or production", () => {
  assert.equal(createArtifactStore({ env: {} }), null);
  assert.throws(() => createArtifactStore({ env: { NODE_ENV: "production" } }), /production requires/);
  assert.throws(() => createArtifactStore({ env: { ATLAS_ARTIFACT_S3_ENDPOINT: "https://objects.example" } }), /BUCKET is required/);
  assert.throws(() => createArtifactStore({ env: { ATLAS_ARTIFACT_S3_BUCKET: "private-bucket", ATLAS_ARTIFACT_S3_ACCESS_KEY_ID: "id" }, client: {} }), /configured together/);
  assert.throws(() => createArtifactStore({ env: { ATLAS_ARTIFACT_S3_BUCKET: "private-bucket", ATLAS_ARTIFACT_S3_ENDPOINT: "http://objects.example" }, client: {} }), /HTTPS/);
});

test("S3-compatible adapter validates keys, stores private bytes, reads and deletes run prefixes", async () => {
  const calls = [];
  const client = {
    async send(command) {
      calls.push(command);
      if (command.constructor.name === "GetObjectCommand") return { Body: { transformToByteArray: async () => Buffer.from("artifact") } };
      if (command.constructor.name === "ListObjectVersionsCommand") return { IsTruncated: false, Versions: [{ Key: `${runId}/report.html`, VersionId: "v1" }, { Key: "another-run/report.html", VersionId: "v1" }] };
      return {};
    },
    destroy() {},
  };
  const runId = "123e4567-e89b-42d3-a456-426614174000";
  const store = createArtifactStore({
    env: { ATLAS_ARTIFACT_S3_BUCKET: "atlas-private", ATLAS_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:9000/storage/v1/s3", ATLAS_ARTIFACT_S3_ACCESS_KEY_ID: "dev-id", ATLAS_ARTIFACT_S3_SECRET_ACCESS_KEY: "dev-secret" },
    client,
  });
  await store.putObject(`${runId}/report.html`, Buffer.from("artifact"), "text/html", "a".repeat(64));
  assert.equal((await store.getObject(`${runId}/report.html`)).toString(), "artifact");
  assert.equal(await store.deleteRun(runId), 1);
  const put = calls.find((command) => command.constructor.name === "PutObjectCommand").input;
  assert.equal(put.CacheControl, "private, no-store");
  assert.equal(put.ContentLength, 8);
  assert.equal(put.Metadata.sha256, "a".repeat(64));
  const deletion = calls.find((command) => command.constructor.name === "DeleteObjectsCommand").input;
  assert.deepEqual(deletion.Delete.Objects, [{ Key: `${runId}/report.html`, VersionId: "v1" }]);
  assert.throws(() => validateObjectKey(`${runId}/../secret`), /invalid artifact object key/);
  await assert.rejects(store.getObject("/outside"), /invalid artifact object key/);
});

test("S3 deletion removes versions and delete markers across paginated listings", async () => {
  const calls = [];
  const client = {
    async send(command) {
      calls.push(command);
      if (command.constructor.name !== "ListObjectVersionsCommand") return {};
      return command.input.KeyMarker
        ? { IsTruncated: false, Versions: [{ Key: `${runId}/b`, VersionId: "v2" }], DeleteMarkers: [{ Key: `${runId}/a`, VersionId: "delete-marker" }] }
        : { IsTruncated: true, NextKeyMarker: `${runId}/a`, NextVersionIdMarker: "v1", Versions: [{ Key: `${runId}/a`, VersionId: "v1" }] };
    },
  };
  const runId = "223e4567-e89b-42d3-a456-426614174000";
  const store = createArtifactStore({ env: { ATLAS_ARTIFACT_S3_BUCKET: "atlas-private" }, client });
  assert.equal(await store.deleteRun(runId), 3);
  assert.equal(calls.filter((command) => command.constructor.name === "ListObjectVersionsCommand").length, 2);
  assert.deepEqual(calls.filter((command) => command.constructor.name === "DeleteObjectsCommand").flatMap((command) => command.input.Delete.Objects), [
    { Key: `${runId}/a`, VersionId: "v1" },
    { Key: `${runId}/b`, VersionId: "v2" },
    { Key: `${runId}/a`, VersionId: "delete-marker" },
  ]);
});

test("S3 retention fails closed when version listing cannot prove a complete purge", async () => {
  const runId = "423e4567-e89b-42d3-a456-426614174000";
  const store = createArtifactStore({
    env: { ATLAS_ARTIFACT_S3_BUCKET: "atlas-private" },
    client: { async send() { return { IsTruncated: true, Versions: [{ Key: `${runId}/a` }] }; } },
  });
  await assert.rejects(store.deleteRun(runId), /omitted a version ID/);
});

test("worker artifacts are hash-checked before private object-storage upload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "atlas-artifact-upload-"));
  const runId = "323e4567-e89b-42d3-a456-426614174000";
  const bytes = Buffer.from("synthetic report");
  const key = `${runId}/report.html`;
  const sent = [];
  const store = { async putObject(...args) { sent.push(args); } };
  try {
    await mkdir(path.join(root, runId));
    await writeFile(path.join(root, key), bytes);
    const artifact = { objectKey: key, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mediaType: "text/html" };
    await uploadRunArtifacts(store, root, runId, [artifact]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], key);
    assert.deepEqual(sent[0][1], bytes);
    await assert.rejects(uploadRunArtifacts(store, root, runId, [{ ...artifact, sha256: "0".repeat(64) }]), /changed before object-storage upload/);
    await assert.rejects(uploadRunArtifacts(store, root, runId, [{ ...artifact, objectKey: `${runId}/../outside` }]), /invalid artifact object key/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
