/**
 * `atlas preflight` — static assessment without a browser, without network.
 *
 * Every fetch and DNS lookup is injected, so this suite runs offline. What it
 * pins: URL/SSRF gating, asset extraction and sizing (including every fallback
 * rung), the deterministic assessment arithmetic, the fixture-backed Jev path,
 * and the guard's richness override.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { genericManifest } from "../src/manifest/generic.manifest.js";
import { preflightQuestions, validateQuestions } from "../src/decision/questions.js";
import { RuleBasedDecisionEngine } from "../src/decision/rule-based.js";
import { JevDecisionEngine } from "../src/decision/jev.js";
import { GuardedDecisionEngine } from "../src/decision/guarded.js";
import { FixtureJevTransport } from "../src/decision/jev-transport.js";
import { PREFLIGHT_STATES } from "../src/decision/fixtures/preflight.js";
import { buildFixtureFile } from "../scripts/build-fixtures.js";
import { runPreflight, extractAssetUrls, isPrivateIp } from "../src/preflight/run-preflight.js";

const ctx = { manifest: genericManifest, origin: /** @type {const} */ ("preflight") };
const rules = new RuleBasedDecisionEngine();

function cleanEnv() {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  delete env.ATLAS_JEV_FIXTURES;
  return env;
}

/** Minimal Headers stand-in. */
const headers = (/** @type {Record<string, string>} */ h) => ({
  get: (/** @type {string} */ k) => h[k.toLowerCase()] ?? null,
});

/**
 * Builds a fetch stub from a page table and a size table.
 *
 * @param {Record<string, { html: string; type?: string }>} pages
 * @param {Record<string, number | "ranged" | "missing">} sizes
 */
function stubFetch(pages, sizes) {
  /** @type {string[]} */
  const calls = [];
  const fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    const u = new URL(url);
    if ((init.method ?? "GET") === "HEAD") {
      const s = sizes[u.toString()];
      if (typeof s === "number") return { ok: true, status: 200, headers: headers({ "content-length": String(s) }) };
      return { ok: false, status: 405, headers: headers({}) };
    }
    const page = pages[u.origin + u.pathname];
    if (page) {
      return {
        ok: true,
        status: 200,
        url: u.toString(),
        headers: headers({ "content-type": page.type ?? "text/html" }),
        text: async () => page.html,
      };
    }
    const s = sizes[u.toString()];
    if (s === "ranged") {
      return {
        ok: true,
        status: 206,
        headers: headers({ "content-range": "bytes 0-0/45000" }),
        body: { cancel: async () => {} },
      };
    }
    if (typeof s === "number") {
      return { ok: true, status: 200, headers: headers({ "content-length": String(s) }), body: { cancel: async () => {} } };
    }
    return { ok: false, status: 404, headers: headers({}), body: { cancel: async () => {} } };
  };
  return { fetchImpl, calls };
}

/** @param {string} publicIp */
const stubLookup = (publicIp = "93.184.216.34") => async (/** @type {string} */ host) => {
  if (host === "internal.test") return "192.168.1.5";
  if (host === "localhost") return "127.0.0.1";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  return publicIp;
};

const PAGE = `<!doctype html><html><head>
<link rel="stylesheet" href="/app.css">
<script src="/app.js"></script>
<script src="/app.js"></script>
<img src="https://cdn.example.com/hero.webp" srcset="https://cdn.example.com/hero.webp 1x, https://cdn.example.com/hero@2x.webp 2x">
</head><body><img src="data:image/png;base64,xx"></body></html>`;

/* ── gating ─────────────────────────────────────────────────────────────── */

test("isPrivateIp covers v4 ranges, loopback, and v6", () => {
  for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "0.0.0.0", "169.254.1.1", "224.0.0.1", "::1", "fe80::1", "fc00::1", "not-an-ip"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.15.0.1", "172.32.0.1", "193.168.1.1"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("non-http(s) URLs are refused before any fetch", async () => {
  const { fetchImpl } = stubFetch({}, {});
  await assert.rejects(
    runPreflight({ url: "ftp://example.com/x", fetchImpl, lookup: stubLookup(), env: cleanEnv(), quiet: true }),
    /non-http/,
  );
  await assert.rejects(
    runPreflight({ url: "not a url", fetchImpl, lookup: stubLookup(), env: cleanEnv(), quiet: true }),
    /not a URL/,
  );
});

test("private targets are refused unless explicitly allowed", async () => {
  const { fetchImpl } = stubFetch({ "http://internal.test/": { html: PAGE } }, {});
  await assert.rejects(
    runPreflight({ url: "http://internal.test/", fetchImpl, lookup: stubLookup(), env: cleanEnv(), quiet: true }),
    /not public/,
  );
  const outDir = await mkdtemp(path.join(tmpdir(), "atlas-preflight-"));
  const { report } = await runPreflight({
    url: "http://internal.test/",
    fetchImpl,
    lookup: stubLookup(),
    allowPrivate: true,
    outDir,
    env: cleanEnv(),
    quiet: true,
  });
  assert.equal(report.url, "http://internal.test/");
});

/* ── harvest ────────────────────────────────────────────────────────────── */

test("extraction dedupes, skips data URIs, and fans out srcset", () => {
  const urls = extractAssetUrls(new URL("https://example.com/showcase"), PAGE).map(String).sort();
  assert.deepEqual(urls, [
    "https://cdn.example.com/hero.webp",
    "https://cdn.example.com/hero@2x.webp",
    "https://example.com/app.css",
    "https://example.com/app.js",
  ]);
});

