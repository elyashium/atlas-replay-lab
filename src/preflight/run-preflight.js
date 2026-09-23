/**
 * `atlas preflight` — static pre-launch assessment without running a browser.
 *
 * Fetches a page, measures its static asset weight, and assesses which tier
 * that weight points at — *before* the matrix runs. The matrix then confirms
 * or refutes the prediction, and both outcomes are interesting: a confirmed
 * prediction means the weight model works, a refuted one is a case study in
 * what static weight cannot see (decode cost, render cost, runtime behavior).
 *
 * ## What it deliberately does not do
 *
 * No browser, no JavaScript execution, no rendering. Decode and render cost
 * are invisible here by construction, and the report says so rather than
 * modelling them from bytes. The assessment answers "will the weight fit",
 * never "will it feel smooth".
 *
 * ## Privacy and safety
 *
 * Page URLs are scrubbed to origin + pathname before they enter any state
 * object (no query strings, no fragments, no asset addresses — hosts in the
 * largest-list are truncated hashes). Asset bodies are never retained: sizes
 * come from HEAD, and anything that cannot be sized by header is recorded as
 * unknown bytes, not downloaded.
 *
 * Fetching an operator-supplied URL is an SSRF surface the moment this runs
 * anywhere but a laptop. Hosts resolving to private, loopback, link-local, or
 * multicast addresses are refused unless `ATLAS_PREFLIGHT_ALLOW_PRIVATE=1`
 * (local dev and the test suite). DNS is checked for the initial URL and the
 * final URL after redirects. DNS-rebinding TOCTOU between check and fetch is
 * acknowledged and out of scope for a local tool; a hosted version must pin
 * and re-check (see docs/product-brief.md Phase 0).
 *
 * @typedef {import("../../types/atlas.js").PreflightState} PreflightState
 */

import dns from "node:dns/promises";
import path from "node:path";
import { genericManifest } from "../manifest/generic.manifest.js";
import { selectEngine } from "../decision/index.js";
import { estimateCostUsd } from "../decision/jev-transport.js";
import { sha256 } from "../util/hash.js";
import { writeJson, fromRoot } from "../util/fsx.js";
import { logger, banner } from "../util/log.js";

const log = logger("preflight");

export const PREFLIGHT_DIR = fromRoot("artifacts", "preflight");

const PAGE_CAP_BYTES = 2_000_000;
const DEFAULT_MAX_ASSETS = 40;
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * @param {{
 *   url: string;
 *   outDir?: string;
 *   maxAssets?: number;
 *   timeoutMs?: number;
 *   allowPrivate?: boolean;
 *   fetchImpl?: typeof fetch;
 *   lookup?: (hostname: string) => Promise<string>;
 *   env?: NodeJS.ProcessEnv;
 *   quiet?: boolean;
 * }} opts
 */
