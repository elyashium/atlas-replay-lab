/**
 * Destination policy: which addresses a run is allowed to reach.
 *
 * This module answers one narrow question — *is this URL permitted to be opened
 * by an Atlas run* — and it answers it for a caller that has already decided
 * the run is authorised. It exists because the same question was previously
 * answered in two places with two different sets of gaps: `isPrivateIp` in
 * `src/preflight/run-preflight.js` and the URL helpers in
 * `apps/control-plane/src/security.js`. Two implementations of an SSRF check is
 * one implementation and one liability, because the weaker one is the one an
 * attacker uses.
 *
 * ## What this is not
 *
 * **This is not a security boundary for untrusted targets.** Phase 2's handoff
 * and `docs/handoffs/security-operations.md` item 2 both say so explicitly, and
 * the reason is structural rather than a matter of covering more ranges:
 *
 *  - **TOCTOU.** Everything here resolves a name and then returns. The browser
 *    resolves the name *again* when it connects. A DNS answer with a one-second
 *    TTL can be public at check time and `169.254.169.254` at connect time, and
 *    no amount of care in this file closes that window. Only enforcement at
 *    connection time — an egress allowlist in the worker's own network namespace
 *    — closes it.
 *  - **Subresources.** This checks a URL. A page loads scripts, iframes,
 *    fonts, XHR, WebSockets, service workers and downloads, each with its own
 *    destination, most of them decided by code that arrives after the check.
 *  - **Redirects.** A caller must re-check every hop. `checkDestination` is
 *    cheap precisely so that re-checking each hop is the obvious thing to do,
 *    but this module cannot force a caller to do it.
 *
 * So the honest framing, which `ISOLATION_REQUIRED_NOTE` states in one line for
 * artifacts: this is a *preflight refusal* that stops the obvious mistakes and
 * the accidental ones, and it is a necessary input to — never a substitute for
 * — the isolated worker with enforced egress that Phase 2 item 2 describes.
 * Until that worker exists, Atlas runs targets the operator has permission to
 * run, and this module's job is to catch the operator's typo, not an adversary.
 *
 * ## Why every resolved address is checked, not the first
 *
 * `dns.lookup(host)` returns one address. A hostname with two A records — one
 * public, one `127.0.0.1` — passes a first-address check about half the time and
 * then connects to whichever the browser picks. `lookupAll` asks for all of them
 * and a single forbidden address refuses the destination. A host that resolves
 * to nothing is also refused: an unresolvable name is not a safe name, it is an
 * unknown one, and unknown fails closed.
 *
 * ## Why numeric host forms are not parsed here
 *
 * `http://2130706433/`, `http://0177.0.0.1/` and `http://0x7f000001/` all mean
 * `127.0.0.1`. This file does not decode them, because `new URL()` already
 * does: the WHATWG host parser canonicalises every legal IPv4 form to dotted
 * decimal before `hostname` is read. The tests assert that, rather than trusting
 * it, so a future runtime that changes the behaviour fails the suite instead of
 * silently opening a hole.
 */

import net from "node:net";
import dns from "node:dns/promises";

/**
 * Bumped when the *decisions* this module makes change, not when a comment does.
 * Written into artifacts next to a verdict so a stored refusal can be traced to
 * the ruleset that produced it — a run refused under version 1 and a run
 * refused under version 2 are not the same evidence.
 */
export const DESTINATION_POLICY_VERSION = 1;

/**
 * The one-line disclaimer that must travel with any artifact claiming a
 * destination was checked. Kept as an exported constant so the wording cannot
 * drift between the report, the control plane and the CLI.
 */
export const ISOLATION_REQUIRED_NOTE =
  "Preflight URL/DNS refusal only. This is not an SSRF boundary: it cannot close the " +
  "resolve-then-connect (TOCTOU) window, and it does not constrain page subresources, " +
  "redirects, WebSockets, service workers or downloads. An isolated worker with " +
  "connection-time egress enforcement is required before running targets the operator " +
  "does not control.";

/**
 * IPv4 blocks that a run may never reach, as CIDR with the reason a reader will
 * want. Sourced from RFC 6890's special-purpose registry rather than the usual
 * three private ranges, because the ranges that actually matter for SSRF are the
 * ones outside that famous trio: `169.254.169.254` (cloud metadata) is
 * link-local, and `100.64.0.0/10` (carrier NAT) is neither private nor public in
 * the sense people assume.
 *
 * @type {ReadonlyArray<{ cidr: string; kind: string; why: string }>}
 */
