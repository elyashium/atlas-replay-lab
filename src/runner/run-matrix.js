/**
 * The capability matrix — the "one command" of §5.4.
 *
 * Runs each profile in its own browser context against a freshly started
 * control-plane server, captures a trace and checkpoint screenshots per run,
 * has the decision engine judge every captured trace, and writes one
 * `report.json` describing the whole matrix.
 *
 * Two things about how this is scheduled are load-bearing:
 *
 *  - Profiles run **sequentially**, never in parallel. `Emulation.setCPUThrottlingRate`
 *    throttles by making the renderer busy-wait; six throttled renderers on one
 *    machine contend for the same cores, and every timing in the report would
 *    then be a measurement of the host's core count rather than of the profile.
 *    The matrix is slow on purpose.
 *  - The baseline run goes first. It is the same profile as the adaptive
 *    low-CPU/3G run with the router bypassed (`forceTier: "high"`), and it is
 *    the "before" half of the failure story. Running it first means the
 *    adaptive run cannot be accused of having benefited from a warm anything —
 *    though the server also sends `Cache-Control: no-store` on every response,
 *    which is the real guarantee.
 *
 * Isolation between runs is not this file's doing: `connection.newPage()`
 * creates a fresh `Target.createBrowserContext` per run and disposes it on
 * detach, so no cookie, cache entry, service worker or storage bucket survives
 * from one profile to the next. That matters far more for `--url` than for
 * Orbital — a third-party app is entitled to cache twelve megabytes, and the
 * second profile measuring a warm cache would make every byte count in the
 * report a fiction.
 *
 * ## The two modes
 *
 * Without `--url` this runs Orbital: the bundled experience, served by the
 * control plane, routed by the live tier router, driven along the purchase
 * flow. `servedTier` and `servedPath` are then *decisions* Atlas made.
 *
 * With `--url` it runs a stranger's app: the generic manifest as a measuring
 * stick, the generic probe injected over CDP, the generic driver, and
 * `classify-delivery.js` turning `servedTier`/`servedPath` into *measurements*
 * of what that app delivered. Three things about that mode are deliberate:
 *
 *  - **No baseline half.** The failure story compares "router bypassed" against
 *    "router engaged", and there is no router in the loop on someone else's
 *    app. A baseline run would be the same run twice with a different label, so
 *    it is refused rather than faked, and the report says why in
 *    `summary.failureStory`.
 *  - **The XR pair is in the default set.** A stranger's WebAR build is exactly
 *    what `xr-granted`/`xr-denied` exist for, and Orbital — which has no XR
 *    entry point — never runs them.
 *  - **Nothing is served to the page.** The control plane still starts, because
 *    the engine and the trace assembler live behind it, but the page under test
 *    loads from its own origin and never talks to us. Its payload is read back
 *    over CDP (`runSession`'s `harvest`).
 *
 * Every number in the resulting report is read from a real captured trace. No
 * metric in this file is written by hand.
 *
 * @typedef {import("../../types/atlas.js").Trace} Trace
 * @typedef {import("../../types/atlas.js").Profile} Profile
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 * @typedef {import("../../types/atlas.js").TraceVerdict} TraceVerdict
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { orbitalManifest } from "../manifest/atlas-orbital.manifest.js";
import { genericManifest } from "../manifest/generic.manifest.js";
import { validateManifest } from "../manifest/validate.js";
import { selectEngine } from "../decision/index.js";
import { moderateGlb } from "../viewer/parse-glb.js";
import { launchBrowser } from "./cdp.js";
import { startServer } from "./server.js";
import { PROFILES, GENERIC_PROFILES, profileById } from "./profiles.js";
import { runSession } from "./session.js";
import { driveHappyPath } from "./drive.js";
import { driveGeneric } from "./drive-generic.js";
import { buildXrStubScript, xrStubNote, POSE_SCRIPT_ID } from "./xr-stub.js";
import { applyDeliveryClassification } from "./classify-delivery.js";
import { causalHash } from "../trace/normalize.js";
import { fromRoot, ensureDir, emptyDir, writeJson, writeFileEnsured } from "../util/fsx.js";
import { logger, banner } from "../util/log.js";


const log = logger("matrix");

/** Fixed unless overridden. Part of the reproducibility contract. */
export const DEFAULT_SEED = 0x0b17a1;

/** The profile the failure story is told on, and the tier the baseline forces. */
export const BASELINE_PROFILE_ID = "low-cpu-3g";
export const BASELINE_FORCED_TIER = "high";

/**
 * The other half of a `--url` failure story: the profile a build is most likely
 * to have actually been developed and demoed on. Comparing against it is what
 * makes "and here is the same app on a cheap handset" land, because it is the
 * run the author would recognise.
 */
