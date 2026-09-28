import test from "node:test";
import assert from "node:assert/strict";
import {
  DESTINATION_POLICY_VERSION,
  ISOLATION_REQUIRED_NOTE,
  canonicalHost,
  checkDestination,
  checkRedirectChain,
  classifyAddress,
  isPublicAddress,
  originAllowed,
  scrubUrl,
} from "../src/net/destination-policy.js";

/** A lookup that always answers with the given addresses. */
const resolvesTo = (/** @type {string[]} */ ...addresses) => async () => addresses;

test("public v4 and v6 literals are permitted", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.114.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
    const verdict = classifyAddress(ip);
    assert.equal(verdict.allowed, true, `${ip} should be public: ${verdict.why}`);
  }
});

test("every IANA special-purpose v4 range is refused, not just RFC 1918", () => {
  const cases = {
    "0.0.0.0": "this-network",
    "10.1.2.3": "private",
    "100.100.0.1": "shared-address-space",
    "127.0.0.1": "loopback",
    "169.254.169.254": "link-local",
    "172.20.0.5": "private",
    "192.0.0.8": "protocol-assignments",
    "192.0.2.7": "documentation",
    "192.168.1.1": "private",
    "198.18.0.1": "benchmarking",
    "198.51.100.4": "documentation",
    "203.0.113.9": "documentation",
    "224.0.0.1": "multicast",
    "255.255.255.255": "reserved",
  };
  for (const [ip, kind] of Object.entries(cases)) {
    const verdict = classifyAddress(ip);
    assert.equal(verdict.allowed, false, `${ip} must be refused`);
    assert.equal(verdict.kind, kind, `${ip} classified as ${verdict.kind}`);
  }
});

test("cloud metadata is refused through every v6 spelling of the same address", () => {
  // This is the bug the shared module exists to remove. The previous prefix-only
  // check treated anything that was not ::1, fc/fd, fe80: or ff as public, so
  // every mapped and NAT64 form of a private address passed.
  for (const ip of [
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::169.254.169.254",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::192.168.0.1",
  ]) {
    const verdict = classifyAddress(ip);
    assert.equal(verdict.allowed, false, `${ip} must be refused`);
  }
});

test("v6 special ranges including tunnels and unique-local are refused", () => {
  const cases = {
    "::": "unspecified",
    "::1": "loopback",
    "fd00::1": "unique-local",
    "fc00::1": "unique-local",
    "fe80::1": "link-local",
    "fe80::1%eth0": "link-local",
    "ff02::1": "multicast",
    "2001:db8::1": "documentation",
    "2001::abcd": "teredo",
    "2002:c000:204::1": "6to4",
    "100::1": "discard",
    "64:ff9b:1::1": "nat64-local",
  };
  for (const [ip, kind] of Object.entries(cases)) {
    const verdict = classifyAddress(ip);
    assert.equal(verdict.allowed, false, `${ip} must be refused`);
    assert.equal(verdict.kind, kind, `${ip} classified as ${verdict.kind}`);
  }
});

test("an address the policy cannot parse fails closed", () => {
  for (const ip of ["", "not-an-ip", "1.2.3", "1.2.3.4.5", "010.0.0.1", "0x7f000001", "::gggg", "1:2:3:4:5:6:7:8:9"]) {
    assert.equal(isPublicAddress(ip), false, `${ip} must not be treated as public`);
  }
});

test("URL parsing canonicalises alternate numeric host forms before the policy sees them", () => {
  // Decimal, octal and hex spellings of 127.0.0.1 are a classic bypass. The
  // policy does not decode them; it relies on WHATWG URL doing so. If a runtime
  // ever stops doing that, this assertion fails rather than the check silently
  // opening.
  for (const raw of ["http://2130706433/", "http://0177.0.0.1/", "http://0x7f000001/", "http://127.1/"]) {
    assert.equal(canonicalHost(new URL(raw).hostname).value, "127.0.0.1", raw);
  }
});

test("canonicalHost labels the three host shapes and strips v6 brackets", () => {
  assert.deepEqual(canonicalHost("8.8.8.8"), { kind: "ipv4", value: "8.8.8.8" });
  assert.deepEqual(canonicalHost("[::1]"), { kind: "ipv6", value: "::1" });
  assert.deepEqual(canonicalHost("Stage.Example.TEST"), { kind: "dns", value: "stage.example.test" });
});