export const IPV4_FORBIDDEN = Object.freeze([
  { cidr: "0.0.0.0/8", kind: "this-network", why: "unspecified / this host on this network" },
  { cidr: "10.0.0.0/8", kind: "private", why: "RFC 1918 private" },
  { cidr: "100.64.0.0/10", kind: "shared-address-space", why: "carrier-grade NAT; not the public internet" },
  { cidr: "127.0.0.0/8", kind: "loopback", why: "loopback — the worker itself" },
  { cidr: "169.254.0.0/16", kind: "link-local", why: "link-local, includes 169.254.169.254 cloud metadata" },
  { cidr: "172.16.0.0/12", kind: "private", why: "RFC 1918 private" },
  { cidr: "192.0.0.0/24", kind: "protocol-assignments", why: "IETF protocol assignments" },
  { cidr: "192.0.2.0/24", kind: "documentation", why: "TEST-NET-1, documentation only" },
  { cidr: "192.31.196.0/24", kind: "protocol-assignments", why: "AS112-v4" },
  { cidr: "192.52.193.0/24", kind: "protocol-assignments", why: "AMT" },
  { cidr: "192.88.99.0/24", kind: "relay", why: "deprecated 6to4 relay anycast" },
  { cidr: "192.168.0.0/16", kind: "private", why: "RFC 1918 private" },
  { cidr: "192.175.48.0/24", kind: "protocol-assignments", why: "direct delegation AS112" },
  { cidr: "198.18.0.0/15", kind: "benchmarking", why: "network benchmarking" },
  { cidr: "198.51.100.0/24", kind: "documentation", why: "TEST-NET-2, documentation only" },
  { cidr: "203.0.113.0/24", kind: "documentation", why: "TEST-NET-3, documentation only" },
  { cidr: "224.0.0.0/4", kind: "multicast", why: "multicast" },
  { cidr: "240.0.0.0/4", kind: "reserved", why: "reserved, includes the broadcast address" },
]);

/**
 * IPv6 blocks that a run may never reach.
 *
 * Three entries carry an embedded IPv4 address rather than a flat verdict:
 * `::ffff:0:0/96` (v4-mapped), `::/96` (v4-compatible) and `64:ff9b::/96`
 * (NAT64). For those, refusing on the IPv6 prefix alone would be wrong — most
 * v4-mapped addresses are ordinary public hosts — and *allowing* on the prefix
 * alone would be the `::ffff:127.0.0.1` hole. They are marked `embedsIpv4` and
 * the classifier recurses into the embedded address.
 *
 * `2001::/32` (Teredo) and `2002::/16` (6to4) also embed IPv4, but the embedded
 * address is not the destination — it is a relay's. Those are refused outright:
 * a tunnel whose far end is chosen by the peer is not a destination this policy
 * can reason about.
 *
 * @type {ReadonlyArray<{ cidr: string; kind: string; why: string; embedsIpv4?: boolean }>}
 */
export const IPV6_FORBIDDEN = Object.freeze([
  { cidr: "::/128", kind: "unspecified", why: "unspecified address" },
  { cidr: "::1/128", kind: "loopback", why: "loopback — the worker itself" },
  { cidr: "::/96", kind: "v4-compatible", why: "deprecated IPv4-compatible; inspect embedded IPv4", embedsIpv4: true },
  { cidr: "::ffff:0:0/96", kind: "v4-mapped", why: "IPv4-mapped; inspect embedded IPv4", embedsIpv4: true },
  { cidr: "64:ff9b::/96", kind: "nat64", why: "NAT64 translation; inspect embedded IPv4", embedsIpv4: true },
  { cidr: "64:ff9b:1::/48", kind: "nat64-local", why: "local-use NAT64" },
  { cidr: "100::/64", kind: "discard", why: "discard-only address block" },
  { cidr: "2001::/32", kind: "teredo", why: "Teredo tunnel; far end is peer-chosen" },
  { cidr: "2001:20::/28", kind: "orchid", why: "ORCHIDv2" },
  { cidr: "2001:db8::/32", kind: "documentation", why: "documentation only" },
  { cidr: "2002::/16", kind: "6to4", why: "6to4 tunnel; far end is peer-chosen" },
  { cidr: "fc00::/7", kind: "unique-local", why: "unique-local addresses" },
  { cidr: "fe80::/10", kind: "link-local", why: "link-local" },
  { cidr: "ff00::/8", kind: "multicast", why: "multicast" },
]);

