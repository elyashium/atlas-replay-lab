import Fastify from "fastify";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { lookup, resolveTxt } from "node:dns/promises";
import { validateTargetContract } from "../../../src/targets/contract.js";
import { buildBinding, requireImmutableBuild } from "../../../src/targets/build-binding.js";
import { policyStamp } from "../../../src/gate/policy.js";
import { diffImages } from "../../../src/image/diff.js";
import { decodePng } from "../../../src/image/png.js";
import { GROQ_VISION_MODEL_DEFAULT, reviewScreenshotWithGroq, validateVisualIssues, VISUAL_REVIEW_IMAGE_LIMIT_BYTES, VISUAL_REVIEW_MAX_DIMENSION, VISUAL_REVIEW_MAX_PIXELS } from "../../../src/visual/groq-review.js";
import { CODE_SOURCE_LIMIT_BYTES, containsCredentialLikeText, GROQ_CODE_MODEL_DEFAULT, proposeCodePatch } from "../../../src/visual/groq-patch.js";
import { createPool, inTransaction } from "./db.js";
import { startRetentionMaintenance } from "./maintenance.js";
import { clearSessionCookie, hashPassword, hashToken, newId, newSecret, parseCookies, parseOwnedTargetUrl, sessionCookie, verifyPassword, isPublicAddress } from "./security.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildApp({
  pool = createPool(),
  idempotencyPool = pool,
  appOrigin = process.env.ATLAS_APP_ORIGIN ?? "http://127.0.0.1:3000",
  secureCookies = process.env.NODE_ENV === "production",
  logger = false,
  closePool = true,
  dns = { lookup, resolveTxt },
  visualReviewer = reviewScreenshotWithGroq,
  groqApiKey = process.env.GROQ_API_KEY,
  visualReviewDailyLimit = Number(process.env.ATLAS_VISUAL_REVIEW_DAILY_LIMIT ?? 10),
  codeProposer = proposeCodePatch,
  codeProposalDailyLimit = Number(process.env.ATLAS_CODE_PROPOSAL_DAILY_LIMIT ?? 5),
  sharedReportRateLimitPerMinute = Number(process.env.ATLAS_SHARED_REPORT_RATE_LIMIT_PER_MINUTE ?? 120),
  artifactRoot = process.env.ATLAS_LOCAL_ARTIFACT_DIR,
} = {}) {
  if (!Number.isInteger(visualReviewDailyLimit) || visualReviewDailyLimit < 1 || visualReviewDailyLimit > 1000) throw new Error("ATLAS_VISUAL_REVIEW_DAILY_LIMIT must be an integer from 1 to 1000");
  if (!Number.isInteger(codeProposalDailyLimit) || codeProposalDailyLimit < 1 || codeProposalDailyLimit > 1000) throw new Error("ATLAS_CODE_PROPOSAL_DAILY_LIMIT must be an integer from 1 to 1000");
  if (!Number.isInteger(sharedReportRateLimitPerMinute) || sharedReportRateLimitPerMinute < 1 || sharedReportRateLimitPerMinute > 10000) throw new Error("sharedReportRateLimitPerMinute must be an integer from 1 to 10000");
  const visualReviewLocks = new Map();
  const codeProposalLocks = new Map();
  const app = Fastify({
    logger: logger ? {
      level: "info",
      serializers: {
        req: (request) => ({ method: request.method, url: request.url.split("?", 1)[0] }),
        res: (response) => ({ statusCode: response.statusCode }),
      },
    } : false,
    bodyLimit: 256 * 1024,
    trustProxy: false,
  });

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("cache-control", "no-store");
    reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  });

  app.addHook("onRequest", async (request, reply) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      if (request.headers.origin !== appOrigin) return reply.code(403).send({ error: "same-origin request required" });
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return reply.code(415).send({ error: "application/json required" });
      }
    }
  });

  app.get("/healthz", async (_request, reply) => {
    try { await pool.query("SELECT 1"); return { status: "ok", service: "atlas-control-plane" }; }
    catch { return reply.code(503).send({ status: "unavailable" }); }
  });

  app.get("/api/openapi.json", async () => OPENAPI);
  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(await readFile(path.join(here, "../public/index.html"), "utf8")));
  app.get("/app.js", async (_request, reply) => reply.type("text/javascript; charset=utf-8").send(await readFile(path.join(here, "../public/app.js"), "utf8")));
  app.get("/pixel-diff-worker.js", async (_request, reply) => reply.type("text/javascript; charset=utf-8").send(await readFile(path.join(here, "../public/pixel-diff-worker.js"), "utf8")));
  app.get("/image-diff.js", async (_request, reply) => reply.type("text/javascript; charset=utf-8").send(await readFile(path.resolve(here, "../../../src/image/diff.js"), "utf8")));
  app.get("/app.css", async (_request, reply) => reply.type("text/css; charset=utf-8").send(await readFile(path.join(here, "../public/app.css"), "utf8")));

  app.post("/v1/auth/register", async (request, reply) => {
    const body = asObject(request.body);
    const email = normalizeEmail(body.email);
    const password = body.password;
    const orgName = cleanName(body.organizationName);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.code(400).send({ error: "valid email required" });
    if (typeof password !== "string" || password.length < 12 || password.length > 256) return reply.code(400).send({ error: "password must be 12 to 256 characters" });
    if (!orgName) return reply.code(400).send({ error: "organizationName is required" });
    const credentials = await hashPassword(password);
    const userId = newId();
    const orgId = newId();
    const token = newSecret();
    try {
      await inTransaction(pool, async (client) => {
        await client.query("INSERT INTO users(id,email,password_salt,password_hash) VALUES($1,$2,$3,$4)", [userId, email, credentials.salt, credentials.hash]);
        await client.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [orgId, orgName]);
        await client.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner')", [orgId, userId]);
        await client.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')", [hashToken(token), userId]);
        await client.query("INSERT INTO audit_events(organization_id,actor_user_id,action,resource_type,resource_id) VALUES($1,$2,'organization.created','organization',$1)", [orgId, userId]);
      });
    } catch (error) {
      if (error?.code === "23505") return reply.code(409).send({ error: "an account with that email already exists" });
      throw error;
    }
    reply.header("set-cookie", sessionCookie(token, { secure: secureCookies, maxAgeSeconds: SESSION_TTL_SECONDS }));
    return reply.code(201).send({ user: { id: userId, email }, organization: { id: orgId, name: orgName, role: "owner" } });
  });

  app.post("/v1/auth/login", async (request, reply) => {
    const body = asObject(request.body);
    const email = normalizeEmail(body.email);
    if (!email || typeof body.password !== "string" || body.password.length > 256) return reply.code(400).send({ error: "email and password are required" });
    const found = await pool.query("SELECT id,email,password_salt,password_hash FROM users WHERE email=$1", [email]);
    const row = found.rows[0];
    const salt = row?.password_salt ?? randomBytes(16);
    const hash = row?.password_hash ?? randomBytes(64);
    const valid = await verifyPassword(body.password, salt, hash);
    if (!row || !valid) return reply.code(401).send({ error: "invalid email or password" });
    const token = newSecret();
    await pool.query("DELETE FROM sessions WHERE expires_at <= now()");
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')", [hashToken(token), row.id]);
    reply.header("set-cookie", sessionCookie(token, { secure: secureCookies, maxAgeSeconds: SESSION_TTL_SECONDS }));
    const orgs = await pool.query("SELECT o.id,o.name,m.role FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 ORDER BY o.created_at", [row.id]);
    return { user: { id: row.id, email: row.email }, organizations: orgs.rows };
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const token = parseCookies(request.headers.cookie).get("atlas_session");
    if (token) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [hashToken(token)]);
    reply.header("set-cookie", clearSessionCookie({ secure: secureCookies }));
    return reply.code(204).send();
  });

  app.get("/v1/me", async (request, reply) => {
    const user = await sessionUser(request, pool);
    if (!user) return reply.code(401).send({ error: "authentication required" });
    const orgs = await pool.query("SELECT o.id,o.name,m.role FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=$1 ORDER BY o.created_at", [user.id]);
    return { user, organizations: orgs.rows };
  });

  app.get("/v1/projects", async (request, reply) => {
    const { user, orgId, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    const result = await pool.query("SELECT id,name,created_at AS \"createdAt\" FROM projects WHERE organization_id=$1 ORDER BY created_at DESC", [orgId]);
    return { projects: result.rows };
  });

  app.post("/v1/projects", async (request, reply) => {
    const { user, orgId, role, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    if (!canWrite(role)) return reply.code(403).send({ error: "organization editor role required" });
    const name = cleanName(asObject(request.body).name);
    if (!name) return reply.code(400).send({ error: "project name is required" });
    const id = newId();
    await inTransaction(pool, async (client) => {
      await client.query("INSERT INTO projects(id,organization_id,name,created_by) VALUES($1,$2,$3,$4)", [id, orgId, name, user.id]);
      await audit(client, orgId, user.id, "project.created", "project", id);
    });
    return reply.code(201).send({ project: { id, name } });
  });

  app.get("/v1/projects/:projectId", async (request, reply) => {
    const { orgId, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    const { projectId } = request.params;
    const result = await pool.query("SELECT id,name,created_at AS \"createdAt\" FROM projects WHERE organization_id=$1 AND id=$2", [orgId, projectId]);
    if (!result.rowCount) return reply.code(404).send({ error: "project not found" });
    const targets = await pool.query("SELECT id,base_url AS \"baseUrl\",hostname,verified_at IS NOT NULL AS verified,CASE WHEN verified_at IS NULL THEN verification_token ELSE NULL END AS \"verificationToken\",contract->>'name' AS name,created_at AS \"createdAt\" FROM targets WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at DESC", [orgId, projectId]);
    const runs = await pool.query("SELECT r.id,r.target_id AS \"targetId\",r.status,r.verdict,r.error_code AS \"errorCode\",r.contract_version AS \"contractVersion\",r.created_at AS \"createdAt\",r.started_at AS \"startedAt\",r.finished_at AS \"finishedAt\",r.result_snapshot AS result,COALESCE((SELECT json_agg(json_build_object('id',a.id,'mediaType',a.media_type,'byteLength',a.byte_length,'sha256',a.sha256,'name',regexp_replace(a.object_key,'^.*/','')) ORDER BY a.object_key) FROM artifacts a WHERE a.organization_id=r.organization_id AND a.run_id=r.id),'[]'::json) AS artifacts FROM runs r WHERE r.organization_id=$1 AND r.project_id=$2 ORDER BY r.created_at DESC LIMIT 50", [orgId, projectId]);
    const visualReviews = await pool.query("SELECT id,status,provider,requested_model AS \"requestedModel\",returned_model AS \"returnedModel\",screenshot_sha256 AS \"screenshotSha256\",reference_sha256 AS \"referenceSha256\",source_run_id AS \"sourceRunId\",source_artifact_id AS \"sourceArtifactId\",source_artifact_name AS \"sourceArtifactName\",result,error,created_at AS \"createdAt\" FROM visual_reviews WHERE organization_id=$1 AND project_id=$2 AND retention_expires_at>now() ORDER BY created_at DESC LIMIT 50", [orgId, projectId]);
    const findingDispositions = await pool.query("SELECT d.visual_review_id AS \"reviewId\",d.finding_index AS \"index\",d.disposition,d.updated_at AS \"updatedAt\" FROM visual_finding_dispositions d JOIN visual_reviews v ON v.organization_id=d.organization_id AND v.id=d.visual_review_id AND v.retention_expires_at>now() WHERE d.organization_id=$1 AND v.project_id=$2 ORDER BY d.visual_review_id,d.finding_index", [orgId, projectId]);
    const codeProposals = await pool.query("SELECT id,visual_review_id AS \"visualReviewId\",status,provider,requested_model AS \"requestedModel\",returned_model AS \"returnedModel\",file_name AS \"fileName\",source_sha256 AS \"sourceSha256\",result,error,created_at AS \"createdAt\" FROM code_proposals WHERE organization_id=$1 AND project_id=$2 AND retention_expires_at>now() ORDER BY created_at DESC LIMIT 50", [orgId, projectId]);
    const shares = await pool.query("SELECT s.id,s.run_id AS \"runId\",s.include_summary AS \"includeSummary\",s.artifact_scope AS \"artifactIds\",s.expires_at AS \"expiresAt\",s.revoked_at AS \"revokedAt\",s.created_at AS \"createdAt\",s.access_count AS \"accessCount\",s.last_accessed_at AS \"lastAccessedAt\",COALESCE((SELECT json_agg(json_build_object('action',e.action,'createdAt',e.created_at,'artifactId',e.details->>'artifactId') ORDER BY e.created_at DESC) FROM (SELECT action,created_at,details FROM audit_events WHERE organization_id=s.organization_id AND resource_type='share-link' AND resource_id=s.id AND action IN ('share-link.opened','share-link.artifact-downloaded') ORDER BY created_at DESC LIMIT 25) e),'[]'::json) AS \"accessLog\" FROM share_links s JOIN runs r ON r.organization_id=s.organization_id AND r.id=s.run_id WHERE s.organization_id=$1 AND r.project_id=$2 ORDER BY s.created_at DESC", [orgId, projectId]);
    for (const run of runs.rows) run.clientShares = shares.rows.filter((share) => share.runId === run.id);
    for (const review of visualReviews.rows) review.findingDispositions = findingDispositions.rows.filter((item) => item.reviewId === review.id);
    return { project: result.rows[0], targets: targets.rows, runs: runs.rows, visualReviews: visualReviews.rows, findingDispositions: findingDispositions.rows, codeProposals: codeProposals.rows };
  });

  app.post("/v1/projects/:projectId/visual-reviews", { bodyLimit: 28 * 1024 * 1024 }, async (request, reply) => {
    const { user, orgId, role, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    if (!canWrite(role)) return reply.code(403).send({ error: "organization editor role required" });
    const { projectId } = request.params;
    const exists = await pool.query("SELECT id FROM projects WHERE organization_id=$1 AND id=$2", [orgId, projectId]);
    if (!exists.rowCount) return reply.code(404).send({ error: "project not found" });
    const body = asObject(request.body);
    if (body.providerConsent !== true) return reply.code(400).send({ error: "explicit consent to send these images to Groq is required" });
    const apiKey = groqApiKey;
    if (!apiKey) return reply.code(503).send({ error: "visual review is not configured on this server" });
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
      return reply.code(400).send({ error: "idempotency-key header (8 to 128 safe characters) is required" });
    }
    let image;
    let imagePixels;
    let referenceImage;
    let referencePixels;
    try {
      const current = decodePngBase64(body.imageBase64, "current screenshot");
      image = current.bytes;
      imagePixels = current.pixels;
      if (body.referenceImageBase64 !== undefined) {
        const reference = decodePngBase64(body.referenceImageBase64, "reference screenshot");
        referenceImage = reference.bytes;
        referencePixels = reference.pixels;
      }
    } catch (decodeError) { return reply.code(400).send({ error: decodeError.message }); }
    if (referenceImage && (typeof body.criteria !== "string" || !body.criteria.trim() || body.criteria.trim().length > 1200)) {
      return reply.code(400).send({ error: "a reference screenshot requires explicit criteria of 1 to 1200 characters" });
    }
    if (!referenceImage && body.criteria !== undefined) return reply.code(400).send({ error: "criteria can only be sent with a reference screenshot" });
    if (referencePixels && (imagePixels.width !== referencePixels.width || imagePixels.height !== referencePixels.height)) return reply.code(400).send({ error: "reference and current screenshots must have matching dimensions" });
    let sourceArtifact = null;
    if (body.sourceArtifact !== undefined) {
      const source = asObject(body.sourceArtifact);
      if (Object.keys(source).length !== 2 || typeof source.runId !== "string" || !UUID.test(source.runId) || typeof source.artifactId !== "string" || !UUID.test(source.artifactId)) {
        return reply.code(400).send({ error: "sourceArtifact must identify a run and artifact from this project" });
      }
      const sourceResult = await pool.query(
        "SELECT a.sha256,regexp_replace(a.object_key,'^.*/','') AS \"artifactName\" FROM artifacts a JOIN runs r ON r.organization_id=a.organization_id AND r.id=a.run_id WHERE a.organization_id=$1 AND r.project_id=$2 AND r.id=$3 AND a.id=$4 AND a.media_type='image/png' AND r.status='completed' AND r.retention_expires_at>now()",
        [orgId, projectId, source.runId, source.artifactId],
      );
      if (!sourceResult.rowCount) return reply.code(404).send({ error: "source screenshot artifact not found in this project" });
      const storedArtifact = sourceResult.rows[0];
      const actualSha256 = createHash("sha256").update(image).digest("hex");
      if (storedArtifact.sha256 !== actualSha256) return reply.code(409).send({ error: "source screenshot bytes do not match the selected run artifact" });
      sourceArtifact = { runId: source.runId, artifactId: source.artifactId, artifactName: storedArtifact.artifactName };
    }
    const requestSha256 = createHash("sha256").update(JSON.stringify({
      imageSha256: createHash("sha256").update(image).digest("hex"),
      referenceSha256: referenceImage ? createHash("sha256").update(referenceImage).digest("hex") : null,
      criteria: body.criteria ?? null,
      sourceArtifact: sourceArtifact ? { runId: sourceArtifact.runId, artifactId: sourceArtifact.artifactId } : null,
    })).digest("hex");
    return withIdempotencyLock(visualReviewLocks, idempotencyPool, `${orgId}:${idempotencyKey}`, async () => {
      const duplicate = await pool.query("SELECT id,project_id AS \"projectId\",request_sha256 AS \"requestSha256\",status,result,error,retention_expires_at>now() AS active FROM visual_reviews WHERE organization_id=$1 AND idempotency_key=$2", [orgId, idempotencyKey]);
      if (duplicate.rowCount) {
        const previous = duplicate.rows[0];
        if (previous.active === false) return reply.code(410).send({ error: "this idempotent visual review has expired" });
        if (previous.projectId !== projectId || previous.requestSha256 !== requestSha256) return reply.code(409).send({ error: "idempotency-key was already used for a different visual review" });
        return reply.code(200).send({ review: previous });
      }
      const quota = await pool.query(
        "INSERT INTO visual_review_usage(organization_id,usage_date,request_count) VALUES($1,(now() AT TIME ZONE 'UTC')::date,1) ON CONFLICT(organization_id,usage_date) DO UPDATE SET request_count=visual_review_usage.request_count+1 WHERE visual_review_usage.request_count < $2 RETURNING request_count",
        [orgId, visualReviewDailyLimit],
      );
      if (!quota.rowCount) return reply.code(429).send({ error: `this organization has reached the daily visual review limit (${visualReviewDailyLimit})` });

      const pixelComparison = referencePixels ? {
        ...diffImages(referencePixels, imagePixels),
        channelTolerance: 6,
        basis: "deterministic RGBA pixel threshold plus coarse 16x16 luminance similarity; visual evidence only",
        verdictEffect: "none",
      } : null;
      const requestedModel = process.env.ATLAS_GROQ_VISION_MODEL ?? GROQ_VISION_MODEL_DEFAULT;
      let result;
      let failure;
      try {
        result = await visualReviewer({
          image,
          ...(referenceImage ? { referenceImage, criteria: body.criteria } : {}),
          profileId: "studio-component",
          checkpointId: "user-upload",
          apiKey,
          model: requestedModel,
        });
      } catch (providerError) { failure = safeProviderError(providerError); }
      const screenshotSha256 = createHash("sha256").update(image).digest("hex");
      const referenceSha256 = referenceImage ? createHash("sha256").update(referenceImage).digest("hex") : null;
      const report = {
        ...(result ?? {
        provider: "groq", requestedModel, returnedModel: null, profileId: "studio-component", checkpointId: "user-upload",
        imageSha256: screenshotSha256, referenceSha256, criteria: referenceImage ? body.criteria.trim() : null,
        issues: [], verdictEffect: "none", confidenceNote: "No model result is available; this is inconclusive, not a visual pass.",
        }),
        pixelComparison,
      };
      const status = failure ? "inconclusive" : "complete";
      const reviewId = newId();
      const record = await inTransaction(pool, async (client) => {
        const inserted = await client.query(
          "INSERT INTO visual_reviews(id,organization_id,project_id,status,provider,requested_model,returned_model,request_sha256,screenshot_sha256,reference_sha256,idempotency_key,result,error,requested_by,retention_expires_at,source_run_id,source_artifact_id,source_artifact_name) VALUES($1,$2,$3,$4,'groq',$5,$6,$7,$8,$9,$10,$11,$12,$13,now()+interval '30 days',$14,$15,$16) RETURNING id,project_id AS \"projectId\",request_sha256 AS \"requestSha256\",status,result,error,source_run_id AS \"sourceRunId\",source_artifact_id AS \"sourceArtifactId\",source_artifact_name AS \"sourceArtifactName\",created_at AS \"createdAt\"",
          [reviewId, orgId, projectId, status, requestedModel, report.returnedModel, requestSha256, screenshotSha256, referenceSha256, idempotencyKey, report, failure ?? null, user.id, sourceArtifact?.runId ?? null, sourceArtifact?.artifactId ?? null, sourceArtifact?.artifactName ?? null],
        );
        await audit(client, orgId, user.id, status === "complete" ? "visual-review.completed" : "visual-review.inconclusive", "visual-review", reviewId, { screenshotSha256, referenceSha256, sourceRunId: sourceArtifact?.runId ?? null, sourceArtifactId: sourceArtifact?.artifactId ?? null, provider: "groq", requestedModel, egressConsent: true });
        return inserted.rows[0];
      });
      return reply.code(201).send({ review: record });
    });
  });

  app.put("/v1/projects/:projectId/visual-reviews/:reviewId/findings/:findingIndex/disposition", async (request, reply) => {
    const { user, orgId, role, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    if (!canWrite(role)) return reply.code(403).send({ error: "organization editor role required" });
    const { projectId, reviewId } = request.params;
    const findingIndex = Number(request.params.findingIndex);
    if (!UUID.test(projectId) || !UUID.test(reviewId) || !Number.isSafeInteger(findingIndex) || findingIndex < 0 || findingIndex > 4) {
      return reply.code(400).send({ error: "project, review, and finding identifiers are invalid" });
    }
    const body = asObject(request.body);
    const allowedDispositions = new Set(["confirmed", "accepted-risk", "false-positive", "needs-follow-up"]);
    if (body.disposition !== null && !allowedDispositions.has(body.disposition)) {
      return reply.code(400).send({ error: "disposition must be confirmed, accepted-risk, false-positive, needs-follow-up, or null to clear" });
    }
    const reviewed = await pool.query(
      "SELECT status,result FROM visual_reviews WHERE organization_id=$1 AND project_id=$2 AND id=$3 AND retention_expires_at>now()",
      [orgId, projectId, reviewId],
    );
    if (!reviewed.rowCount) return reply.code(404).send({ error: "visual review not found" });
    if (reviewed.rows[0].status !== "complete") return reply.code(409).send({ error: "inconclusive visual reviews cannot receive finding dispositions" });
    const issues = reviewed.rows[0].result?.issues;
    if (!Array.isArray(issues) || findingIndex >= issues.length) return reply.code(404).send({ error: "visual finding not found" });

    const outcome = await inTransaction(pool, async (client) => {
      const parent = await client.query("SELECT id FROM visual_reviews WHERE organization_id=$1 AND project_id=$2 AND id=$3 AND retention_expires_at>now() FOR UPDATE", [orgId, projectId, reviewId]);
      if (!parent.rowCount) return { disposition: null, changed: false, missing: true };
      const current = await client.query(
        "SELECT disposition FROM visual_finding_dispositions WHERE organization_id=$1 AND visual_review_id=$2 AND finding_index=$3 FOR UPDATE",
        [orgId, reviewId, findingIndex],
      );
      const previous = current.rows[0]?.disposition ?? null;
      if (previous === body.disposition) return { disposition: previous, changed: false };
      if (body.disposition === null) {
        await client.query(
          "DELETE FROM visual_finding_dispositions WHERE organization_id=$1 AND visual_review_id=$2 AND finding_index=$3",
          [orgId, reviewId, findingIndex],
        );
      } else {
        await client.query(
          "INSERT INTO visual_finding_dispositions(organization_id,visual_review_id,finding_index,disposition,actor_user_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,visual_review_id,finding_index) DO UPDATE SET disposition=EXCLUDED.disposition,actor_user_id=EXCLUDED.actor_user_id,updated_at=now()",
          [orgId, reviewId, findingIndex, body.disposition, user.id],
        );
      }
      await audit(client, orgId, user.id, body.disposition === null ? "visual-finding.disposition-cleared" : "visual-finding.disposition-set", "visual-review", reviewId, { findingIndex, previousDisposition: previous, disposition: body.disposition });
      return { disposition: body.disposition, changed: true };
    });
    if (outcome.missing) return reply.code(404).send({ error: "visual review not found" });
    return { reviewId, findingIndex, disposition: outcome.disposition, changed: outcome.changed, verdictEffect: "none" };
  });

  app.post("/v1/projects/:projectId/visual-reviews/:reviewId/code-proposals", async (request, reply) => {
    const { user, orgId, role, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    if (!canWrite(role)) return reply.code(403).send({ error: "organization editor role required" });
    const { projectId, reviewId } = request.params;
    const body = asObject(request.body);
    if (body.sourceConsent !== true) return reply.code(400).send({ error: "explicit consent to send this source file to Groq is required" });
    const apiKey = groqApiKey;
    if (!apiKey) return reply.code(503).send({ error: "code proposal is not configured on this server" });
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
      return reply.code(400).send({ error: "idempotency-key header (8 to 128 safe characters) is required" });
    }
    if (typeof body.fileName !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(body.fileName) || body.fileName === "." || body.fileName === ".." || !/\.(css|html|js|jsx|mjs|svelte|ts|tsx|vue)$/i.test(body.fileName)) {
      return reply.code(400).send({ error: "choose a supported component source file with a simple file name" });
    }
    if (typeof body.source !== "string" || !body.source.trim() || Buffer.byteLength(body.source, "utf8") > CODE_SOURCE_LIMIT_BYTES) {
      return reply.code(400).send({ error: "source must be non-empty UTF-8 text no larger than 64 KiB" });
    }
    if (body.task !== undefined && (typeof body.task !== "string" || body.task.trim().length > 1200)) return reply.code(400).send({ error: "code task must be text no longer than 1200 characters" });
    if (containsCredentialLikeText(body.source)) return reply.code(400).send({ error: "source contains common credential-like material; remove secrets before requesting a proposal" });
    const sourceSha256 = createHash("sha256").update(body.source, "utf8").digest("hex");
    const reviewed = await pool.query("SELECT id,status,result FROM visual_reviews WHERE organization_id=$1 AND project_id=$2 AND id=$3 AND retention_expires_at>now()", [orgId, projectId, reviewId]);
    if (!reviewed.rowCount) return reply.code(404).send({ error: "visual review not found" });
    if (reviewed.rows[0].status !== "complete") return reply.code(409).send({ error: "an inconclusive visual review cannot drive a code proposal" });
    let findings;
    try { findings = validateVisualIssues({ issues: reviewed.rows[0].result?.issues }).slice(0, 10); }
    catch { return reply.code(409).send({ error: "visual review contains no usable, validated findings" }); }
    if (!findings.length) return reply.code(409).send({ error: "visual review contains no findings to address" });
    const task = typeof body.task === "string" ? body.task.trim() : undefined;
    const requestSha256 = createHash("sha256").update(JSON.stringify({ reviewId, fileName: body.fileName, sourceSha256, task: task ?? null })).digest("hex");
    return withIdempotencyLock(codeProposalLocks, idempotencyPool, `${orgId}:${idempotencyKey}`, async () => {
      const duplicate = await pool.query("SELECT id,project_id AS \"projectId\",visual_review_id AS \"visualReviewId\",request_sha256 AS \"requestSha256\",status,result,error,retention_expires_at>now() AS active FROM code_proposals WHERE organization_id=$1 AND idempotency_key=$2", [orgId, idempotencyKey]);
      if (duplicate.rowCount) {
        const previous = duplicate.rows[0];
        if (previous.active === false) return reply.code(410).send({ error: "this idempotent code proposal has expired" });
        if (previous.projectId !== projectId || previous.visualReviewId !== reviewId || previous.requestSha256 !== requestSha256) return reply.code(409).send({ error: "idempotency-key was already used for a different code proposal" });
        return reply.code(200).send({ proposal: previous });
      }
      const quota = await pool.query(
        "INSERT INTO code_proposal_usage(organization_id,usage_date,request_count) VALUES($1,(now() AT TIME ZONE 'UTC')::date,1) ON CONFLICT(organization_id,usage_date) DO UPDATE SET request_count=code_proposal_usage.request_count+1 WHERE code_proposal_usage.request_count < $2 RETURNING request_count",
        [orgId, codeProposalDailyLimit],
      );
      if (!quota.rowCount) return reply.code(429).send({ error: `this organization has reached the daily code proposal limit (${codeProposalDailyLimit})` });

      const requestedModel = process.env.ATLAS_GROQ_CODE_MODEL ?? GROQ_CODE_MODEL_DEFAULT;
      let result;
      let failure;
      try {
        result = await codeProposer({
          source: body.source,
          fileName: body.fileName,
          findings: JSON.stringify(findings),
          ...(task ? { task } : {}),
          apiKey,
          model: requestedModel,
          consentToSendCode: true,
        });
      } catch (providerError) { failure = safeCodeProviderError(providerError); }
      const proposalResult = result ?? {
        provider: "groq", requestedModel, returnedModel: null, fileName: body.fileName, sourceSha256,
        summary: "No code proposal is available because model review was inconclusive.", unifiedDiff: "",
        status: "inconclusive", applied: false, testsRun: false, verdictEffect: "none",
        limitations: ["The source was not retained by Atlas.", "No patch was applied or tested."],
      };
      const proposal = {
        kind: "atlas.code-proposal", schemaVersion: 1, generatedAtIso: new Date().toISOString(),
        visualReviewId: reviewId, sourceConsent: { provider: "groq", explicitlyConfirmed: true },
        ...proposalResult,
      };
      const proposalId = newId();
      const record = await inTransaction(pool, async (client) => {
        const inserted = await client.query(
          "INSERT INTO code_proposals(id,organization_id,project_id,visual_review_id,status,provider,requested_model,returned_model,file_name,source_sha256,request_sha256,idempotency_key,result,error,requested_by,retention_expires_at) VALUES($1,$2,$3,$4,$5,'groq',$6,$7,$8,$9,$10,$11,$12,$13,$14,now()+interval '30 days') RETURNING id,visual_review_id AS \"visualReviewId\",status,provider,requested_model AS \"requestedModel\",returned_model AS \"returnedModel\",file_name AS \"fileName\",source_sha256 AS \"sourceSha256\",result,error,created_at AS \"createdAt\"",
          [proposalId, orgId, projectId, reviewId, failure ? "inconclusive" : proposal.status, requestedModel, proposal.returnedModel, body.fileName, sourceSha256, requestSha256, idempotencyKey, proposal, failure ?? null, user.id],
        );
        await audit(client, orgId, user.id, failure ? "code-proposal.inconclusive" : "code-proposal.created", "code-proposal", proposalId, { visualReviewId: reviewId, fileName: body.fileName, sourceSha256, requestedModel, sourceEgressConsent: true });
        return inserted.rows[0];
      });
      return reply.code(201).send({ proposal: record });
    });
  });

  app.post("/v1/projects/:projectId/targets", async (request, reply) => {
    const { user, orgId, role, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    if (!canWrite(role)) return reply.code(403).send({ error: "organization editor role required" });
    const { projectId } = request.params;
    const body = asObject(request.body);
    const validation = validateTargetContract(body.contract);
    if (!validation.ok) return reply.code(400).send({ error: "invalid target contract", issues: validation.issues });
    let parsed;
    try { parsed = parseOwnedTargetUrl(validation.contract.target.url); }
    catch (e) { return reply.code(400).send({ error: e.message }); }
    const allowed = validation.contract.target.allowedOrigins;
    if (allowed.some((origin) => new URL(origin).protocol !== "https:")) return reply.code(400).send({ error: "hosted allowedOrigins must all use HTTPS" });
    try {
      const addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
      if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) return reply.code(400).send({ error: "target DNS must resolve only to public addresses" });
    } catch (e) {
      if (e?.statusCode) throw e;
      return reply.code(400).send({ error: "target hostname could not be resolved safely" });
    }
    const exists = await pool.query("SELECT 1 FROM projects WHERE organization_id=$1 AND id=$2", [orgId, projectId]);
    if (!exists.rowCount) return reply.code(404).send({ error: "project not found" });
    const id = newId();
    const verificationToken = `atlas-verify=${newSecret(24)}`;
    const contract = { ...validation.contract, target: { ...validation.contract.target, url: parsed.url.href } };
    await inTransaction(pool, async (client) => {
      await client.query("INSERT INTO targets(id,organization_id,project_id,base_url,hostname,verification_token,contract,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, orgId, projectId, parsed.url.href, parsed.hostname, verificationToken, contract, user.id]);
      await audit(client, orgId, user.id, "target.created", "target", id, { hostname: parsed.hostname });
    });
    return reply.code(201).send({ target: { id, baseUrl: parsed.url.href, verified: false }, dnsVerification: { recordName: `_atlas-verify.${parsed.hostname}`, recordType: "TXT", value: verificationToken } });
  });

  app.post("/v1/targets/:targetId/verify", async (request, reply) => {
    const { user, orgId, role, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    if (!canWrite(role)) return reply.code(403).send({ error: "organization editor role required" });
    const { targetId } = request.params;
    const found = await pool.query("SELECT hostname,verification_token,verified_at FROM targets WHERE organization_id=$1 AND id=$2", [orgId, targetId]);
    const target = found.rows[0];
    if (!target) return reply.code(404).send({ error: "target not found" });
    if (!target.verified_at) {
      try {
        const records = await dns.resolveTxt(`_atlas-verify.${target.hostname}`);
        const verified = records.some((parts) => parts.join("") === target.verification_token);
        if (!verified) return reply.code(409).send({ error: "DNS verification record was not found" });
      } catch { return reply.code(409).send({ error: "DNS verification record could not be read" }); }
      await inTransaction(pool, async (client) => {
        await client.query("UPDATE targets SET verified_at=now() WHERE organization_id=$1 AND id=$2", [orgId, targetId]);
        await audit(client, orgId, user.id, "target.verified", "target", targetId);
      });
    }
    return { targetId, verified: true };
  });

  app.post("/v1/targets/:targetId/runs", async (request, reply) => {
    const { user, orgId, role, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    if (!canWrite(role)) return reply.code(403).send({ error: "organization editor role required" });
    const { targetId } = request.params;
    const found = await pool.query("SELECT project_id,contract,verified_at FROM targets WHERE organization_id=$1 AND id=$2", [orgId, targetId]);
    const target = found.rows[0];
    if (!target) return reply.code(404).send({ error: "target not found" });
    if (!target.verified_at) return reply.code(409).send({ error: "verify target ownership before queueing a run" });
    if (target.contract.target?.allowedOrigins?.some((origin) => { try { const parsed = new URL(origin); return parsed.protocol !== "https:" || (parsed.port && parsed.port !== "443"); } catch { return true; } })) {
      return reply.code(400).send({ error: "local isolated workers currently support HTTPS origins on port 443 only" });
    }
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
      return reply.code(400).send({ error: "idempotency-key header (8 to 128 safe characters) is required" });
    }
    const binding = buildBinding({
      contract: target.contract,
      policy: policyStamp(),
      engine: { name: "RuleBasedDecisionEngine", version: process.env.ATLAS_ENGINE_VERSION ?? "0.1.0" },
    });
    const bindingCheck = requireImmutableBuild(binding);
    if (!bindingCheck.ok) return reply.code(409).send({ error: "target is not bound to immutable release evidence", issues: bindingCheck.issues });
    const id = newId();
    const queued = await inTransaction(pool, async (client) => {
      const inserted = await client.query("INSERT INTO runs(id,organization_id,project_id,target_id,status,contract_version,contract_snapshot,binding_snapshot,requested_by,idempotency_key,retention_expires_at) VALUES($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9,now()+interval '30 days') ON CONFLICT (organization_id,idempotency_key) DO NOTHING RETURNING id,target_id AS \"targetId\",status,verdict,binding_snapshot AS binding", [id, orgId, target.project_id, targetId, String(target.contract.schemaVersion), target.contract, binding, user.id, idempotencyKey]);
      if (!inserted.rowCount) {
        const existing = await client.query("SELECT id,target_id AS \"targetId\",status,verdict,binding_snapshot AS binding FROM runs WHERE organization_id=$1 AND idempotency_key=$2", [orgId, idempotencyKey]);
        return { run: existing.rows[0], created: false, conflict: existing.rows[0]?.targetId !== targetId };
      }
      await audit(client, orgId, user.id, "run.queued", "run", id, { targetId, bindingHash: binding.bindingHash });
      return { run: inserted.rows[0], created: true, conflict: false };
    });
    if (queued.conflict) return reply.code(409).send({ error: "idempotency-key was already used for a different target" });
    return reply.code(queued.created ? 202 : 200).send({ run: { ...queued.run, message: "Run queued. A separately started local Docker worker is required; this API process does not launch browsers." } });
  });

  app.get("/v1/runs/:runId", async (request, reply) => {
    const { orgId, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    const { runId } = request.params;
    const found = await pool.query("SELECT id,status,verdict,error_code AS \"errorCode\",contract_version AS \"contractVersion\",created_at AS \"createdAt\",started_at AS \"startedAt\",finished_at AS \"finishedAt\",contract_snapshot AS contract,binding_snapshot AS binding,result_snapshot AS result FROM runs WHERE organization_id=$1 AND id=$2", [orgId, runId]);
    if (!found.rowCount) return reply.code(404).send({ error: "run not found" });
    const artifacts = await pool.query("SELECT id,media_type AS \"mediaType\",byte_length AS \"byteLength\",sha256,created_at AS \"createdAt\" FROM artifacts WHERE organization_id=$1 AND run_id=$2 ORDER BY created_at", [orgId, runId]);
    return { run: found.rows[0], artifacts: artifacts.rows.map((artifact) => ({ ...artifact, url: `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}` })), evidenceStatus: found.rows[0].result ? "captured" : found.rows[0].status === "queued" || found.rows[0].status === "running" ? "pending" : "absent" };
  });

  app.post("/v1/runs/:runId/cancel", async (request, reply) => {
    const { user, orgId, role, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    if (!canWrite(role)) return reply.code(403).send({ error: "organization editor role required" });
    const { runId } = request.params;
    if (!UUID.test(runId)) return reply.code(404).send({ error: "run not found" });
    const outcome = await inTransaction(pool, async (client) => {
      const found = await client.query("SELECT status,cancel_requested_at FROM runs WHERE organization_id=$1 AND id=$2 FOR UPDATE", [orgId, runId]);
      if (!found.rowCount) return { missing: true };
      const run = found.rows[0];
      if (run.status === "queued") {
        await client.query("UPDATE runs SET status='cancelled',finished_at=now() WHERE organization_id=$1 AND id=$2 AND status='queued'", [orgId, runId]);
        await audit(client, orgId, user.id, "run.cancelled", "run", runId, { phase: "queued" });
        return { status: "cancelled" };
      }
      if (run.status === "running") {
        if (!run.cancel_requested_at) {
          await client.query("UPDATE runs SET cancel_requested_at=now() WHERE organization_id=$1 AND id=$2 AND status='running'", [orgId, runId]);
          await audit(client, orgId, user.id, "run.cancel.requested", "run", runId, { phase: "running" });
        }
        return { status: "running", cancellationRequested: true };
      }
      return { conflict: true, status: run.status };
    });
    if (outcome.missing) return reply.code(404).send({ error: "run not found" });
    if (outcome.conflict) return reply.code(409).send({ error: `run cannot be cancelled after it is ${outcome.status}` });
    return { runId, ...outcome };
  });

  app.post("/v1/runs/:runId/share-links", async (request, reply) => {
    const { user, orgId, role, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    if (!canWrite(role)) return reply.code(403).send({ error: "organization editor role required" });
    const { runId } = request.params;
    if (!UUID.test(runId)) return reply.code(404).send({ error: "run not found" });
    const body = asObject(request.body);
    if (body.includeSummary !== true) return reply.code(400).send({ error: "explicit consent to share the run summary is required" });
    const expiresInHours = body.expiresInHours;
    if (![24, 168, 720].includes(expiresInHours)) return reply.code(400).send({ error: "expiresInHours must be 24, 168, or 720" });
    const artifactIds = body.artifactIds ?? [];
    if (!Array.isArray(artifactIds) || artifactIds.length > 20 || artifactIds.some((id) => typeof id !== "string" || !UUID.test(id)) || new Set(artifactIds).size !== artifactIds.length) {
      return reply.code(400).send({ error: "artifactIds must contain at most 20 distinct artifact IDs" });
    }
    const created = await inTransaction(pool, async (client) => {
      const run = await client.query("SELECT id,status,result_snapshot AS result,retention_expires_at AS \"retentionExpiresAt\" FROM runs WHERE organization_id=$1 AND id=$2 AND retention_expires_at>now() FOR SHARE", [orgId, runId]);
      if (!run.rowCount) return { missing: true };
      if (!run.rows[0].result || ["queued", "running"].includes(run.rows[0].status)) return { pending: true };
      if (artifactIds.length) {
        const found = await client.query("SELECT id FROM artifacts WHERE organization_id=$1 AND run_id=$2 AND id=ANY($3::uuid[])", [orgId, runId, artifactIds]);
        if (found.rowCount !== artifactIds.length) return { invalidArtifacts: true };
      }
      const id = newId();
      const token = newSecret(32);
      const inserted = await client.query(
        "INSERT INTO share_links(id,organization_id,run_id,token_hash,expires_at,created_by,include_summary,artifact_scope) VALUES($1,$2,$3,$4,LEAST(now()+($5::int*interval '1 hour'),$8::timestamptz),$6,true,$7::jsonb) RETURNING id,expires_at AS \"expiresAt\",created_at AS \"createdAt\"",
        [id, orgId, runId, hashToken(token), expiresInHours, user.id, JSON.stringify(artifactIds), run.rows[0].retentionExpiresAt],
      );
      await audit(client, orgId, user.id, "share-link.created", "share-link", id, { runId, includeSummary: true, artifactIds, expiresInHours });
      const shareUrl = new URL("/", appOrigin);
      shareUrl.hash = `share=${token}`;
      return { share: inserted.rows[0], token, url: shareUrl.href };
    });
    if (created.missing) return reply.code(404).send({ error: "run not found" });
    if (created.pending) return reply.code(409).send({ error: "only a run with completed evidence can be shared" });
    if (created.invalidArtifacts) return reply.code(400).send({ error: "one or more selected artifacts do not belong to this run" });
    return reply.code(201).send({ share: created.share, url: created.url });
  });

  app.post("/v1/runs/:runId/share-links/:shareId/revoke", async (request, reply) => {
    const { user, orgId, role, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    if (!canWrite(role)) return reply.code(403).send({ error: "organization editor role required" });
    const { runId, shareId } = request.params;
    if (!UUID.test(runId) || !UUID.test(shareId)) return reply.code(404).send({ error: "share link not found" });
    const revoked = await inTransaction(pool, async (client) => {
      const row = await client.query("UPDATE share_links SET revoked_at=COALESCE(revoked_at,now()) WHERE organization_id=$1 AND run_id=$2 AND id=$3 RETURNING id,revoked_at AS \"revokedAt\"", [orgId, runId, shareId]);
      if (!row.rowCount) return null;
      await audit(client, orgId, user.id, "share-link.revoked", "share-link", shareId, { runId });
      return row.rows[0];
    });
    if (!revoked) return reply.code(404).send({ error: "share link not found" });
    return { share: revoked };
  });

  app.post("/v1/shared-reports/open", { bodyLimit: 4096 }, async (request, reply) => {
    const token = asObject(request.body).token;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return reply.code(404).send({ error: "shared report not found or expired" });
    const report = await inTransaction(pool, async (client) => {
      const found = await client.query(
        "SELECT s.id AS \"shareId\",s.organization_id AS \"organizationId\",s.run_id AS \"runId\",s.expires_at AS \"expiresAt\",s.artifact_scope AS \"artifactIds\",s.include_summary AS \"includeSummary\",r.status,r.verdict,r.created_at AS \"createdAt\",r.finished_at AS \"finishedAt\",r.result_snapshot AS result FROM share_links s JOIN runs r ON r.organization_id=s.organization_id AND r.id=s.run_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND r.retention_expires_at>now() FOR UPDATE OF s",
        [hashToken(token)],
      );
      if (!found.rowCount) return null;
      const row = found.rows[0];
      const allowed = await consumeSharedReportRequest(client, row.shareId, sharedReportRateLimitPerMinute);
      if (!allowed) return { throttled: true };
      const artifacts = row.artifactIds.length ? await client.query("SELECT id,media_type AS \"mediaType\",byte_length AS \"byteLength\",sha256,regexp_replace(object_key,'^.*/','') AS name FROM artifacts WHERE organization_id=$1 AND run_id=$2 AND id=ANY($3::uuid[]) ORDER BY object_key", [row.organizationId, row.runId, row.artifactIds]) : { rows: [] };
      await client.query("UPDATE share_links SET access_count=access_count+1,last_accessed_at=now() WHERE id=$1", [row.shareId]);
      await audit(client, row.organizationId, null, "share-link.opened", "share-link", row.shareId, { runId: row.runId });
      return { share: { id: row.shareId, expiresAt: row.expiresAt }, run: row.includeSummary ? { id: row.runId, status: row.status, verdict: row.verdict, createdAt: row.createdAt, finishedAt: row.finishedAt, result: row.result } : null, artifacts: artifacts.rows };
    });
    if (report?.throttled) return reply.header("retry-after", "60").code(429).send({ error: "shared report access limit reached; retry in about one minute" });
    if (!report) return reply.code(404).send({ error: "shared report not found or expired" });
    return report;
  });

  app.post("/v1/shared-reports/artifact", { bodyLimit: 4096 }, async (request, reply) => {
    const body = asObject(request.body);
    if (typeof body.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token) || typeof body.artifactId !== "string" || !UUID.test(body.artifactId)) return reply.code(404).send({ error: "shared artifact not found or expired" });
    const share = await inTransaction(pool, async (client) => {
      const found = await client.query(
        "SELECT s.id AS \"shareId\",s.organization_id AS \"organizationId\",s.run_id AS \"runId\" FROM share_links s JOIN runs r ON r.organization_id=s.organization_id AND r.id=s.run_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND r.retention_expires_at>now() AND s.artifact_scope @> jsonb_build_array($2::text) FOR UPDATE OF s",
        [hashToken(body.token), body.artifactId],
      );
      if (!found.rowCount) return null;
      const row = found.rows[0];
      const allowed = await consumeSharedReportRequest(client, row.shareId, sharedReportRateLimitPerMinute);
      return allowed ? row : { throttled: true };
    });
    if (share?.throttled) return reply.header("retry-after", "60").code(429).send({ error: "shared report access limit reached; retry in about one minute" });
    if (!share) return reply.code(404).send({ error: "shared artifact not found or expired" });
    const row = share;
    const result = await pool.query("SELECT object_key,media_type,byte_length,sha256 FROM artifacts WHERE organization_id=$1 AND run_id=$2 AND id=$3", [row.organizationId, row.runId, body.artifactId]);
    if (!result.rowCount || !artifactRoot || !path.isAbsolute(artifactRoot)) return reply.code(404).send({ error: "shared artifact not found or expired" });
    const artifact = result.rows[0];
    const pieces = artifact.object_key.split("/");
    if (pieces[0] !== row.runId || pieces.length < 2 || pieces.some((piece) => !piece || piece === "." || piece === ".." || !/^[A-Za-z0-9._-]+$/.test(piece))) return reply.code(404).send({ error: "shared artifact not found or expired" });
    const root = path.resolve(artifactRoot);
    const filePath = path.resolve(root, ...pieces);
    if (!filePath.startsWith(`${root}${path.sep}`)) return reply.code(404).send({ error: "shared artifact not found or expired" });
    try {
      const file = await lstat(filePath);
      if (!file.isFile() || file.isSymbolicLink() || file.size !== Number(artifact.byte_length)) return reply.code(410).send({ error: "shared artifact integrity check failed" });
      const bytes = await readFile(filePath);
      if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) return reply.code(410).send({ error: "shared artifact integrity check failed" });
      await inTransaction(pool, async (client) => {
        const active = await client.query("SELECT id FROM share_links WHERE id=$1 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE", [row.shareId]);
        if (!active.rowCount) return;
        await client.query("UPDATE share_links SET access_count=access_count+1,last_accessed_at=now() WHERE id=$1", [row.shareId]);
        await audit(client, row.organizationId, null, "share-link.artifact-downloaded", "share-link", row.shareId, { runId: row.runId, artifactId: body.artifactId, sha256: artifact.sha256 });
      });
      const stillActive = await pool.query("SELECT revoked_at IS NULL AND expires_at>now() AS active FROM share_links WHERE id=$1", [row.shareId]);
      if (!stillActive.rows[0]?.active) return reply.code(404).send({ error: "shared artifact not found or expired" });
      reply.header("content-type", artifact.media_type);
      reply.header("content-length", String(bytes.length));
      reply.header("content-disposition", `attachment; filename=\"${pieces.at(-1)}\"`);
      reply.header("content-security-policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'");
      reply.header("x-content-type-options", "nosniff");
      return reply.send(bytes);
    } catch (readError) {
      if (readError?.code === "ENOENT") return reply.code(410).send({ error: "shared artifact is no longer available" });
      throw readError;
    }
  });

  app.get("/v1/runs/:runId/artifacts/:artifactId", async (request, reply) => {
    const { user, orgId, error } = await organizationContext(request, pool);
    if (error) return reply.code(error.status).send({ error: error.message });
    if (!artifactRoot || !path.isAbsolute(artifactRoot)) return reply.code(503).send({ error: "local run artifacts are not configured" });
    const { runId, artifactId } = request.params;
    if (!UUID.test(runId) || !UUID.test(artifactId)) return reply.code(404).send({ error: "artifact not found" });
    const result = await pool.query("SELECT a.object_key,a.media_type,a.byte_length,a.sha256 FROM artifacts a JOIN runs r ON r.organization_id=a.organization_id AND r.id=a.run_id WHERE a.organization_id=$1 AND r.id=$2 AND a.id=$3", [orgId, runId, artifactId]);
    if (!result.rowCount) return reply.code(404).send({ error: "artifact not found" });
    const artifact = result.rows[0];
    const pieces = artifact.object_key.split("/");
    if (pieces[0] !== runId || pieces.length < 2 || pieces.some((piece) => !piece || piece === "." || piece === ".." || !/^[A-Za-z0-9._-]+$/.test(piece))) return reply.code(404).send({ error: "artifact not found" });
    const root = path.resolve(artifactRoot);
    const filePath = path.resolve(root, ...pieces);
    if (!filePath.startsWith(`${root}${path.sep}`)) return reply.code(404).send({ error: "artifact not found" });
    try {
      const file = await lstat(filePath);
      if (!file.isFile() || file.isSymbolicLink()) return reply.code(404).send({ error: "artifact not found" });
      if (file.size !== Number(artifact.byte_length)) return reply.code(410).send({ error: "artifact integrity check failed" });
      const bytes = await readFile(filePath);
      if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) return reply.code(410).send({ error: "artifact integrity check failed" });
      await pool.query("INSERT INTO audit_events(organization_id,actor_user_id,action,resource_type,resource_id,details) VALUES($1,$2,'artifact.downloaded','run',$3,$4)", [orgId, user.id, runId, { artifactId, sha256: artifact.sha256 }]);
      reply.header("content-type", artifact.media_type);
      reply.header("content-length", String(bytes.length));
      reply.header("content-disposition", `attachment; filename="${pieces.at(-1)}"`);
      reply.header("content-security-policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'");
      reply.header("x-content-type-options", "nosniff");
      return reply.send(bytes);
    } catch (readError) {
      if (readError?.code === "ENOENT") return reply.code(410).send({ error: "artifact is no longer available" });
      throw readError;
    }
  });

  if (closePool) app.addHook("onClose", async () => {
    if (idempotencyPool !== pool) await idempotencyPool.end();
    await pool.end();
  });
  return app;
}

async function sessionUser(request, pool) {
  const token = parseCookies(request.headers.cookie).get("atlas_session");
  if (!token || token.length < 32) return null;
  const result = await pool.query("SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()", [hashToken(token)]);
  return result.rows[0] ?? null;
}

async function organizationContext(request, pool) {
  const user = await sessionUser(request, pool);
  if (!user) return { error: { status: 401, message: "authentication required" } };
  const orgId = request.headers["x-atlas-organization"];
  if (typeof orgId !== "string" || !UUID.test(orgId)) return { error: { status: 400, message: "x-atlas-organization header is required" } };
  const member = await pool.query("SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2", [orgId, user.id]);
  if (!member.rowCount) return { error: { status: 404, message: "organization not found" } };
  return { user, orgId, role: member.rows[0].role };
}

function canWrite(role) { return ["owner", "admin", "member"].includes(role); }
function asObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function normalizeEmail(value) { return typeof value === "string" && value.length <= 254 ? value.trim().toLowerCase() : ""; }
function cleanName(value) { return typeof value === "string" && value.trim().length <= 120 ? value.trim() : ""; }
function decodePngBase64(value, label) {
  const maxEncodedLength = Math.ceil(VISUAL_REVIEW_IMAGE_LIMIT_BYTES / 3) * 4;
  if (typeof value !== "string" || !value.length || value.length > maxEncodedLength || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} must be valid base64 PNG data no larger than 10 MiB`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > VISUAL_REVIEW_IMAGE_LIMIT_BYTES || bytes.toString("base64") !== value || bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${label} is not a complete supported PNG within the 10 MiB limit`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > VISUAL_REVIEW_MAX_DIMENSION || height > VISUAL_REVIEW_MAX_DIMENSION || width * height > VISUAL_REVIEW_MAX_PIXELS) {
    throw new Error(`${label} dimensions exceed the visual-review limit`);
  }
  let pixels;
  try { pixels = decodePng(bytes); }
  catch { throw new Error(`${label} is not a supported, complete PNG`); }
  return { bytes, pixels };
}
function safeProviderError(error) {
  const message = error instanceof Error ? error.message : "";
  if (message === "Groq visual review timed out" || message === "Groq visual review request failed; check network and provider availability") return message;
  const status = /^Groq visual review returned HTTP (\d{3})$/.exec(message);
  if (status) return `Groq visual review returned HTTP ${status[1]}`;
  return "Groq visual review returned an invalid or unsupported response";
}
function safeCodeProviderError(error) {
  const message = error instanceof Error ? error.message : "";
  if (message === "Groq code-proposal request timed out" || message === "Groq code-proposal request failed; check network and provider availability") return message;
  const status = /^Groq code proposal returned HTTP (\d{3})$/.exec(message);
  if (status) return `Groq code proposal returned HTTP ${status[1]}`;
  return "Groq code proposal returned an invalid or unsupported response";
}
async function withIdempotencyLock(locks, idempotencyPool, key, callback) {
  const previous = locks.get(key);
  if (previous) await previous;
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(key, current);
  let client;
  let acquired = false;
  let lockParts;
  try {
    if (typeof idempotencyPool?.connect === "function") {
      client = await idempotencyPool.connect();
      const lockHash = createHash("sha256").update(`atlas-idempotency-v1\0${key}`).digest();
      lockParts = [lockHash.readInt32BE(0), lockHash.readInt32BE(4)];
      await client.query("SELECT pg_advisory_lock($1, $2)", lockParts);
      acquired = true;
    }
    return await callback();
  }
  finally {
    let unlockError;
    if (acquired) {
      try { await client.query("SELECT pg_advisory_unlock($1, $2)", lockParts); }
      catch (error) { unlockError = error; }
    }
    client?.release(unlockError);
    if (locks.get(key) === current) locks.delete(key);
    release();
    if (unlockError) throw unlockError;
  }
}
async function audit(client, orgId, userId, action, type, id, details = {}) {
  await client.query("INSERT INTO audit_events(organization_id,actor_user_id,action,resource_type,resource_id,details) VALUES($1,$2,$3,$4,$5,$6)", [orgId, userId, action, type, id, details]);
}

async function consumeSharedReportRequest(client, shareId, limit) {
  const result = await client.query(
    "INSERT INTO shared_report_request_buckets(share_id,bucket_start,request_count) VALUES($1,date_trunc('minute',clock_timestamp()),1) ON CONFLICT(share_id,bucket_start) DO UPDATE SET request_count=shared_report_request_buckets.request_count+1 RETURNING request_count",
    [shareId],
  );
  return result.rows[0].request_count <= limit;
}

const OPENAPI = {
  openapi: "3.1.0", info: { title: "Atlas Control Plane API", version: "0.1.0", description: "Local development control plane with an opt-in Docker worker; it is not a hosted service." },
  servers: [{ url: "http://localhost:3000" }],
  paths: {
    "/v1/auth/register": { post: { summary: "Create account and organization", responses: { "201": { description: "Created" } } } },
    "/v1/auth/login": { post: { summary: "Create a session", responses: { "200": { description: "Authenticated" } } } },
    "/v1/projects": { get: { summary: "List projects in selected organization", responses: { "200": { description: "Project list" } } }, post: { summary: "Create project", responses: { "201": { description: "Created" } } } },
    "/v1/projects/{projectId}/targets": { post: { summary: "Register an HTTPS target and DNS ownership challenge", responses: { "201": { description: "Created" } } } },
    "/v1/projects/{projectId}/visual-reviews": { post: {
      summary: "Compare consented reference/current PNGs deterministically and request separate advisory model review; image bytes are not retained by this route",
      parameters: [{ in: "header", name: "Idempotency-Key", required: true, schema: { type: "string", minLength: 8, maxLength: 128 } }, { in: "header", name: "x-atlas-organization", required: true, schema: { type: "string", format: "uuid" } }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["providerConsent", "imageBase64"], properties: { providerConsent: { const: true }, imageBase64: { type: "string", contentEncoding: "base64", contentMediaType: "image/png", description: "Maximum decoded size 10 MiB; PNG dimensions capped." }, sourceArtifact: { type: "object", required: ["runId", "artifactId"], properties: { runId: { type: "string", format: "uuid" }, artifactId: { type: "string", format: "uuid" } }, description: "Optional exact run screenshot provenance; server verifies same-project PNG identity and SHA-256." }, referenceImageBase64: { type: "string", contentEncoding: "base64", contentMediaType: "image/png" }, criteria: { type: "string", maxLength: 1200 } } } } } },
      responses: { "201": { description: "Advisory review and optional deterministic pixel comparison stored for 30 days" }, "400": { description: "Invalid PNG, dimensions, criteria, or missing egress consent" }, "429": { description: "Daily organization quota reached" }, "503": { description: "Groq model is not configured" } },
    } },
    "/v1/projects/{projectId}/visual-reviews/{reviewId}/findings/{findingIndex}/disposition": { put: {
      summary: "Record or clear an audited human disposition for one advisory finding; never affects release verdict",
      parameters: [{ in: "header", name: "x-atlas-organization", required: true, schema: { type: "string", format: "uuid" } }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["disposition"], properties: { disposition: { type: ["string", "null"], enum: ["confirmed", "accepted-risk", "false-positive", "needs-follow-up", null] } } } } } },
      responses: { "200": { description: "Disposition saved; response explicitly declares verdictEffect none" }, "400": { description: "Unsupported disposition or index" }, "403": { description: "Organization editor role required" }, "404": { description: "Project, review, or finding not found" } },
    } },
    "/v1/projects/{projectId}/visual-reviews/{reviewId}/code-proposals": { post: {
      summary: "Create a separate-consent, single-file code proposal from one completed visual review; never apply or test it",
      parameters: [{ in: "header", name: "Idempotency-Key", required: true, schema: { type: "string", minLength: 8, maxLength: 128 } }, { in: "header", name: "x-atlas-organization", required: true, schema: { type: "string", format: "uuid" } }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["sourceConsent", "fileName", "source"], properties: { sourceConsent: { const: true }, fileName: { type: "string", maxLength: 128 }, source: { type: "string", maxLength: 65536 }, task: { type: "string", maxLength: 1200 } } } } } },
      responses: { "201": { description: "Unapplied, untested proposal stored for 30 days" }, "400": { description: "Invalid source or missing code-egress consent" }, "409": { description: "Review is inconclusive or has no findings" }, "429": { description: "Daily organization quota reached" }, "503": { description: "Groq code model is not configured" } },
    } },
    "/v1/targets/{targetId}/verify": { post: { summary: "Verify DNS TXT ownership", responses: { "200": { description: "Verified" } } } },
    "/v1/targets/{targetId}/runs": { post: { summary: "Queue a run record (Idempotency-Key required)", responses: { "202": { description: "Queued; an explicitly started local Docker worker may process it" }, "200": { description: "Existing idempotent run" } } } },
    "/v1/runs/{runId}": { get: { summary: "Get private run status and artifact metadata", responses: { "200": { description: "Run detail" } } } },
    "/v1/runs/{runId}/share-links": { post: { summary: "Create an expiring client link for an explicitly selected run summary and artifacts; raw token is returned once in a URL fragment", responses: { "201": { description: "Created; client must store the fragment URL" }, "400": { description: "Invalid expiry or artifact scope" }, "409": { description: "Run evidence is still pending" } } } },
    "/v1/runs/{runId}/share-links/{shareId}/revoke": { post: { summary: "Immediately revoke a client report link", responses: { "200": { description: "Revoked" }, "404": { description: "Link not found" } } } },
    "/v1/shared-reports/open": { post: { summary: "Resolve an anonymous client report using a token sent in the JSON body; access is audited", responses: { "200": { description: "Scoped report summary and selected artifact metadata" }, "404": { description: "Invalid, expired, or revoked link" }, "429": { description: "Per-link request limit reached; retry after the supplied interval" } } } },
    "/v1/shared-reports/artifact": { post: { summary: "Download only an artifact explicitly included in an active client link; access is audited and content hash verified", responses: { "200": { description: "Verified artifact bytes" }, "404": { description: "Artifact outside link scope or inactive link" }, "429": { description: "Per-link request limit reached; retry after the supplied interval" } } } },
    "/v1/runs/{runId}/cancel": { post: { summary: "Cancel a queued run or request cancellation of a running local Docker job", responses: { "200": { description: "Cancelled or cancellation requested" }, "409": { description: "Run already completed" } } } },
    "/v1/runs/{runId}/artifacts/{artifactId}": { get: { summary: "Download an organization-scoped local run artifact with integrity verification and audit", responses: { "200": { description: "Artifact bytes" }, "404": { description: "Artifact not found" }, "410": { description: "Artifact expired or integrity check failed" } } } },
  },
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const secureCookies = process.env.NODE_ENV === "production";
  if (secureCookies && !process.env.ATLAS_APP_ORIGIN?.startsWith("https://")) throw new Error("production requires ATLAS_APP_ORIGIN with https://");
  const pool = createPool();
  const idempotencyPool = createPool();
  const app = buildApp({ pool, idempotencyPool, secureCookies, logger: true, closePool: false });
  const port = Number(process.env.PORT ?? 3000);
  const stopMaintenance = startRetentionMaintenance(pool, app.log);
  app.addHook("onClose", stopMaintenance);
  app.addHook("onClose", async () => { await idempotencyPool.end(); await pool.end(); });
  await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
}