export const GENERIC_REFERENCE_PROFILE_ID = "high-wifi";

export const MATRIX_DIR = fromRoot("artifacts", "matrix");

/**
 * The probe is read off disk as text and registered with
 * `Page.addScriptToEvaluateOnNewDocument`, never imported. It is a classic
 * script, not a module, precisely so it can run in a document that has no
 * import channel to us.
 */
const GENERIC_PROBE_PATH = fromRoot("experience", "probe-generic.js");

/**
 * Validates a `--url` target before a browser is launched.
 *
 * Only `http:` and `https:` are accepted, and the restriction is a real
 * boundary rather than tidiness. `Page.addScriptToEvaluateOnNewDocument`
 * registers the probe against *every* document the target loads; pointed at a
 * `file:` URL that would run our injected script — which reads the DOM and
 * enumerates resources — inside the local-filesystem origin. `javascript:` and
 * `data:` are refused for the same reason in the other direction: the target
 * would be a code fragment supplied on the command line rather than a page.
 *
 * @param {string} raw
 * @returns {URL}
 */
export function parseTargetUrl(raw) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--url "${raw}" is not a URL. Include the scheme, e.g. https://example.com/ar`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `--url must be http: or https:, not "${url.protocol}". Atlas injects a recorder into ` +
        "every document the target loads, and it will not do that into a local-file or " +
        "inline-code origin.",
    );
  }
  return url;
}

/**
 * A quarantined row for a profile the harness could not run to completion.
 * Shape-complete (never null fields where the typedef promises a shape key)
 * so the gate, the judge, and the report all read it as "absence of evidence"
 * rather than crashing on it: rule 1 blocks critical absences, everything
 * else skips. Exported for tests.
 *
 * @param {{ profile: Profile; runKind: "baseline" | "adaptive"; forcedTier: string | null }} step
 * @param {string} runId
 * @param {string} traceId
 * @param {string} message
 * @param {number} attempts
 * @param {bigint} stepStarted
 * @returns {MatrixRunRow}
 */
export function harnessErrorRow(step, runId, traceId, message, attempts, stepStarted) {
  return {
    runId,
    profileId: step.profile.id,
    label: step.profile.label,
    runKind: step.runKind,
    forcedTier: step.forcedTier,
    traceId,
    tracePath: null,
    determinismHash: null,
    causalHash: null,
    servedTier: null,
    servedPath: null,
    metrics: null,
    decision: null,
    verdict: null,
    drive: null,
    delivery: null,
    screenshots: {},
    pageErrors: [],
    error: `harness failed after ${attempts} attempt(s): ${message}`,
    wallMs: Math.round(Number(process.hrtime.bigint() - stepStarted) / 1e6),
  };
}

/** Default caps for `--glb` uploads; overridable per run (see stageUpload). */
export const DEFAULT_GLB_MAX_BYTES = 50_000_000;
export const DEFAULT_GLB_MAX_TRIANGLES = 60_000;

/**
 * Moderates an upload and stages it for serving: `<outDir>/uploads/<hash>.glb`
 * plus the viewer sidecar `<hash>.atlas.json`.
 *
 * The content hash is the filename so a restaged identical file is
 * byte-identical and the viewer URL (`?model=<hash>`) is deterministic for a
 * given upload. Moderation runs here — before any browser launches — because
 * a refused model must cost seconds, not a throttled matrix run. Only the
 * sidecar is ever served to the page as data; the raw `.glb` rides along so
 * the artifacts directory is self-describing for anyone re-running the report.
 *
 * @param {Buffer} bytes
 * @param {string} fileName   original path, for messages only
 * @param {string} outDir
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ hash: string; stats: any; warnings: string[]; fileName: string }>}
 */
export async function stageUpload(bytes, fileName, outDir, env) {
  const maxBytes = Number(env.ATLAS_GLB_MAX_BYTES ?? DEFAULT_GLB_MAX_BYTES);
  const maxTriangles = Number(env.ATLAS_GLB_MAX_TRIANGLES ?? DEFAULT_GLB_MAX_TRIANGLES);
  const moderated = moderateGlb(bytes, { maxBytes, maxTriangles });
  if (!moderated.ok || !moderated.sidecar) {
    throw new Error(`upload refused (${fileName}):\n  ${moderated.errors.join("\n  ")}`);
  }
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const dir = path.join(outDir, "uploads");
  await ensureDir(dir);
  await writeFileEnsured(path.join(dir, `${hash}.glb`), bytes);
  await writeJson(path.join(dir, `${hash}.atlas.json`), {
    $note: "Atlas viewer sidecar — parsed from the staged .glb, this is what the page renders.",
    sourceHash: hash,
    sourceFile: path.basename(fileName),
    stats: moderated.stats,
    warnings: moderated.warnings,
    ...moderated.sidecar,
  });
  return {
    hash,
    stats: moderated.stats,
    warnings: moderated.warnings,
    fileName: path.basename(fileName),
  };
}


