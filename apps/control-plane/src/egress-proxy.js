import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { checkDestination } from "../../../src/net/destination-policy.js";

const DEFAULT_LOOKUP_TIMEOUT_MS = 5000;
const DEFAULT_MAX_TUNNELS = 64;

/**
 * Authorize a browser HTTPS CONNECT request and resolve the exact address the
 * caller must dial. The socket caller must connect to `address`, never resolve
 * `url.hostname` again; that pins DNS at the network connection boundary.
 * This is one layer of worker egress control, not a replacement for a worker
 * network namespace that prevents bypassing the proxy.
 *
 * @param {string} authority HTTP CONNECT authority, such as `site.example:443`
 * @param {string[]} allowedOrigins Exact HTTPS origins from the target contract
 * @param {{ lookupAll?: (hostname: string) => Promise<string[]>; lookupTimeoutMs?: number }} [opts]
 * @returns {Promise<{allowed: boolean; reason: string; url: URL | null; address: string | null; addresses: string[]}>}
 */
export async function authorizeEgressConnect(authority, allowedOrigins, opts = {}) {
  let url;
  try {
    // CONNECT carries authority-form, not a URL. Reject delimiters before URL
    // parsing so a trailing slash or URL-style credentials cannot be normalized
    // into an apparently valid authority.
    if (!authority || !/^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):443$/.test(String(authority))) throw new Error("invalid authority form");
    url = new URL(`https://${String(authority)}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid CONNECT authority");
  } catch {
    return { allowed: false, reason: "invalid HTTPS CONNECT authority", url: null, address: null, addresses: [] };
  }
  if (url.port && url.port !== "443") {
    return { allowed: false, reason: "only HTTPS port 443 is permitted", url: null, address: null, addresses: [] };
  }
  const canonicalOrigins = [];
  for (const raw of allowedOrigins ?? []) {
    try {
      const candidate = new URL(raw);
      if (candidate.protocol !== "https:" || candidate.username || candidate.password || candidate.pathname !== "/" || candidate.search || candidate.hash || raw !== candidate.origin) continue;
      canonicalOrigins.push(candidate.origin);
    } catch { /* invalid contract origin is never made permissive */ }
  }
  if (!canonicalOrigins.includes(url.origin)) {
    return { allowed: false, reason: `origin ${url.origin} is not in the job egress allowlist`, url: null, address: null, addresses: [] };
  }

  const lookupAll = opts.lookupAll ?? (async (hostname) => (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address));
  const timeoutMs = opts.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  const checked = await checkDestination(url.href, {
    allowedOrigins: canonicalOrigins,
    lookupAll: (hostname) => withTimeout(lookupAll(hostname), timeoutMs),
  });
  if (!checked.allowed) {
    return { allowed: false, reason: checked.reason, url: null, address: null, addresses: checked.addresses.map((entry) => entry.address) };
  }
  const address = checked.addresses[0]?.address;
  if (!address) return { allowed: false, reason: "destination resolved to no dialable address", url: null, address: null, addresses: [] };
  return { allowed: true, reason: checked.reason, url, address, addresses: checked.addresses.map((entry) => entry.address) };
}

/**
 * Start a per-job CONNECT-only proxy. The browser must be configured to use
 * this listener with proxy bypass disabled. The containing worker must also
 * have network policy that permits browser egress only to this proxy; otherwise
 * browser flags are defense in depth rather than an isolation boundary.
 *
 * @param {{ allowedOrigins: string[]; host?: string; port?: number; lookupAll?: (hostname: string) => Promise<string[]>; lookupTimeoutMs?: number; maxTunnels?: number; dial?: (address: string, port: number) => net.Socket }} opts
 */
export async function startEgressProxy(opts) {
  if (!opts || !Array.isArray(opts.allowedOrigins) || !opts.allowedOrigins.length) throw new Error("a non-empty per-job HTTPS origin allowlist is required");
  const active = new Set();
  let tunnelCount = 0;
  const maxTunnels = opts.maxTunnels ?? DEFAULT_MAX_TUNNELS;
  if (!Number.isInteger(maxTunnels) || maxTunnels < 1 || maxTunnels > 1024) throw new Error("maxTunnels must be an integer between 1 and 1024");
  const server = http.createServer((_request, response) => {
    response.writeHead(403, { connection: "close", "content-type": "text/plain" });
    response.end("CONNECT only\n");
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxHeadersCount = 32;
  server.on("connection", (socket) => {
    active.add(socket);
    socket.once("close", () => active.delete(socket));
  });
  server.on("connect", async (request, client, head) => {
    if (tunnelCount >= maxTunnels) return rejectClient(client, 503, "worker tunnel limit reached");
    tunnelCount += 1;
    client.once("close", () => { tunnelCount -= 1; });
    try {
      const destination = await authorizeEgressConnect(request.url ?? "", opts.allowedOrigins, opts);
      if (!destination.allowed || !destination.address) return rejectClient(client, 403, "destination refused by job policy");
      if (client.destroyed) return;

      // Connect directly to the checked numeric address. Resolving the hostname
      // again here would reintroduce the DNS rebinding window this proxy closes.
      const dial = opts.dial ?? ((address, port) => net.connect({ host: address, port, family: net.isIP(address) }));
      const upstream = dial(destination.address, 443);
      let established = false;
      active.add(upstream);
      upstream.once("close", () => active.delete(upstream));
      upstream.once("connect", () => {
        if (client.destroyed) return upstream.destroy();
        established = true;
        client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: Atlas-Egress/1\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once("error", () => {
        if (!established) rejectClient(client, 502, "upstream connection failed");
        else client.destroy();
      });
      client.once("close", () => upstream.destroy());
    } catch {
      rejectClient(client, 502, "destination authorization failed");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("egress proxy did not bind a TCP address");

  return {
    host: address.address,
    port: address.port,
    async close() {
      for (const socket of active) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

/** @param {net.Socket} client @param {number} code @param {string} message */
function rejectClient(client, code, message) {
  if (client.destroyed) return;
  const reason = code === 403 ? "Forbidden" : code === 503 ? "Service Unavailable" : "Bad Gateway";
  const body = Buffer.from(`${message}\n`);
  client.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
}

/** @template T @param {Promise<T>} promise @param {number} timeoutMs */
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DNS lookup timed out")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
