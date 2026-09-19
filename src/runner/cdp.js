/**
 * Chrome DevTools Protocol client and browser launcher — zero dependencies.
 *
 * This is the "adversarial device lab" transport. Playwright would normally
 * sit here; it cannot be installed offline, and CDP is what Playwright drives
 * anyway, so the runner talks to it directly. Everything the matrix needs is
 * a CDP domain: Emulation for device metrics and CPU throttling, Network for
 * throughput/latency/packet loss, Browser for permission state, Page for
 * navigation and screenshots, Runtime for bindings.
 *
 * What is emulated here is genuinely emulated — CPU throttling and network
 * shaping are real, applied by the browser. What is *not* real is the
 * hardware: see docs/adr/0001 and the README's "emulated vs. real device"
 * section. Every trace produced through this path is stamped
 * `atlas.emulated: true`.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { MiniWebSocket } from "./ws.js";
import { logger } from "../util/log.js";

const log = logger("cdp");

/* ── browser discovery ───────────────────────────────────────────────────── */

const CANDIDATES = {
  win32: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Chromium/Application/chrome.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/snap/bin/chromium",
  ],
};

/**
 * @returns {string}
 * @throws if no Chromium-family browser can be found
 */
export function findBrowser() {
  const override = process.env.ATLAS_CHROME;
  if (override) {
    if (!existsSync(override)) throw new Error(`ATLAS_CHROME points at a missing file: ${override}`);
    return override;
  }
  const list = CANDIDATES[/** @type {keyof typeof CANDIDATES} */ (process.platform)] ?? CANDIDATES.linux;
  for (const candidate of list) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "No Chromium-family browser found. Install Chrome, Chromium or Edge, " +
      "or set ATLAS_CHROME to the executable path.",
  );
}

/* ── launch ──────────────────────────────────────────────────────────────── */

/**
 * @typedef {object} LaunchedBrowser
 * @property {CdpConnection} connection
 * @property {() => Promise<void>} close
 * @property {string} executable
 * @property {string} wsUrl
 */

/**
 * @param {{ headless?: boolean; extraArgs?: string[]; timeoutMs?: number }} [opts]
 * @returns {Promise<LaunchedBrowser>}
 */
export async function launchBrowser(opts = {}) {
  const executable = findBrowser();
  const headless = opts.headless ?? process.env.ATLAS_HEADFUL !== "1";
  const userDataDir = await mkdtemp(path.join(tmpdir(), "atlas-profile-"));

  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-client-side-phishing-detection",
    "--metrics-recording-only",
    "--mute-audio",
    "--hide-scrollbars",
    // Keep timers running when the headless window is not foregrounded,
    // otherwise the frame counters in the trace are meaningless.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // A synthetic camera, so the camera path can be exercised without a real
    // one and without ever touching a real lens. See PRIVACY.md.
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    // Software GL so WebGL exists in headless and renders the same way on any
    // machine. Screenshot comparison depends on this.
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--force-color-profile=srgb",
    "--font-render-hinting=none",
    "--disable-lcd-text",
    ...(headless ? ["--headless=new"] : []),
    ...(opts.extraArgs ?? []),
    "about:blank",
  ];

  log.debug(`launching ${executable} (${headless ? "headless" : "headed"})`);
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });

  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`browser did not report a DevTools endpoint within ${opts.timeoutMs ?? 30000}ms.\n${stderr.slice(-2000)}`));
    }, opts.timeoutMs ?? 30000);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      stderr += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m) {
        clearTimeout(timer);
        resolve(m[1].trim());
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`browser exited with code ${code} before reporting a DevTools endpoint.\n${stderr.slice(-2000)}`));
    });
  });

  const connection = await CdpConnection.connect(wsUrl);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await connection.send("Browser.close", {}, undefined, 3000);
    } catch {
      /* the browser may already be gone */
    }
    connection.dispose();
    if (!child.killed) child.kill();
    await new Promise((r) => setTimeout(r, 120));
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  };

  return { connection, close, executable, wsUrl };
}

/* ── protocol ────────────────────────────────────────────────────────────── */

export class CdpError extends Error {
  /** @param {string} message @param {string} method @param {unknown} [data] */
  constructor(message, method, data) {
    super(`${method}: ${message}`);
    this.name = "CdpError";
    this.method = method;
    this.data = data;
  }
}

export class CdpConnection extends EventEmitter {
  /** @param {MiniWebSocket} ws */
  constructor(ws) {
    super();
    this.setMaxListeners(0);
    this.ws = ws;
    this._nextId = 1;
    /** @type {Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string; timer: NodeJS.Timeout }>} */
    this._pending = new Map();
    this._disposed = false;

    ws.on("message", (text) => this._onMessage(text));
    ws.on("close", () => this._rejectAll(new Error("CDP connection closed")));
    ws.on("error", (err) => this._rejectAll(err));
  }