/**
 * @typedef {object} MatrixRunRow
 * @property {string} runId
 * @property {string} profileId
 * @property {string} label
 * @property {"baseline" | "adaptive"} runKind
 * @property {string | null} forcedTier
 * @property {string} traceId
 * @property {string | null} tracePath
 * @property {string | null} determinismHash
 * @property {string | null} causalHash
 * @property {string | null} servedTier
 * @property {string | null} servedPath
 * @property {import("../../types/atlas.js").TraceMetrics | null} metrics
 * @property {object | null} decision
 * @property {TraceVerdict | null} verdict
 * @property {{ completed: string[]; failedAt: string | null; error: string | null } | null} drive
 * @property {import("./classify-delivery.js").DeliveryClassification | null} delivery
 *   How `servedTier`/`servedPath` were arrived at. `null` on an Orbital run,
 *   where they were not arrived at but *chosen* — the decision is in `decision`.
 * @property {Record<string, string>} screenshots
 * @property {string[]} pageErrors
 * @property {string | null} error
 * @property {number} wallMs
 */

/**
 * @param {{
 *   profileIds?: string[];
 *   seed?: number;
 *   outDir?: string;
 *   includeBaseline?: boolean;
 *   clean?: boolean;
 *   env?: NodeJS.ProcessEnv;
 *   url?: string;
 *   glb?: string;
 *   retry?: number;
 * }} [opts]
 */
