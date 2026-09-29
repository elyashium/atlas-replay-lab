import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { canonicalHost, isPublicAddress } from "../../../src/net/destination-policy.js";

const scrypt = promisify(scryptCallback);
const PASSWORD_BYTES = 64;

export function newId() {
  return randomUUID();
}

export function newSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest();
}

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new Error("password must be 12 to 256 characters");
  }
  const salt = randomBytes(16);
  const hash = /** @type {Buffer} */ (await scrypt(password, salt, PASSWORD_BYTES, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  return { salt, hash };
}

export async function verifyPassword(password, salt, expected) {
  const actual = /** @type {Buffer} */ (await scrypt(password, salt, PASSWORD_BYTES, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseCookies(header = "") {
  const cookies = new Map();
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (/^[A-Za-z0-9_-]+$/.test(name)) cookies.set(name, value);
  }
  return cookies;
}

export function sessionCookie(token, { secure = false, maxAgeSeconds = 43200 } = {}) {
  return `atlas_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie({ secure = false } = {}) {
  return `atlas_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

// Share one special-address policy between CLI preflight and control-plane
// onboarding so the less complete classifier cannot become the active one.
export { isPublicAddress };

export function parseOwnedTargetUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error("target URL must be absolute"); }
  if (url.protocol !== "https:") throw new Error("hosted targets must use HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("target URL cannot contain credentials, query strings, or fragments");
  if (url.port && url.port !== "443") throw new Error("hosted targets must use HTTPS on the standard port");
  const parsedHost = canonicalHost(url.hostname);
  const hostname = parsedHost.value.replace(/\.$/, "");
  if (!hostname || parsedHost.kind !== "dns" || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("target must use an owned public DNS hostname");
  }
  return { url, hostname };
}
