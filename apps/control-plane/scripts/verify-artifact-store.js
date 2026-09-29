import { createHash, randomUUID } from "node:crypto";
import { loadLocalEnv } from "../src/load-env.js";
import { createArtifactStore } from "../src/artifact-store.js";

loadLocalEnv();

const endpoint = process.env.ATLAS_ARTIFACT_S3_ENDPOINT;
const testBucket = process.env.ATLAS_TEST_ARTIFACT_S3_BUCKET;
if (process.env.NODE_ENV === "production" || process.env.ATLAS_ARTIFACT_S3_TEST !== "1") {
  throw new Error("set ATLAS_ARTIFACT_S3_TEST=1 outside production to allow this disposable storage check");
}
let parsedEndpoint;
try { parsedEndpoint = new URL(endpoint); }
catch { throw new Error("the local storage check requires ATLAS_ARTIFACT_S3_ENDPOINT"); }
if (parsedEndpoint.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(parsedEndpoint.hostname)) {
  throw new Error("the local storage check only accepts a loopback HTTP endpoint");
}
if (!testBucket) throw new Error("set ATLAS_TEST_ARTIFACT_S3_BUCKET to a disposable bucket");

const store = createArtifactStore({ env: { ...process.env, ATLAS_ARTIFACT_S3_BUCKET: testBucket } });
if (!store) throw new Error("S3-compatible artifact storage is not configured");
const runId = randomUUID();
const key = `${runId}/atlas-storage-check.txt`;
const bytes = Buffer.from("Atlas local object-storage verification\n", "utf8");
const sha256 = createHash("sha256").update(bytes).digest("hex");
let passed = false;
try {
  await store.putObject(key, bytes, "text/plain", sha256);
  const downloaded = await store.getObject(key);
  if (downloaded.length !== bytes.length || createHash("sha256").update(downloaded).digest("hex") !== sha256) throw new Error("artifact storage returned different bytes");
  const removed = await store.deleteRun(runId);
  if (removed !== 1) throw new Error("artifact storage did not delete exactly one test object");
  passed = true;
  console.log("Local S3-compatible artifact put/get/delete passed; the test object was removed.");
} finally {
  if (!passed) await store.deleteRun(runId).catch(() => {});
  store.close();
}