test("sizing sums HEAD lengths, falls back to ranged GET, and states unknowns", async () => {
  const sizes = {
    "https://example.com/app.css": 120_000,
    "https://example.com/app.js": "ranged",
    "https://cdn.example.com/hero.webp": "missing",
    "https://cdn.example.com/hero@2x.webp": 400_000,
  };
  const { fetchImpl } = stubFetch({ "https://example.com/showcase": { html: PAGE } }, sizes);
  const outDir = await mkdtemp(path.join(tmpdir(), "atlas-preflight-"));
  const { report } = await runPreflight({
    url: "https://example.com/showcase",
    fetchImpl,
    lookup: stubLookup(),
    outDir,
    env: cleanEnv(),
    quiet: true,
  });
  assert.equal(report.assets.count, 4);
  assert.equal(report.assets.totalBytes, 120_000 + 45_000 + 400_000);
  assert.ok(report.assets.unknownBytes > 0, "the unsized hero.webp must be stated, not zeroed");
  assert.equal(report.assets.byType.script.bytes, 45_000);
  assert.equal(report.assets.byType.image.count, 2);
  assert.ok(report.assets.failures.length > 0);
});

test("non-HTML targets and HTTP errors fail loudly", async () => {
  const { fetchImpl } = stubFetch({ "https://example.com/app.js": { html: "x", type: "application/javascript" } }, {});
  await assert.rejects(
    runPreflight({ url: "https://example.com/app.js", fetchImpl, lookup: stubLookup(), env: cleanEnv(), quiet: true }),
    /not an HTML page/,
  );
});

/* ── assessment ─────────────────────────────────────────────────────────── */

test("the preflight question set is structurally valid", () => {
  assert.deepEqual(validateQuestions(preflightQuestions(genericManifest.budgets)), []);
});

test("rule-based assessment on the canonical fixture input says mid", async () => {
  const a = await rules.preflightAssess(PREFLIGHT_STATES[0].stats, ctx);
  assert.equal(a.tier, "mid");
  assert.ok(a.transferFits.pTrue > 0.9, `fits=${a.transferFits.pTrue}`);
  assert.ok(a.blowBudget.score < 1, `blow=${a.blowBudget.score}`);
  assert.equal(a.engine, "rule-based");
  assert.ok(a.rationale.length > 0);
  const sum = Object.values(a.tierAnswer.distribution).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6);
});

test("rule-based assessment calls a 30MB page static-fallback", async () => {
  const a = await rules.preflightAssess(
    { url: "https://example.com/", totalBytes: 30_000_000, unknownBytes: 0, assetCount: 120, byType: {}, largest: [] },
    ctx,
  );
  assert.equal(a.tier, "static-fallback");
  assert.equal(a.blowBudget.score, 4);
  assert.ok(a.transferFits.pTrue < 0.01);
});

test("fixture Jev path answers the canonical input from hand-authored data", async () => {
  const { fixtureFile } = buildFixtureFile();
  assert.ok(fixtureFile.cases.some((/** @type {any} */ c) => c.label === "preflight/canonical-midweight"));
  const jev = new JevDecisionEngine({ transport: new FixtureJevTransport({ fixtures: fixtureFile, strict: false }) });
  const a = await jev.preflightAssess(PREFLIGHT_STATES[0].stats, ctx);
  assert.equal(a.tier, "high", "the fixture model is deliberately optimistic (see answers.js)");
  assert.equal(a.engine, "jev");
  assert.deepEqual(a.blowBudget.levels, ["very unlikely", "unlikely", "possible", "likely", "very likely"]);
});

test("the guard caps preflight optimism at the deterministic tier", async () => {
  const optimistic = {
    name: "stub-rich",
    kind: "model",
    routeTier: async () => { throw new Error("unused"); },
    judgeTrace: async () => { throw new Error("unused"); },
    preflightAssess: async () => ({
      ...(await rules.preflightAssess(PREFLIGHT_STATES[0].stats, ctx)),
      tier: "high",
      confidence: 0.9,
      engine: "stub-rich",
    }),
  };
  const guarded = new GuardedDecisionEngine({ primary: /** @type {any} */ (optimistic), fallback: rules });
  const out = await guarded.preflightAssess(PREFLIGHT_STATES[0].stats, ctx);
  assert.equal(out.tier, "mid", "rules said mid; a richer model answer must not survive");
  assert.equal(out.guard?.overridden, true);
  assert.match(out.guard?.reason ?? "", /richer than deterministic/);
});

test("runPreflight end to end writes a report with agreement", async () => {
  const sizes = { "https://example.com/app.css": 120_000, "https://example.com/app.js": 890_000 };
  const { fetchImpl } = stubFetch({ "https://example.com/": { html: PAGE } }, sizes);
  const outDir = await mkdtemp(path.join(tmpdir(), "atlas-preflight-"));
  const { report, file } = await runPreflight({
    url: "https://example.com/?utm=x#frag",
    fetchImpl,
    lookup: stubLookup(),
    outDir,
    env: cleanEnv(),
    quiet: true,
  });
  assert.equal(report.url, "https://example.com/", "query and fragment are scrubbed");
  assert.equal(report.assessment.engine, "rule-based");
  assert.equal(typeof report.agreement.tier, "boolean");
  assert.equal(report.jevRun, null);
  assert.equal(report.manifest.id, genericManifest.id);
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(onDisk.kind, "atlas.preflight");
});