  /** @param {string} wsUrl */
  static async connect(wsUrl) {
    const ws = await MiniWebSocket.connect(wsUrl);
    return new CdpConnection(ws);
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string} [sessionId]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this._disposed) return Promise.reject(new Error(`CDP connection disposed (${method})`));
    const id = this._nextId++;
    /** @type {Record<string, unknown>} */
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new CdpError(`timed out after ${timeoutMs}ms`, method));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, method, timer });
      try {
        this.ws.send(JSON.stringify(message));
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(/** @type {Error} */ (e));
      }
    });
  }

  /** @param {string} text */
  _onMessage(text) {
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      log.warn("dropped an unparseable CDP message");
      return;
    }
    if (typeof msg.id === "number") {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this._pending.delete(msg.id);
      if (msg.error) pending.reject(new CdpError(msg.error.message ?? "unknown error", pending.method, msg.error.data));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method) {
      this.emit("event", msg);
      this.emit(msg.method, msg.params, msg.sessionId);
      if (msg.sessionId) this.emit(`${msg.sessionId}:${msg.method}`, msg.params);
    }
  }

  /** @param {Error} err */
  _rejectAll(err) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
  }

  dispose() {
    this._disposed = true;
    this._rejectAll(new Error("CDP connection disposed"));
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * Creates an isolated browser context and a page in it, and attaches.
   * Isolation matters: each profile must get its own cache, storage and
   * permission state, or profile N-1 warms the cache for profile N and the
   * network numbers become fiction.
   *
   * @param {{ url?: string }} [opts]
   * @returns {Promise<CdpSession>}
   */
  async newPage(opts = {}) {
    const { browserContextId } = await this.send("Target.createBrowserContext", {
      disposeOnDetach: true,
    });
    const { targetId } = await this.send("Target.createTarget", {
      url: opts.url ?? "about:blank",
      browserContextId,
    });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return new CdpSession(this, sessionId, targetId, browserContextId);
  }
}

export class CdpSession {
  /**
   * @param {CdpConnection} connection
   * @param {string} sessionId
   * @param {string} targetId
   * @param {string} browserContextId
   */
  constructor(connection, sessionId, targetId, browserContextId) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.browserContextId = browserContextId;
    /** @type {Array<{ event: string; handler: (params: any) => void }>} */
    this._handlers = [];
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  send(method, params, timeoutMs) {
    return this.connection.send(method, params, this.sessionId, timeoutMs);
  }

  /** Browser-domain commands are not session-scoped. */
  sendBrowser(/** @type {string} */ method, /** @type {Record<string, unknown>} */ params, /** @type {number} */ timeoutMs) {
    return this.connection.send(method, params, undefined, timeoutMs);
  }

  /**
   * @param {string} method
   * @param {(params: any) => void} handler
   */
  on(method, handler) {
    const event = `${this.sessionId}:${method}`;
    this.connection.on(event, handler);
    this._handlers.push({ event, handler });
    return this;
  }

  /**
   * Waits for one occurrence of a CDP event.
   * @param {string} method
   * @param {{ timeoutMs?: number; predicate?: (params: any) => boolean }} [opts]
   * @returns {Promise<any>}
   */
  once(method, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 30000;
    return new Promise((resolve, reject) => {
      const event = `${this.sessionId}:${method}`;
      const timer = setTimeout(() => {
        this.connection.off(event, handler);
        reject(new Error(`timed out waiting ${timeoutMs}ms for ${method}`));
      }, timeoutMs);
      /** @param {any} params */
      const handler = (params) => {
        if (opts.predicate && !opts.predicate(params)) return;
        clearTimeout(timer);
        this.connection.off(event, handler);
        resolve(params);
      };
      this.connection.on(event, handler);
    });
  }

  /**
   * @param {string} expression
   * @param {{ awaitPromise?: boolean; timeoutMs?: number }} [opts]
   * @returns {Promise<any>}
   */
  async evaluate(expression, opts = {}) {
    const res = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: opts.awaitPromise ?? false,
      },
      opts.timeoutMs,
    );
    if (res.exceptionDetails) {
      const text = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
      throw new Error(`page evaluate failed: ${text}`);
    }
    return res.result?.value;
  }

  /** @returns {Promise<Buffer>} */
  async screenshot() {
    const { data } = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      optimizeForSpeed: false,
    }, 60000);
    return Buffer.from(data, "base64");
  }

  async detach() {
    for (const { event, handler } of this._handlers) this.connection.off(event, handler);
    this._handlers = [];
    try {
      await this.send("Target.closeTarget", { targetId: this.targetId });
    } catch {
      /* target may already be gone */
    }
    try {
      await this.connection.send("Target.disposeBrowserContext", { browserContextId: this.browserContextId });
    } catch {
      /* context may already be disposed */
    }
  }
}