export async function runMatrix(opts = {}) {
  const startedAtIso = new Date().toISOString();
  const startedAt = process.hrtime.bigint();
  const seed = opts.seed ?? readSeed(opts.env ?? process.env);
  const outDir = opts.outDir ?? MATRIX_DIR;

  // Parsed before anything is launched: a typo in the flag should cost a
  // second, not a browser start and six throttled runs.
  if (opts.url && opts.glb) {
    throw new Error("`--url` and `--glb` are mutually exclusive: one run, one target.");
  }
  const target = opts.url ? parseTargetUrl(opts.url) : null;
  // The upload is read now (fail fast on a missing file) and moderated later,
  // after `emptyDir`, so staging never lands in a directory about to be wiped.
  /** @type {Buffer | null} */
  let glbBytes = null;
  if (opts.glb) {
    const abs = path.resolve(opts.glb);
    try {
      glbBytes = await readFile(abs);
    } catch {
      throw new Error(`--glb file not found: ${opts.glb}`);
    }
  }
  const generic = target !== null || glbBytes !== null;
  const manifest = generic ? genericManifest : orbitalManifest;

  banner(
    generic
      ? `Atlas Replay Lab — capability matrix against ${target ? target.origin + target.pathname : `upload ${opts.glb}`}`
      : "Atlas Replay Lab — capability matrix",
  );
  if (generic) {
    log.info(
      "generic mode: no tier router is in the loop. servedTier/servedPath are " +
        "measurements of what this app delivered, not decisions Atlas made.",
    );
  }

  // A manifest that does not validate cannot produce a meaningful matrix, and
  // finding that out six throttled runs later would be a waste of ten minutes.
  const validation = validateManifest(manifest);
  for (const issue of validation.issues.filter((i) => i.severity === "warning")) {
    log.warn(`manifest ${issue.path}: ${issue.message}`);
  }
  if (!validation.ok) {
    const errors = validation.issues
      .filter((i) => i.severity === "error")
      .map((i) => `${i.path}: ${i.message}`);
    throw new Error(`manifest is invalid:\n  ${errors.join("\n  ")}`);
  }

  // Orbital's tier assets. A generic run serves the page nothing, so generating
  // them would be a second of work for a file no request will ever reach.
  if (!generic) await ensureAssets();

  const genericProbe = generic ? await readFile(GENERIC_PROBE_PATH, "utf8") : null;

  const defaultProfiles = generic ? GENERIC_PROFILES : PROFILES;
  const profiles = opts.profileIds?.length ? opts.profileIds.map(profileById) : defaultProfiles;


  const selection = await selectEngine({ env: opts.env ?? process.env, allowFixture: true });
  log.info(selection.status);

  if (opts.clean !== false) await emptyDir(outDir);
  await ensureDir(path.join(outDir, "runs"));

  // Upload moderation + staging, after the wipe and before the browser: a
  // refused model must cost seconds, and staged files must survive the run.
  /** @type {{ hash: string; stats: any; warnings: string[]; fileName: string } | null} */
  let upload = null;
  let uploadDir = null;
  if (glbBytes) {
    upload = await stageUpload(glbBytes, opts.glb, outDir, opts.env ?? process.env);
    uploadDir = path.join(outDir, "uploads");
    for (const w of upload.warnings) log.warn(`upload: ${w}`);
    log.info(
      `upload: ${upload.fileName} → ${upload.stats.triangleCount} triangles ` +
        `(${upload.stats.trianglesKept} kept), ${upload.stats.meshCount} mesh(es)`,
    );
  }

  const browser = await launchBrowser();
  const server = await startServer({
    manifest,
    engine: selection.engine,
    emulated: true,
    // Traces are written per-run below, next to their screenshots, so the
    // server's own dump directory would only duplicate them.
    traceDir: null,
    aliases: uploadDir ? { "/uploads/": uploadDir } : undefined,
  });
  log.info(`control plane on ${server.origin}; chrome at ${browser.executable}`);

  // The target page: a stranger's URL, or our own viewer over the staged
  // upload. Either way the generic probe, driver, and harvest treat it as a
  // page Atlas observes but does not route. The viewer URL names index.html
  // explicitly: the static server has no directory-index fallback (a directory
  // is a 404), and a matrix target must be the page itself, not a guess.
  const targetHref = target ? target.href : upload ? `${server.origin}/viewer/index.html?model=${upload.hash}` : null;

  const browserVersion = await browser.connection
    .send("Browser.getVersion")
    .catch(() => /** @type {any} */ ({}));

  /** @type {MatrixRunRow[]} */
  const runs = [];

  try {
    /** @type {Array<{ profile: Profile; runKind: "baseline" | "adaptive"; forcedTier: string | null }>} */
    const plan = [];

    // The baseline is "the router bypassed", which only means something when
    // there is a router. On someone else's app there is not one, so asking for
    // a baseline would produce the same run twice under two labels — a
    // before/after with nothing between them. Refused out loud.
    const baselineWanted = opts.includeBaseline !== false && !generic;
    if (generic && opts.includeBaseline === true) {
      log.warn(
        "--url/--glb runs have no baseline half: there is no bypassable router " +
          "in the loop (a stranger's app is never routed; the viewer has no " +
          "forced-tier mode). Running the adaptive set only.",
      );
    }
    const baselineProfile = profiles.find((p) => p.id === BASELINE_PROFILE_ID);
    if (baselineWanted && baselineProfile) {
      plan.push({ profile: baselineProfile, runKind: "baseline", forcedTier: BASELINE_FORCED_TIER });
    }
    for (const profile of profiles) {
      plan.push({ profile, runKind: "adaptive", forcedTier: null });
    }

    let index = 0;
    for (const step of plan) {
      index++;
      const runId = step.runKind === "baseline" ? `${step.profile.id}--baseline` : step.profile.id;
      const runDir = path.join(outDir, "runs", runId);
      const traceId = `${manifest.id}-${runId}-${Date.now().toString(36)}`;

      banner(`[${index}/${plan.length}] ${runId} — ${step.profile.label}`);
      if (step.forcedTier) {
        log.info(`router bypassed: tier forced to "${step.forcedTier}" (baseline half of the failure story)`);
      }

      // One step, retried: a transient CDP/browser hiccup must cost a rerun of
      // one profile, not the whole matrix (previously an exception here skipped
      // the report entirely). Everything a step produces lives inside runStepOnce
      // so a retry starts clean; quarantine below is what the gate's rule 1 reads.
      const runStepOnce = async () => {
      /** @type {any} */
      let driveResult = null;

      // The XR stub only exists on the two `xr-*` profiles, and only in generic
      // mode — Orbital has no XR entry point, and installing a fake
      // `navigator.xr` under it would put a capability in the capability probe's
      // snapshot that the experience cannot use.
      const xrGrant = generic ? (step.profile.xr ?? null) : null;
      /** @type {string[]} */
      const extraScripts = [];
      if (xrGrant) extraScripts.push(buildXrStubScript({ seed, grant: xrGrant }));
      if (genericProbe) extraScripts.push(genericProbe);

      const result = await runSession({
        connection: browser.connection,
        server,
        manifest,
        profile: step.profile,
        seed,
        traceId,
        runKind: step.runKind,
        forceTier: step.forcedTier,
        screenshotDir: path.join(runDir, "screenshots"),
        target: targetHref ?? undefined,
        extraScripts: extraScripts.length ? extraScripts : undefined,
        // A third-party HTTPS page cannot POST to our loopback control plane
        // (CORS, and mixed content), so its payload is read back over CDP.
        // `CdpSession.evaluate` always sends `returnByValue`, so what comes
        // back is the plain object rather than a remote handle to walk.
        harvest: generic
          ? (session) => session.evaluate("globalThis.__atlasGeneric.payload()")
          : undefined,
        partialHarvest: generic
          ? undefined
          : async (session) => {
              const payload = await session.evaluate("globalThis.__atlasSnapshot?.() ?? null");
              if (!payload || typeof payload !== "object") return null;
              return {
                ...payload,
                events: [
                  ...(Array.isArray(payload.events) ? payload.events : []),
                  {
                    tOffsetMs: payload.durationMs ?? 0,
                    name: "runner-session-abort",
                    kind: "error",
                    attributes: { code: "DRIVE_STOPPED" },
                  },
                ],
              };
            },
        // In generic mode a drive that stopped early has still recorded
        // everything up to the failure, and that is the evidence. Waiting out
        // the full completion timeout to discover the page will never say
        // "done" buys nothing.
        doneOptional: generic,
        drive: async (session) => {
          driveResult = generic
            ? await driveGeneric(session, {
                mobile: step.profile.viewport.mobile,
                seed,
                viewport: step.profile.viewport,
                // Attempted on every generic profile, not only the XR pair: an
                // app that offers an AR button on a device with no WebXR is
                // exactly the failure `xr-denied` exists to catch, and the
                // probe reports "unavailable" honestly when there is nothing
                // to request.
                attemptXr: true,
                xrMode: "immersive-ar",
              })
            : await driveHappyPath(session, { mobile: step.profile.viewport.mobile });
          if (driveResult.error) {
            log.warn(`drive stopped at "${driveResult.failedAt}": ${driveResult.error}`);
          }
          return driveResult;
        },
      });

      /** @type {TraceVerdict | null} */
      let verdict = null;
      /** @type {string | null} */
      let tracePath = null;
      /** @type {import("./classify-delivery.js").DeliveryClassification | null} */
      let delivery = null;

      if (result.trace) {
        if (driveResult?.error) {
          result.trace.notes.push(`drive stopped at "${driveResult.failedAt}": ${driveResult.error}`);
        }
        if (step.profile.viewport.mobile) {
          result.trace.notes.push(
            "scripted interactions used synthetic DOM click() over a mobile-emulated viewport; physical touch handling was not tested",
          );
        }
        if (xrGrant) {
          // Recorded on every run that injects the stub, without exception. A
          // report that said "XR works" on the strength of a scripted pose
          // would be lying, and this note is what stops it.
          result.trace.notes.push(xrStubNote(xrGrant));
          result.trace.notes.push(`XR head path: ${POSE_SCRIPT_ID} (seeded ${seed})`);
        }
        if (generic) {
          // Fills in servedTier/servedPath from what was *measured*, since no
          // router chose them. Runs before the judge so the verdict reads the
          // same fields it would on an Orbital trace.
          delivery = applyDeliveryClassification(result.trace, manifest, driveResult?.surface ?? null);
          log.info(`delivered: ${delivery.tierBasis}`);
          log.info(`reached:   ${delivery.pathBasis}`);
        }
        // Integration point 2: the trace judge, on the same call path a
        // production trace stream would use — only `origin` differs.
        verdict = await selection.engine.judgeTrace(result.trace, {
          manifest,
          origin: "ci-matrix",
          profileId: step.profile.id,
        });
        tracePath = path.join(runDir, "trace.json");
        await writeJson(tracePath, result.trace);
        await writeJson(path.join(runDir, "verdict.json"), verdict);
      }

      return /** @type {MatrixRunRow} */ ({
        runId,
        profileId: step.profile.id,
        label: step.profile.label,
        runKind: step.runKind,
        forcedTier: step.forcedTier,
        traceId,
        tracePath: tracePath ? rel(tracePath) : null,
        determinismHash: result.trace?.determinismHash ?? null,
        causalHash: result.trace ? causalHash(result.trace) : null,
        servedTier: result.trace?.servedTier ?? null,
        servedPath: result.trace?.servedPath ?? null,
        metrics: result.trace?.metrics ?? null,
        decision: result.trace?.decision ?? null,
        verdict,
        drive: driveResult,
        delivery,
        screenshots: Object.fromEntries(
          Object.entries(result.screenshots).map(([id, file]) => [id, rel(file)]),
        ),
        pageErrors: result.pageErrors,
        error: result.error,
        wallMs: result.wallMs,
      });
      };

      const maxAttempts = 1 + Math.max(0, Math.floor(opts.retry ?? 1));
      /** @type {MatrixRunRow | null} */
      let row = null;
      const stepStarted = process.hrtime.bigint();
      for (let attempt = 1; attempt <= maxAttempts && !row; attempt++) {
        if (attempt > 1) log.warn(`${runId}: retrying after harness failure (attempt ${attempt}/${maxAttempts})`);
        try {
          row = await runStepOnce();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (attempt >= maxAttempts) {
            log.error(`${runId}: harness failed after ${attempt} attempt(s), quarantined: ${message}`);
            row = harnessErrorRow(step, runId, traceId, message, attempt, stepStarted);
          } else {
            log.warn(`${runId}: harness failure on attempt ${attempt}/${maxAttempts}: ${message}`);
          }
        }
      }
      runs.push(/** @type {MatrixRunRow} */ (row));
      logRow(/** @type {MatrixRunRow} */ (row));
    }
  } finally {
    await server.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const report = {
    kind: "atlas.matrix-report",
    schemaVersion: 1,
    startedAtIso,
    finishedAtIso: new Date().toISOString(),
    wallMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
    seed,
    reproduce: generic
      ? target
        ? `node bin/atlas.js matrix --url ${target.href}`
        : `node bin/atlas.js matrix --glb <file> (upload hash ${upload?.hash ?? "?"})`
      : "node bin/atlas.js matrix",
    // Null on an Orbital run rather than absent, so a consumer can tell "this
    // report is about our own experience" from "this key is from an older
    // schema version" without guessing.
    target: generic
      ? target
        ? {
            url: target.href,
            origin: target.origin,
            mode: "generic",
            // Stated in the report itself, not only in the prose, because this
            // is the single most misreadable number in a `--url` run: a reader
            // who assumes Atlas *chose* these tiers would conclude the router
            // works on any app, which it does not, because it was never asked.
            routed: false,
            servedTierMeaning:
              "measured from what the app delivered (asset bytes, WebGL use, frame " +
              "pacing), not a tier Atlas selected. No Atlas router ran against this app.",
            injected: [
              "capability bootstrap (deterministic RNG, profile hints)",
              "generic trace recorder (experience/probe-generic.js)",
              "synthetic WebXR device on the xr-* profiles only (src/runner/xr-stub.js)",
            ],
            notServed:
              "Atlas served this page nothing. The control plane ran only to host the " +
              "decision engine and the trace assembler; the page loaded entirely from " +
              "its own origin and never made a request to Atlas.",
          }
        : {
            mode: "viewer",
            uploadHash: upload?.hash ?? null,
            // The viewer calls /api/decide itself (same control plane Orbital
            // uses), so unlike a --url run there IS a router in this loop —
            // but it routes Atlas's own viewer, not the upload. The model is
            // data; every decision about it is ours.
            routed: "viewer-only",
            servedTierMeaning:
              "the viewer applied the tier the control plane returned for its own " +
              "capability snapshot; classify-delivery independently measured what " +
              "reached the screen.",
            injected: [
              "capability bootstrap (deterministic RNG, profile hints)",
              "generic trace recorder (experience/probe-generic.js)",
              "synthetic WebXR device on the xr-* profiles only (src/runner/xr-stub.js)",
            ],
          }
      : null,
    // Null unless --glb staged an upload: the content hash, moderation stats,
    // and warnings, so a report reader can reproduce the run from the file.
    upload: upload
      ? {
          fileName: upload.fileName,
          contentHash: upload.hash,
          triangleCount: upload.stats.triangleCount,
          trianglesKept: upload.stats.trianglesKept,
          decimated: upload.stats.decimated,
          meshCount: upload.stats.meshCount,
          byteLength: upload.stats.byteLength,
          warnings: upload.warnings,
        }
      : null,
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      chromeExecutable: browser.executable,
      chromeProduct: browserVersion.product ?? null,
      chromeJsVersion: browserVersion.jsVersion ?? null,
      headless: process.env.ATLAS_HEADFUL === "1" ? false : true,
    },
    emulationDisclaimer:
      "Chromium emulation, not devices. CPU throttling and network shaping are applied by the " +
      "browser and are real; deviceMemory, hardwareConcurrency, navigator.connection and GPU tier " +
      "are injected hints. These results say nothing about thermal behaviour, real GPU drivers or " +
      "actual handset performance — that needs a physical device lab.",
    manifest: {
      id: manifest.id,
      version: manifest.version,
      contentHash: manifest.contentHash,
    },
    engine: {
      mode: selection.mode,
      name: selection.engine.name,
      kind: selection.engine.kind,
      status: selection.status,
    },
    budgets: manifest.budgets,
    runs,
    summary: summarise(runs, manifest, generic),
    serverStats: server.stats,
  };

  const reportPath = path.join(outDir, "report.json");
  await writeJson(reportPath, report);

  banner("matrix complete");
  log.info(`${report.summary.passed}/${report.summary.total} runs passed the engine's judgement`);
  log.info(`report: ${rel(reportPath)}`);

  return { report, reportPath, selection };
}