export async function runPreflight(opts) {
  if (!opts?.url) throw new Error("runPreflight requires a url (`atlas preflight --url <https://…>`)");
  const env = opts.env ?? process.env;
  const outDir = opts.outDir ?? PREFLIGHT_DIR;
  const maxAssets = opts.maxAssets ?? Number(env.ATLAS_PREFLIGHT_MAX_ASSETS ?? DEFAULT_MAX_ASSETS);
  const timeoutMs = opts.timeoutMs ?? Number(env.ATLAS_PREFLIGHT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const allowPrivate = opts.allowPrivate ?? env.ATLAS_PREFLIGHT_ALLOW_PRIVATE === "1";
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const lookup = opts.lookup ?? defaultLookup;
  if (typeof fetchImpl !== "function") throw new Error("global fetch is unavailable; Node 18+ is required");

  const target = await checkTarget(opts.url, { allowPrivate, lookup });
  const page = await fetchPage(target, { fetchImpl, timeoutMs });
  // Redirects can land somewhere the initial check never saw.
  await checkTarget(page.finalUrl, { allowPrivate, lookup });

  const harvest = await measureAssets(page.finalUrl, page.html, {
    fetchImpl,
    lookup,
    allowPrivate,
    maxAssets,
    timeoutMs,
  });
  /** @type {PreflightState} */
  const stats = {
    url: scrubUrl(page.finalUrl),
    totalBytes: harvest.totalBytes,
    unknownBytes: harvest.unknownBytes,
    assetCount: harvest.assets.length,
    byType: harvest.byType,
    largest: harvest.largest,
  };

  const manifest = genericManifest;
  const ctx = { manifest, origin: /** @type {const} */ ("preflight") };
  const selection = await selectEngine({ env, allowFixture: true, quiet: opts.quiet });
  const jevBefore = selection.jev ? { ...selection.jev.stats } : null;

  // Served assessment: guarded posture in every mode (rules directly with no
  // key, Guarded(Jev → rules) with one). The deterministic twin is always
  // computed too — it is the prediction the matrix will confirm or refute.
  const assessment = await selection.engine.preflightAssess(stats, ctx);
  const rules = await selection.rules.preflightAssess(stats, ctx);

  const jevRun = selection.jev && jevBefore
    ? {
        calls: selection.jev.stats.calls - jevBefore.calls,
        inputTokens: selection.jev.stats.inputTokens - jevBefore.inputTokens,
        estimatedUsd: estimateCostUsd(selection.jev.stats.inputTokens - jevBefore.inputTokens),
        model: selection.jev.stats.model,
      }
    : null;

  const report = {
    kind: "atlas.preflight",
    url: stats.url,
    fetchedAtIso: new Date().toISOString(),
    reproduce: `node bin/atlas.js preflight --url ${stats.url}`,
    manifest: { id: manifest.id, version: manifest.version, contentHash: manifest.contentHash },
    mode: selection.mode,
    assets: {
      count: stats.assetCount,
      totalBytes: stats.totalBytes,
      unknownBytes: stats.unknownBytes,
      byType: stats.byType,
      largest: stats.largest,
      truncated: harvest.truncated,
      failures: harvest.failures,
      $note: harvest.truncated
        ? `asset list capped at ${maxAssets}; the assessment is partial and conservative by construction.`
        : "every discovered asset was sized or recorded unknown.",
    },
    assessment: summarize(assessment),
    rules: summarize(rules),
    agreement: { tier: assessment.tier === rules.tier },
    guard: assessment.guard ?? null,
    jevRun,
    $limitations:
      "Static weight only: no browser ran, nothing executed, nothing rendered. Decode cost, " +
      "render cost, and runtime behavior are invisible here. Run `atlas matrix --url` to confirm or refute.",
  };

  const file = path.join(outDir, "report.json");
  await writeJson(file, report);
  if (!opts.quiet) printReport(report, file);
  return { report, file };
}

/* ── URL safety ─────────────────────────────────────────────────────────── */

/**
 * @param {string} raw
 * @param {{ allowPrivate: boolean; lookup: (hostname: string) => Promise<string> }} opts
 * @returns {Promise<URL>}
 */
async function checkTarget(raw, opts) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`refusing non-http(s) URL: ${url.protocol}//…`);
  }
  if (!opts.allowPrivate) {
    const ip = await opts.lookup(url.hostname);
    if (isPrivateIp(ip)) {
      throw new Error(
        `${url.hostname} resolves to ${ip}, which is not public. Refusing (SSRF guard). ` +
          "Set ATLAS_PREFLIGHT_ALLOW_PRIVATE=1 for local targets.",
      );
    }
  }
  return url;
}

/** @param {(hostname: string) => Promise<string>} _unused */
async function defaultLookup(hostname) {
  if (isIpLiteral(hostname)) return hostname;
  const res = await dns.lookup(hostname);
  return res.address;
}

/** @param {string} host */
function isIpLiteral(host) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

/** @param {string} ip */
export function isPrivateIp(ip) {
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80:") ||
      lower.startsWith("ff")
    );
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] === 0 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254) ||
    p[0] >= 224
  );
}

/** @param {URL} url */
function scrubUrl(url) {
  return `${url.origin}${url.pathname}`;
}

/* ── harvest ────────────────────────────────────────────────────────────── */