/**
 * @typedef {object} AddressClass
 * @property {4 | 6 | null} family     null when the input is not an address at all
 * @property {boolean} allowed
 * @property {string} kind             "public", or the forbidden block's kind
 * @property {string} why              human-readable reason
 * @property {string} [via]            the outer block, when an embedded IPv4 decided it
 */

/* ── address classification ──────────────────────────────────────────────── */

/**
 * Parses dotted-decimal IPv4 into a 32-bit unsigned integer.
 *
 * Deliberately strict: exactly four decimal octets, no leading zeros, nothing
 * else. Leniency here is how `010.0.0.1` becomes a bypass. Callers hand this
 * output of `new URL().hostname`, which is already canonical, so strictness
 * costs nothing legitimate.
 *
 * @param {string} ip
 * @returns {number | null}
 */
function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

/**
 * Parses IPv6 (with `::` compression, and with a trailing dotted-quad as in
 * `::ffff:127.0.0.1`) into eight 16-bit groups.
 *
 * @param {string} ip
 * @returns {number[] | null} eight groups, or null when unparseable
 */
function ipv6ToGroups(ip) {
  let text = ip;
  const zone = text.indexOf("%");
  // A scoped address (`fe80::1%eth0`) is link-local by definition; strip the
  // zone so the prefix match below sees a parseable address rather than failing
  // open on a syntax error.
  if (zone !== -1) text = text.slice(0, zone);

  /** @type {number[]} */
  let tail = [];
  const lastColon = text.lastIndexOf(":");
  const trailing = lastColon === -1 ? "" : text.slice(lastColon + 1);
  if (trailing.includes(".")) {
    const v4 = ipv4ToInt(trailing);
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    text = text.slice(0, lastColon + 1) + "0";
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  /** @param {string} chunk */
  const groups = (chunk) => {
    if (!chunk) return [];
    /** @type {number[]} */
    const out = [];
    for (const piece of chunk.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };

  const head = groups(halves[0] ?? "");
  const rest = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (head === null || rest === null) return null;

  // The placeholder "0" appended above stands in for the dotted quad; drop it
  // and splice the real two groups back on at the end.
  let left = head;
  let right = rest;
  if (tail.length) {
    if (halves.length === 2) right = right.slice(0, -1).concat(tail);
    else left = left.slice(0, -1).concat(tail);
  }

  if (halves.length === 1) return left.length === 8 ? left : null;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  return [...left, ...new Array(fill).fill(0), ...right];
}

/**
 * True when `value` falls inside `cidr`. IPv4 only.
 * @param {number} value
 * @param {string} cidr
 */
function inV4Cidr(value, cidr) {
  const [base, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseInt & mask);
}

/**
 * True when the eight-group address falls inside `cidr`. IPv6 only.
 * @param {number[]} groups
 * @param {string} cidr
 */
function inV6Cidr(groups, cidr) {
  const [base, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  const baseGroups = ipv6ToGroups(base);
  if (!baseGroups) return false;
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((groups[i] & mask) !== (baseGroups[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

/**
 * Classifies a single IP literal.
 *
 * An address this function cannot parse is **forbidden**, not allowed. That is
 * the one decision in this file most likely to be softened by someone chasing a
 * bug, so it is worth stating why: an unparseable address means the policy does
 * not know where the connection goes, and "I don't know" must never be spelled
 * "yes" in a security check.
 *
 * @param {string} ip
 * @returns {AddressClass}
 */
export function classifyAddress(ip) {
  const text = String(ip ?? "").trim();
  const bare = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;

  if (net.isIPv4(bare)) {
    const value = ipv4ToInt(bare);
    if (value === null) {
      return { family: 4, allowed: false, kind: "unparseable", why: "IPv4 address did not parse strictly" };
    }
    for (const block of IPV4_FORBIDDEN) {
      if (inV4Cidr(value, block.cidr)) {
        return { family: 4, allowed: false, kind: block.kind, why: `${bare} is in ${block.cidr} — ${block.why}` };
      }
    }
    return { family: 4, allowed: true, kind: "public", why: `${bare} is a public IPv4 address` };
  }

  if (net.isIPv6(bare) || bare.includes(":")) {
    const groups = ipv6ToGroups(bare);
    if (!groups) {
      return { family: 6, allowed: false, kind: "unparseable", why: `${bare} did not parse as IPv6` };
    }
    for (const block of IPV6_FORBIDDEN) {
      if (!inV6Cidr(groups, block.cidr)) continue;
      if (!block.embedsIpv4) {
        return { family: 6, allowed: false, kind: block.kind, why: `${bare} is in ${block.cidr} — ${block.why}` };
      }
      // Recurse into the embedded IPv4. `::ffff:8.8.8.8` is a public host
      // reached over a v6 socket and there is no reason to refuse it;
      // `::ffff:127.0.0.1` is loopback wearing a hat.
      const embedded = `${(groups[6] >>> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >>> 8) & 0xff}.${groups[7] & 0xff}`;
      const inner = classifyAddress(embedded);
      return {
        family: 6,
        allowed: inner.allowed,
        kind: inner.allowed ? "public" : inner.kind,
        why: `${bare} embeds IPv4 ${embedded}: ${inner.why}`,
        via: block.kind,
      };
    }
    return { family: 6, allowed: true, kind: "public", why: `${bare} is a public IPv6 address` };
  }

  return { family: null, allowed: false, kind: "not-an-address", why: `${text || "(empty)"} is not an IP literal` };
}

/** @param {string} ip */
export function isPublicAddress(ip) {
  return classifyAddress(ip).allowed;
}

/* ── hosts and URLs ──────────────────────────────────────────────────────── */

/**
 * @typedef {object} HostForm
 * @property {"ipv4" | "ipv6" | "dns"} kind
 * @property {string} value   canonical host: dotted-quad, bracketless IPv6, or lowercased name
 */

/**
 * Canonical form of a `URL.hostname`.
 *
 * `URL` has already done the hard part — IPv4 forms are decoded, IDNs are
 * punycoded, IPv6 is compressed and bracketed. This strips the brackets and
 * labels which of the three shapes came back, so callers stop pattern-matching
 * on `includes(":")`.
 *
 * @param {string} hostname
 * @returns {HostForm}
 */
export function canonicalHost(hostname) {
  const text = String(hostname ?? "").trim();
  const bare = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  if (net.isIPv4(bare)) return { kind: "ipv4", value: bare };
  if (net.isIPv6(bare)) return { kind: "ipv6", value: bare };
  return { kind: "dns", value: bare.toLowerCase() };
}

/**
 * @typedef {object} DestinationCheck
 * @property {boolean} allowed
 * @property {string} reason
 * @property {string | null} url            scrubbed, safe to write to an artifact
 * @property {HostForm | null} host
 * @property {Array<{ address: string } & AddressClass>} addresses
 * @property {number} policyVersion
 * @property {string} isolationNote
 */

/**
 * @typedef {object} DestinationOptions
 * @property {(host: string) => Promise<string[]>} [lookupAll]  injectable for tests
 * @property {ReadonlyArray<string>} [allowedOrigins]           when present, the URL's origin must be listed
 * @property {boolean} [allowPrivate]                           local development escape hatch
 */

/**
 * Decides whether one URL may be opened.
 *
 * Returns a verdict rather than throwing. A refusal is an ordinary, expected
 * outcome that a caller wants to record in a report next to the reason — and a
 * caller re-checking twenty redirect hops should not be writing twenty
 * try/catch blocks.
 *
 * @param {string} rawUrl
 * @param {DestinationOptions} [opts]
 * @returns {Promise<DestinationCheck>}
 */
export async function checkDestination(rawUrl, opts = {}) {
  const base = {
    policyVersion: DESTINATION_POLICY_VERSION,
    isolationNote: ISOLATION_REQUIRED_NOTE,
    /** @type {Array<{ address: string } & AddressClass>} */ addresses: [],
  };

  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ...base, allowed: false, reason: "not a URL", url: null, host: null };
  }

  const safe = scrubUrl(url);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ...base, allowed: false, reason: `scheme ${url.protocol} is not http(s)`, url: safe, host: null };
  }
  // Credentials in a URL end up in logs, artifacts and `Referer`. There is no
  // legitimate use of them in a target Atlas is asked to open.
  if (url.username || url.password) {
    return { ...base, allowed: false, reason: "credentials in URL are forbidden", url: safe, host: null };
  }

  const host = canonicalHost(url.hostname);
  if (!host.value) {
    return { ...base, allowed: false, reason: "empty host", url: safe, host: null };
  }

  if (opts.allowedOrigins && !originAllowed(url, opts.allowedOrigins)) {
    return {
      ...base,
      allowed: false,
      reason: `origin ${url.origin} is not in the contract's allowedOrigins`,
      url: safe,
      host,
    };
  }

  if (opts.allowPrivate) {
    return {
      ...base,
      allowed: true,
      reason: "private destinations explicitly permitted by the operator (local development)",
      url: safe,
      host,
    };
  }

  /** @type {string[]} */
  let addresses;
  if (host.kind === "dns") {
    const lookupAll = opts.lookupAll ?? defaultLookupAll;
    try {
      addresses = await lookupAll(host.value);
    } catch (err) {
      return {
        ...base,
        allowed: false,
        reason: `DNS lookup for ${host.value} failed: ${err instanceof Error ? err.message : String(err)}`,
        url: safe,
        host,
      };
    }
    if (!addresses.length) {
      return { ...base, allowed: false, reason: `${host.value} resolved to no addresses`, url: safe, host };
    }
  } else {
    addresses = [host.value];
  }

  const classified = addresses.map((address) => ({ address, ...classifyAddress(address) }));
  const forbidden = classified.filter((entry) => !entry.allowed);

  if (forbidden.length) {
    return {
      ...base,
      addresses: classified,
      allowed: false,
      // Naming every forbidden answer, not just the first, because "one of the
      // four A records is loopback" is the interesting case and a first-match
      // message hides it.
      reason: `refused: ${forbidden.map((f) => f.why).join("; ")}`,
      url: safe,
      host,
    };
  }

  return {
    ...base,
    addresses: classified,
    allowed: true,
    reason:
      host.kind === "dns"
        ? `${host.value} resolved to ${classified.length} public address(es) at check time`
        : `${host.value} is a public address literal`,
    url: safe,
    host,
  };
}

/**
 * Re-checks every hop of a redirect chain and refuses the whole chain if any
 * single hop is forbidden.
 *
 * A chain is checked as a unit because the interesting attack is precisely the
 * one where hop 1 is `https://example.test` and hop 2 is
 * `http://169.254.169.254/latest/meta-data/`. Returning the first refusal with
 * the hop index makes that visible in a report instead of leaving a reader to
 * guess which URL was the problem.
 *
 * @param {ReadonlyArray<string>} chain  in request order, starting with the original URL
 * @param {DestinationOptions} [opts]
 * @returns {Promise<{ allowed: boolean; reason: string; hops: DestinationCheck[]; refusedAt: number | null }>}
 */
export async function checkRedirectChain(chain, opts = {}) {
  /** @type {DestinationCheck[]} */
  const hops = [];
  for (const [index, href] of [...chain].entries()) {
    const check = await checkDestination(href, opts);
    hops.push(check);
    if (!check.allowed) {
      return {
        allowed: false,
        reason: `redirect hop ${index} refused — ${check.reason}`,
        hops,
        refusedAt: index,
      };
    }
  }
  return {
    allowed: true,
    reason: `all ${hops.length} hop(s) resolved to permitted destinations at check time`,
    hops,
    refusedAt: null,
  };
}

/**
 * Whether a URL's origin appears in an allowlist.
 *
 * Compares serialised origins, so `https://a.test:443` and `https://a.test`
 * match (both serialise to the latter) while `http://a.test` does not match
 * `https://a.test`. No wildcard support, deliberately: `*.example.test` in an
 * egress allowlist is how a subdomain takeover becomes an SSRF.
 *
 * @param {URL | string} url
 * @param {ReadonlyArray<string>} allowedOrigins
 */
export function originAllowed(url, allowedOrigins) {
  let origin;
  try {
    origin = (url instanceof URL ? url : new URL(String(url))).origin;
  } catch {
    return false;
  }
  for (const candidate of allowedOrigins ?? []) {
    try {
      if (new URL(String(candidate)).origin === origin) return true;
    } catch {
      // An unparseable allowlist entry matches nothing. The contract validator
      // rejects these at onboarding; here it simply fails closed.
    }
  }
  return false;
}

/**
 * Every address a hostname resolves to, v4 and v6.
 *
 * `{ all: true }` is the entire point — see the module header. `verbatim: true`
 * stops the resolver from reordering by RFC 6724 preference, which is
 * irrelevant when all of them must pass anyway and which would otherwise make
 * the recorded address order depend on the host's network configuration.
 *
 * @param {string} hostname
 * @returns {Promise<string[]>}
 */
async function defaultLookupAll(hostname) {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/**
 * Query, fragment and credentials removed. Everything written to an artifact
 * goes through this: a staging URL's query string is where the session token
 * lives, and a report is a file people paste into chat.
 *
 * @param {URL} url
 */
export function scrubUrl(url) {
  const safe = new URL(url.href);
  safe.username = "";
  safe.password = "";
  safe.search = "";
  safe.hash = "";
  return safe.href;
}