/* ── summary ─────────────────────────────────────────────────────────── */

/**
 * @param {MatrixRunRow[]} runs
 * @param {ExperienceManifest} manifest
 * @param {boolean} [generic]
 */
function summarise(runs, manifest, generic = false) {
  const graded = runs.filter((r) => r.verdict);
  const outcome = /** @param {MatrixRunRow} r */ (r) => r.verdict?.outcome.value ?? "inconclusive";

  /** @type {Record<string, number>} */
  const byOutcome = {};
  /** @type {Record<string, number>} */
  const byRootCause = {};
  for (const r of graded) {
    byOutcome[outcome(r)] = (byOutcome[outcome(r)] ?? 0) + 1;
    const cause = r.verdict?.rootCause.value ?? "unknown";
    if (outcome(r) !== "pass") byRootCause[cause] = (byRootCause[cause] ?? 0) + 1;
  }

  return {
    total: runs.length,
    completed: runs.filter((r) => !r.error).length,
    passed: graded.filter((r) => outcome(r) === "pass").length,
    degraded: graded.filter((r) => outcome(r) === "degraded-but-acceptable").length,
    failed: graded.filter((r) => outcome(r) === "fail").length,
    inconclusive: graded.filter((r) => outcome(r) === "inconclusive").length,
    byOutcome,
    byRootCause,
    tiersServed: Object.fromEntries(
      runs.map((r) => [r.runId, { tier: r.servedTier, path: r.servedPath }]),
    ),
    reachedEndState: runs.filter((r) => r.metrics?.reachedEndState).length,
    // The failure story, computed rather than narrated. Both halves come from
    // captured traces; if either is missing the field says so instead of
    // inventing a comparison.
    failureStory: generic ? genericStory(runs, manifest) : routerStory(runs, manifest),
  };
}

