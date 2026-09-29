import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const SAFE_KEY = /^[A-Za-z0-9._/-]{1,1024}$/;

/** Return a private S3-compatible store when configured; local development may keep filesystem storage. */
export function createArtifactStore({ env = process.env, client } = {}) {
  const bucket = env.ATLAS_ARTIFACT_S3_BUCKET?.trim();
  const endpoint = env.ATLAS_ARTIFACT_S3_ENDPOINT?.trim();
  const region = env.ATLAS_ARTIFACT_S3_REGION?.trim() || "us-east-1";
  const accessKeyId = env.ATLAS_ARTIFACT_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.ATLAS_ARTIFACT_S3_SECRET_ACCESS_KEY?.trim();
  const partialConfig = endpoint || accessKeyId || secretAccessKey;
  if (!bucket) {
    if (partialConfig) throw new Error("ATLAS_ARTIFACT_S3_BUCKET is required when S3 storage settings are present");
    if (env.NODE_ENV === "production") throw new Error("production requires a private S3-compatible artifact bucket");
    return null;
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) throw new Error("ATLAS_ARTIFACT_S3_BUCKET must be a lowercase S3 bucket name");
  if (!region || region.length > 128) throw new Error("ATLAS_ARTIFACT_S3_REGION is invalid");
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) throw new Error("S3 access key ID and secret access key must be configured together");
  let parsedEndpoint;
  if (endpoint) {
    try { parsedEndpoint = new URL(endpoint); }
    catch { throw new Error("ATLAS_ARTIFACT_S3_ENDPOINT must be a URL"); }
    const localHttp = parsedEndpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsedEndpoint.hostname);
    if (parsedEndpoint.protocol !== "https:" && !localHttp) throw new Error("S3 endpoint must use HTTPS outside local development");
    if (parsedEndpoint.username || parsedEndpoint.password || parsedEndpoint.search || parsedEndpoint.hash) throw new Error("S3 endpoint must not embed credentials or query parameters");
    if (!accessKeyId || !secretAccessKey) throw new Error("a custom S3 endpoint requires explicit credentials");
  }
  const s3 = client ?? new S3Client({
    ...(parsedEndpoint ? { endpoint: `${parsedEndpoint.origin}${parsedEndpoint.pathname.replace(/\/$/, "")}`, forcePathStyle: true } : {}),
    region,
    ...(accessKeyId ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    maxAttempts: 2,
  });
  return Object.freeze({
    provider: "s3-compatible",
    bucket,
    async putObject(key, body, contentType, sha256) {
      validateObjectKey(key);
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: bytes, ContentLength: bytes.length,
        ContentType: contentType, CacheControl: "private, no-store",
        ...(sha256 ? { Metadata: { sha256 } } : {}),
      }));
    },
    async getObject(key) {
      validateObjectKey(key);
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.Body) throw Object.assign(new Error("artifact object body is missing"), { code: "NoSuchKey" });
      return Buffer.from(await response.Body.transformToByteArray());
    },
    async deleteRun(runId) {
      if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("invalid artifact run ID");
      const prefix = `${runId}/`;
      let keyMarker;
      let versionIdMarker;
      let previousMarker;
      let deleted = 0;
      do {
        const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ...(keyMarker ? { KeyMarker: keyMarker } : {}), ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}) }));
        const versions = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])];
        const objects = versions.filter((item) => typeof item.Key === "string" && item.Key.startsWith(prefix));
        if (objects.some((item) => typeof item.VersionId !== "string")) throw new Error("artifact version listing omitted a version ID; refusing an incomplete purge");
        for (let offset = 0; offset < objects.length; offset += 1000) {
          const chunk = objects.slice(offset, offset + 1000).map(({ Key, VersionId }) => ({ Key, VersionId }));
          const result = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chunk, Quiet: true } }));
          if (result.Errors?.length) throw new Error(`artifact purge failed for ${result.Errors.length} object(s)`);
          deleted += chunk.length;
        }
        if (!listed.IsTruncated) break;
        if (typeof listed.NextKeyMarker !== "string") throw new Error("artifact version listing returned an invalid key marker");
        const nextKeyMarker = listed.NextKeyMarker;
        const nextVersionIdMarker = typeof listed.NextVersionIdMarker === "string" ? listed.NextVersionIdMarker : undefined;
        const marker = `${nextKeyMarker}\0${nextVersionIdMarker ?? ""}`;
        if (marker === previousMarker || (nextKeyMarker === keyMarker && nextVersionIdMarker === versionIdMarker)) throw new Error("artifact version listing repeated a page marker");
        previousMarker = marker;
        keyMarker = nextKeyMarker;
        versionIdMarker = nextVersionIdMarker;
      } while (true);
      return deleted;
    },
    close() { s3.destroy?.(); },
  });
}

export function validateObjectKey(key) {
  if (typeof key !== "string" || !SAFE_KEY.test(key) || key.startsWith("/") || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid artifact object key");
  }
  return key;
}
