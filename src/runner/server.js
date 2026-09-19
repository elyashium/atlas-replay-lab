/**
 * Static file server + decision control plane. Zero dependencies, node:http.
 *
 * This is §4.1 integration point 1. `POST /api/decide` takes a capability
 * snapshot posted by a real browser and answers with a TierDecision produced by
 * the *same* `DecisionEngine` instance the CI matrix uses — same module, same
 * question set, same guard, same output shape. The only difference is the
 * `origin` field on the DecisionContext ("production" here, "ci-matrix" there),
 * and that field is passed through to the engines for reporting, not branched
 * on for logic.
 *
 * That is the whole point of the abstraction: there is no "production router"
 * and "test router" to drift apart. There is one router with two callers.
 *
 * @typedef {import("../../types/atlas.js").DecisionEngine} DecisionEngine
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 * @typedef {import("../../types/atlas.js").Trace} Trace
 */

import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fromRoot, writeJson, ensureDir } from "../util/fsx.js";
import { normalizeSnapshot, bucketOf } from "../capability/buckets.js";
import { logger } from "../util/log.js";

const log = logger("server");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".bin": "application/octet-stream",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/** Bodies larger than this are refused outright rather than buffered. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * @typedef {object} AtlasServer
 * @property {http.Server} server
 * @property {number} port
 * @property {string} origin
 * @property {() => Promise<void>} close
 * @property {Trace[]} traces          traces posted by pages this run
 * @property {ServerStats} stats
 */

/**
 * @typedef {object} ServerStats
 * @property {number} requests
 * @property {number} decisions
 * @property {number} tracesReceived
 * @property {number} bytesServed
 */

/**
 * @param {{
 *   manifest: ExperienceManifest;
 *   engine: DecisionEngine;
 *   root?: string;
 *   port?: number;
 *   traceDir?: string | null;
 *   onTrace?: (trace: Trace) => void;
 * }} opts
 * @returns {Promise<AtlasServer>}
 */
export async function startServer(opts) {
  const root = opts.root ?? fromRoot("experience");
  const traceDir = opts.traceDir === undefined ? fromRoot("artifacts", "live-traces") : opts.traceDir;
  /** @type {Trace[]} */
  const traces = [];
  /** @type {ServerStats} */
  const stats = { requests: 0, decisions: 0, tracesReceived: 0, bytesServed: 0 };

  const server = http.createServer((req, res) => {
    stats.requests++;
    handle(req, res).catch((err) => {
      log.warn(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.end();
    });
  });

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);

    // No caching anywhere. A warm cache would silently make the second profile
    // in a matrix run faster than the first, which would make every network
    // number in the report a lie.
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");

    if (pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, manifest: opts.manifest.contentHash, engine: opts.engine.name });
    }

    if (pathname === "/api/manifest") {
      return sendJson(res, 200, opts.manifest);
    }

    if (pathname === "/api/decide") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
      const body = await readBody(req);
      if (body === null) return sendJson(res, 413, { error: "body too large" });

      /** @type {any} */
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { error: "invalid JSON" });
      }

      // Normalise before the engine sees it. Anything the page invented that
      // is not in CapabilitySnapshot is dropped here, which is also what keeps
      // an unexpected field from ever reaching a third-party API.
      const state = normalizeSnapshot(parsed.state);
      const started = process.hrtime.bigint();
      const decision = await opts.engine.routeTier(state, {
        manifest: opts.manifest,
        origin: "production",
        profileId: typeof parsed.profileId === "string" ? parsed.profileId : undefined,
      });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      stats.decisions++;

      log.debug(
        `decide → ${decision.tier}/${decision.path} ` +
          `(${decision.engine}, confidence ${decision.confidence.toFixed(2)}, ${elapsedMs.toFixed(1)}ms)`,
      );

      return sendJson(res, 200, {
        decision,
        bucket: bucketOf(state),
        decideLatencyMs: Math.round(elapsedMs * 100) / 100,
      });
    }

    if (pathname === "/api/trace") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
      const body = await readBody(req);
      if (body === null) return sendJson(res, 413, { error: "body too large" });
      /** @type {Trace} */
      let trace;
      try {
        trace = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { error: "invalid JSON" });
      }
      traces.push(trace);
      stats.tracesReceived++;
      opts.onTrace?.(trace);
      if (traceDir) {
        await ensureDir(traceDir);
        await writeJson(path.join(traceDir, `${trace.traceId}.json`), trace);
      }
      return sendJson(res, 200, { ok: true, traceId: trace.traceId });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "GET only" });
    }

    // ── static ────────────────────────────────────────────────────────────
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(root, rel);
    // Path traversal guard: resolve, then confirm the result is still inside
    // the served root.
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      return sendJson(res, 403, { error: "forbidden" });
    }

    /** @type {import("node:fs").Stats} */
    let info;
    try {
      info = await stat(filePath);
    } catch {
      return sendJson(res, 404, { error: "not found", path: rel });
    }
    if (info.isDirectory()) return sendJson(res, 404, { error: "not found", path: rel });

    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("Content-Length", String(info.size));
    stats.bytesServed += info.size;
    if (req.method === "HEAD") return void res.end();

    await new Promise((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on("error", reject);
      stream.on("end", resolve);
      stream.pipe(res);
    });
  }

  const port = await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("server.address() did not return an AddressInfo"));
    });
  });

  const origin = `http://127.0.0.1:${port}`;
  log.debug(`serving ${root} on ${origin}`);

  return {
    server,
    port,
    origin,
    traces,
    stats,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<string | null>} null when the body exceeded the cap
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(body.length));
  res.end(body);
}