/**
 * Orbital's failure story: the same device, the router bypassed and then
 * engaged. The delta is attributable to the routing decision because nothing
 * else about the two runs differs.
 *
 * @param {MatrixRunRow[]} runs
 * @param {ExperienceManifest} manifest
 */
function routerStory(runs, manifest) {
  const baseline = runs.find((r) => r.runKind === "baseline");
  const adaptive = runs.find((r) => r.runKind === "adaptive" && r.profileId === BASELINE_PROFILE_ID);
  if (!baseline || !adaptive) {
    return { unavailable: "baseline and adaptive runs of the failure profile were not both captured" };
  }
  return {
    mode: "router-comparison",
    question: "what does the tier router change on the profile it matters most on?",
    profileId: BASELINE_PROFILE_ID,
    budgetFirstFrameMs: manifest.budgets.firstFrameMs,
    before: storyHalf(baseline),
    after: storyHalf(adaptive),
    firstFrameDeltaMs: delta(baseline.metrics?.firstFrameMs ?? null, adaptive.metrics?.firstFrameMs ?? null),
    transferDeltaBytes: delta(baseline.metrics?.transferBytes ?? null, adaptive.metrics?.transferBytes ?? null),
  };
}

/**
 * A `--url` run's failure story: **the visitor's app across two device classes**,
 * not before-and-after a routing decision.
 *
 * The substitution is not a downgrade, it is the only honest comparison
 * available. Atlas does not route a third-party app, so a "router bypassed"
 * half would be the identical run under a second label — a before/after with
 * nothing in between. What *can* be compared is the same build on the reference
 * profile and on the one that breaks things, and the delta there is
 * attributable to the device class, because that is the only thing that
 * changed. `attribution` says so in the report rather than leaving a reader to
 * assume Atlas improved anything.
 *
 * @param {MatrixRunRow[]} runs
 * @param {ExperienceManifest} manifest
 */