/**
 * @param {URL} target
 * @param {{ fetchImpl: typeof fetch; timeoutMs: number }} opts
 */
async function fetchPage(target, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs * 2);
  try {
    const res = await opts.fetchImpl(target.toString(), {
      headers: { "user-agent": "atlas-preflight/0.1 (static weight probe; no JS executed)" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`page fetch failed: HTTP ${res.status} for ${scrubUrl(target)}`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html/i.test(type)) {
      throw new Error(`not an HTML page (content-type: ${type || "unknown"}) — preflight assesses pages, not files`);
    }
    const html = await readCapped(res, PAGE_CAP_BYTES);
    return { html, finalUrl: new URL(res.url || target.toString()) };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error(`page fetch timed out for ${scrubUrl(target)}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {any} res
 * @param {number} cap
 */
async function readCapped(res, cap) {
  if (!res.body || typeof res.body.getReader !== "function") {
    return String(await res.text()).slice(0, cap);
  }
  const reader = res.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new Error(`page exceeds the ${cap}B preflight cap — not a page, or not worth parsing whole`);
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return buf.toString("utf8");
}

/**
 * @param {URL} base
 * @param {string} html
 * @param {{ fetchImpl: typeof fetch; lookup: (h: string) => Promise<string>; allowPrivate: boolean; maxAssets: number; timeoutMs: number }} opts
 */
async function measureAssets(base, html, opts) {
  const urls = extractAssetUrls(base, html).slice(0, opts.maxAssets);
  const truncated = extractAssetUrls(base, html).length > opts.maxAssets;
  /** @type {Record<string, { count: number; bytes: number }>} */
  const byType = {};
  /** @type {Array<{ url: string; type: string; bytes: number | null; reason?: string }>} */
  const sized = [];
  let totalBytes = 0;
  let unknownBytes = 0;
  /** @type {string[]} */
  const failures = [];

  for (const u of urls) {
    const type = classifyType(u);
    byType[type] = byType[type] ?? { count: 0, bytes: 0 };
    byType[type].count += 1;
    if (!opts.allowPrivate) {
      let ip = null;
      try {
        ip = await opts.lookup(u.hostname);
      } catch {
        failures.push(`${scrubUrl(u)}: DNS failed — size unknown`);
        sized.push({ url: scrubUrl(u), type, bytes: null });
        continue;
      }
      if (ip !== null && isPrivateIp(ip)) {
        failures.push(`${scrubUrl(u)}: resolves private — skipped, counted unknown`);
        sized.push({ url: scrubUrl(u), type, bytes: null });
        continue;
      }
    }
    const bytes = await headSize(u, opts);
    if (bytes === null) {
      failures.push(`${scrubUrl(u)}: could not be sized — counted unknown`);
    } else {
      byType[type].bytes += bytes;
      totalBytes += bytes;
    }
    sized.push({ url: scrubUrl(u), type, bytes });
  }

  // Unknowns are stated, not zeroed: the assessment counts them conservatively
  // (see rule-based preflightAssess), and the count travels so a reader can
  // see how much of the verdict is evidence and how much is caution.
  const assets = sized;
  const largest = assets
    .filter((a) => typeof a.bytes === "number")
    .sort((a, b) => /** @type {number} */ (b.bytes) - /** @type {number} */ (a.bytes))
    .slice(0, 5)
    .map((a) => ({ hostHash: sha256(new URL(a.url).host, 8), type: a.type, bytes: /** @type {number} */ (a.bytes) }));

  return {
    assets,
    totalBytes,
    unknownBytes: estimateUnknown(assets),
    byType,
    largest,
    truncated,
    failures: failures.slice(0, 10),
  };
}

/** Assets that could not be sized contribute a nominal unknown mass rather than zero. */
function estimateUnknown(/** @type {Array<{ bytes: number | null }>} */ assets) {
  return assets.filter((a) => a.bytes === null).length * 25_000;
}

/**
 * @param {URL} url
 * @param {{ fetchImpl: typeof fetch; timeoutMs: number }} opts
 * @returns {Promise<number | null>}
 */
async function headSize(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const head = await opts.fetchImpl(url.toString(), { method: "HEAD", signal: ctrl.signal });
    if (head.ok) {
      const len = Number(head.headers.get("content-length"));
      if (Number.isFinite(len) && len >= 0) return len;
    }
    // No usable HEAD (405s, missing length, non-2xx): one ranged byte proves
    // the asset exists and is served, without downloading it.
    const get = await opts.fetchImpl(url.toString(), {
      headers: { Range: "bytes=0-0" },
      signal: ctrl.signal,
    });
    if (get.ok || get.status === 206) {
      const range = get.headers.get("content-range") ?? "";
      const m = /\/(\d+)\s*$/.exec(range);
      if (m) return Number(m[1]);
      const len = Number(get.headers.get("content-length"));
      if (Number.isFinite(len) && len >= 0 && get.status === 200) return len;
    }
    try {
      await get.body?.cancel();
    } catch { /* best effort */ }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {URL} base
 * @param {string} html
 * @returns {URL[]}
 */
export function extractAssetUrls(base, html) {
  /** @type {URL[]} */
  const out = [];
  const seen = new Set();
  const push = (/** @type {string} */ raw) => {
    const cleaned = raw.trim().split(/\s+/)[0];
    if (!cleaned || cleaned.startsWith("data:") || cleaned.startsWith("blob:") || cleaned.startsWith("#")) return;
    try {
      const u = new URL(cleaned, base);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      if (seen.has(u.toString())) return;
      seen.add(u.toString());
      out.push(u);
    } catch { /* relative garbage — skip */ }
  };
  const attr = /(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attr.exec(html)) !== null) push(m[1]);
  const srcset = /srcset\s*=\s*["']([^"']+)["']/gi;
  while ((m = srcset.exec(html)) !== null) {
    for (const part of m[1].split(",")) push(part);
  }
  return out;
}

/** @param {URL} u */
function classifyType(u) {
  const path = u.pathname.toLowerCase();
  if (/\.(mjs|js)(\?|$)/.test(path) || path.endsWith(".js")) return "script";
  if (path.endsWith(".css")) return "style";
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)($|\?)/.test(path)) return "image";
  if (/\.(glb|gltf|usdz|obj|fbx)($|\?)/.test(path)) return "model";
  if (/\.(mp4|webm|mov|m4v)($|\?)/.test(path)) return "video";
  if (/\.(woff2?|ttf|otf|eot)($|\?)/.test(path)) return "font";
  return "other";
}

/** @param {import("../../types/atlas.js").PreflightAssessment} a */
function summarize(a) {
  return {
    tier: a.tier,
    engine: a.engine,
    confidence: a.confidence,
    blowBudget: { score: a.blowBudget.score, levels: a.blowBudget.levels, distribution: a.blowBudget.distribution },
    transferFits: a.transferFits.pTrue,
    distribution: a.tierAnswer.distribution,
    rationale: a.rationale,
  };
}

/** @param {any} report @param {string} file */
function printReport(report, file) {
  banner("PREFLIGHT — static pre-launch assessment");
  const a = report.assessment;
  log.info(`${report.url}: likely tier "${a.tier}" (${a.engine}, confidence ${a.confidence})`);
  log.info(
    `${report.assets.count} assets, ${(report.assets.totalBytes / 1_000_000).toFixed(1)}MB known` +
      (report.assets.unknownBytes ? ` + ${(report.assets.unknownBytes / 1_000_000).toFixed(1)}MB unknown` : "") +
      ` — transfer ${a.transferFits >= 0.5 ? "fits" : "does NOT fit"} (p=${a.transferFits})`,
  );
  log.info(
    report.agreement.tier
      ? "engines agree on the tier."
      : `engines disagree: served "${a.tier}", rules said "${report.rules.tier}" — the matrix will settle it.`,
  );
  if (report.jevRun) {
    log.info(`jev: ${report.jevRun.calls} call(s), ${report.jevRun.inputTokens} input tokens, ≈$${report.jevRun.estimatedUsd}`);
  }
  log.info(report.$limitations);
  log.info(`full report → ${path.relative(process.cwd(), file)}`);
}