test("checkDestination refuses non-http schemes, credentials and unresolvable names", async () => {
  const bad = await checkDestination("file:///etc/passwd");
  assert.equal(bad.allowed, false);
  assert.match(bad.reason, /scheme/);

  const creds = await checkDestination("https://user:pw@stage.example.test/");
  assert.equal(creds.allowed, false);
  assert.match(creds.reason, /credentials/);

  const empty = await checkDestination("https://stage.example.test/", { lookupAll: resolvesTo() });
  assert.equal(empty.allowed, false);
  assert.match(empty.reason, /no addresses/);

  const failed = await checkDestination("https://stage.example.test/", {
    lookupAll: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  assert.equal(failed.allowed, false);
  assert.match(failed.reason, /DNS lookup/);
});

test("one forbidden answer among several refuses the whole destination", async () => {
  // A host with two A records, one public and one loopback, passes a
  // first-address check about half the time. It must never pass this one.
  const split = await checkDestination("https://stage.example.test/ar", {
    lookupAll: resolvesTo("93.184.216.34", "127.0.0.1"),
  });
  assert.equal(split.allowed, false);
  assert.equal(split.addresses.length, 2);
  assert.match(split.reason, /loopback/);

  const clean = await checkDestination("https://stage.example.test/ar", {
    lookupAll: resolvesTo("93.184.216.34", "2606:4700::1111"),
  });
  assert.equal(clean.allowed, true);
  assert.equal(clean.addresses.length, 2);
  assert.equal(clean.policyVersion, DESTINATION_POLICY_VERSION);
  assert.equal(clean.isolationNote, ISOLATION_REQUIRED_NOTE);
});

test("the recorded URL is scrubbed of secrets even when the destination is refused", async () => {
  const refused = await checkDestination("https://stage.example.test/ar?token=secret#private", {
    lookupAll: resolvesTo("10.0.0.1"),
  });
  assert.equal(refused.allowed, false);
  assert.equal(refused.url, "https://stage.example.test/ar");
  assert.equal(scrubUrl(new URL("https://a.test/p?t=s#f")), "https://a.test/p");
});

test("allowedOrigins is enforced without wildcards", async () => {
  const opts = { lookupAll: resolvesTo("93.184.216.34"), allowedOrigins: ["https://stage.example.test"] };
  assert.equal((await checkDestination("https://stage.example.test/ar", opts)).allowed, true);
  const other = await checkDestination("https://cdn.example.test/lib.js", opts);
  assert.equal(other.allowed, false);
  assert.match(other.reason, /allowedOrigins/);

  assert.equal(originAllowed("https://a.test:443/x", ["https://a.test"]), true);
  assert.equal(originAllowed("http://a.test/x", ["https://a.test"]), false);
  assert.equal(originAllowed("https://evil.a.test/x", ["https://*.a.test"]), false);
  assert.equal(originAllowed("https://a.test/x", ["not a url"]), false);
});

test("allowPrivate is an explicit operator decision, recorded in the reason", async () => {
  const local = await checkDestination("http://127.0.0.1:8080/", { allowPrivate: true });
  assert.equal(local.allowed, true);
  assert.match(local.reason, /explicitly permitted/);
});

test("a redirect chain is refused at the first forbidden hop, with its index", async () => {
  const chain = [
    "https://stage.example.test/ar",
    "https://stage.example.test/ar/step-2",
    "http://169.254.169.254/latest/meta-data/",
  ];
  const lookupAll = async (/** @type {string} */ host) =>
    host === "stage.example.test" ? ["93.184.216.34"] : ["169.254.169.254"];
  const verdict = await checkRedirectChain(chain, { lookupAll });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.refusedAt, 2);
  assert.equal(verdict.hops.length, 3);
  assert.match(verdict.reason, /hop 2/);

  const ok = await checkRedirectChain(chain.slice(0, 2), { lookupAll });
  assert.equal(ok.allowed, true);
  assert.equal(ok.refusedAt, null);
});

test("the isolation disclaimer states that this is not an SSRF boundary", () => {
  // The wording is asserted, not just its presence: an artifact that claims a
  // destination was "checked" without this caveat overstates what ran.
  assert.match(ISOLATION_REQUIRED_NOTE, /not an SSRF boundary/);
  assert.match(ISOLATION_REQUIRED_NOTE, /TOCTOU/);
  assert.match(ISOLATION_REQUIRED_NOTE, /subresources/);
});