function genericStory(runs, manifest) {
  const reference = runs.find((r) => r.profileId === GENERIC_REFERENCE_PROFILE_ID);
  const stressed = runs.find((r) => r.profileId === BASELINE_PROFILE_ID);

  const common = {
    mode: "device-comparison",
    question: `what happens to this app between "${GENERIC_REFERENCE_PROFILE_ID}" and "${BASELINE_PROFILE_ID}"?`,
    noBaselineHalf:
      "no router-bypassed baseline was run. Atlas does not route a third-party app, so " +
      "bypassing its router would change nothing about what was served, and the two halves " +
      "would be the same run under two labels.",
    attribution:
      "the delta below is attributable to the device and network class, not to anything " +
      "Atlas did. Atlas observed this app; it did not serve, route or degrade it.",
  };

  if (!reference || !stressed) {
    return {
      ...common,
      unavailable:
        `both "${GENERIC_REFERENCE_PROFILE_ID}" and "${BASELINE_PROFILE_ID}" are needed for the ` +
        "comparison and were not both captured in this run",
    };
  }

  return {
    ...common,
    referenceProfileId: GENERIC_REFERENCE_PROFILE_ID,
    stressedProfileId: BASELINE_PROFILE_ID,
    budgetFirstFrameMs: manifest.budgets.firstFrameMs,
    reference: storyHalf(reference),
    stressed: storyHalf(stressed),
    // Signed so the direction is unambiguous: positive means the stressed
    // profile was slower / heavier than the reference.
    firstFrameDeltaMs: delta(stressed.metrics?.firstFrameMs ?? null, reference.metrics?.firstFrameMs ?? null),
    transferDeltaBytes: delta(stressed.metrics?.transferBytes ?? null, reference.metrics?.transferBytes ?? null),
  };
}

