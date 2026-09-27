import test from "node:test";
import assert from "node:assert/strict";
import { clearSessionCookie, hashPassword, hashToken, isPublicAddress, newId, newSecret, parseCookies, parseOwnedTargetUrl, sessionCookie, verifyPassword } from "../src/security.js";

test("opaque ids and session secrets use expected URL-safe formats", () => {
  assert.match(newId(), /^[0-9a-f-]{36}$/i);
  assert.match(newSecret(), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(hashToken("same").toString("hex"), hashToken("same").toString("hex"));
  assert.notEqual(hashToken("same").toString("hex"), hashToken("other").toString("hex"));
});

test("passwords are salted and verified without storing the plaintext", async () => {
  const first = await hashPassword("correct horse battery");
  const second = await hashPassword("correct horse battery");
  assert.notDeepEqual(first.salt, second.salt);
  assert.notDeepEqual(first.hash, second.hash);
  assert.equal(await verifyPassword("correct horse battery", first.salt, first.hash), true);
  assert.equal(await verifyPassword("wrong password", first.salt, first.hash), false);
  await assert.rejects(hashPassword("short"), /12 to 256/);
});

test("session cookies are HttpOnly, strict same-site and clearable", () => {
  const cookie = sessionCookie("secret", { secure: true, maxAgeSeconds: 20 });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.match(clearSessionCookie(), /Max-Age=0/);
  assert.equal(parseCookies("theme=dark; atlas_session=abc").get("atlas_session"), "abc");
});

test("target onboarding URL accepts only clean HTTPS public hostnames", () => {
  assert.equal(parseOwnedTargetUrl("https://stage.example.org/web/scene").hostname, "stage.example.org");
  for (const url of [
    "http://stage.example.org/", "https://u:p@stage.example.org/", "https://stage.example.org/?token=x",
    "https://127.0.0.1/", "https://localhost/", "https://stage.example.org:8443/",
  ]) assert.throws(() => parseOwnedTargetUrl(url), url);
});

test("public address filter denies private, local and reserved network ranges", () => {
  for (const address of ["0.1.2.3", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.20.1.1", "192.168.1.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
});
