import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateObjectKey } from "./artifact-store.js";

/** Verify each locally staged worker artifact before uploading it to private object storage. */
export async function uploadRunArtifacts(store, artifactRoot, runId, artifacts) {
  for (const artifact of artifacts) {
    const objectKey = validateObjectKey(artifact.objectKey);
    const pieces = objectKey.split("/");
    if (pieces[0] !== runId || pieces.length < 2) throw new Error("worker produced an artifact key outside its run prefix");
    const bytes = await readFile(path.join(artifactRoot, ...pieces));
    if (bytes.length !== artifact.byteLength || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("worker artifact changed before object-storage upload");
    await store.putObject(objectKey, bytes, artifact.mediaType, artifact.sha256);
  }
}