/** @param {MatrixRunRow} row */
function storyHalf(row) {
  return {
    runId: row.runId,
    servedTier: row.servedTier,
    servedPath: row.servedPath,
    // Present only on a `--url` run, and the difference matters: on Orbital the
    // two fields above are a decision, here they are a reading, and this says
    // what was read.
    tierBasis: row.delivery?.tierBasis ?? null,
    pathBasis: row.delivery?.pathBasis ?? null,
    forcedTier: row.forcedTier,
    firstFrameMs: row.metrics?.firstFrameMs ?? null,
    timeToInteractiveMs: row.metrics?.timeToInteractiveMs ?? null,
    p95InteractionMs: row.metrics?.p95InteractionMs ?? null,
    droppedFrameRatio: row.metrics?.droppedFrameRatio ?? null,
    transferBytes: row.metrics?.transferBytes ?? null,
    firstFrameNonBlank: row.metrics?.firstFrameNonBlank ?? null,
    reachedEndState: row.metrics?.reachedEndState ?? false,
    outcome: row.verdict?.outcome.value ?? null,
    rootCause: row.verdict?.rootCause.value ?? null,
    releaseBlocking: row.verdict?.releaseBlocking.score ?? null,
    tracePath: row.tracePath,
  };
}

/**
 * @param {number | null} before
 * @param {number | null} after
 */
function delta(before, after) {
  if (before === null || after === null) return null;
  return Math.round((before - after) * 100) / 100;
}

/* ── plumbing ────────────────────────────────────────────────────────── */

/**
 * Generates the tier assets if they are not on disk, so the matrix really is
 * one command from a fresh clone. The generator is deterministic, so doing this
 * lazily does not make the run any less reproducible. Exported for `serve`,
 * which has the same fresh-clone problem.
 */
export async function ensureAssets() {
  const marker = fromRoot("experience", "assets", "generated", "sizes.json");
  if (existsSync(marker)) return;
  log.info("tier assets not found; generating them (deterministic, ~1s)");
  const { generateAssets } = await import("../../scripts/generate-assets.js");
  await generateAssets();
}

/** @param {NodeJS.ProcessEnv} env */
function readSeed(env) {
  const raw = env.ATLAS_SEED;
  if (!raw) return DEFAULT_SEED;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    log.warn(`ignoring non-numeric ATLAS_SEED="${raw}"`);
    return DEFAULT_SEED;
  }
  return parsed >>> 0;
}

/** @param {string} file */
function rel(file) {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

/** @param {MatrixRunRow} row */
function logRow(row) {
  const m = row.metrics;
  const bits = [
    `tier=${row.servedTier ?? "-"}`,
    `path=${row.servedPath ?? "-"}`,
    `firstFrame=${fmtMs(m?.firstFrameMs)}`,
    `tti=${fmtMs(m?.timeToInteractiveMs)}`,
    `p95tap=${fmtMs(m?.p95InteractionMs)}`,
    `dropped=${m?.droppedFrameRatio === null || m?.droppedFrameRatio === undefined ? "-" : `${Math.round(m.droppedFrameRatio * 100)}%`}`,
    `bytes=${m?.transferBytes ?? "-"}`,
    `end=${m?.reachedEndState ? "reached" : "NOT reached"}`,
  ];
  log.info(bits.join("  "));
  if (row.verdict) {
    log.info(
      `verdict=${row.verdict.outcome.value}  cause=${row.verdict.rootCause.value}  ` +
        `blocking=${row.verdict.releaseBlocking.score.toFixed(2)}/4  ` +
        `confidence=${row.verdict.confidence.toFixed(2)}  engine=${row.verdict.engine}`,
    );
  }
  if (row.error) log.warn(`harness: ${row.error}`);
}

/** @param {number | null | undefined} ms */
function fmtMs(ms) {
  return ms === null || ms === undefined ? "-" : `${Math.round(ms)}ms`;
}
