import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { isIP } from "node:net";

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

/** Strictly rejects special-use IPv4/IPv6 destinations before DNS verification. */
export function isPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0) return false;
    return true;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1") return false;
    if (normalized.startsWith("::ffff:")) return false;
    if (/^(fc|fd|fe[89ab])/.test(normalized)) return false;
    if (normalized.startsWith("2001:db8:")) return false;
    return normalized.startsWith("2") || normalized.startsWith("3");
  }
  return false;
}

export function parseOwnedTargetUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error("target URL must be absolute"); }
  if (url.protocol !== "https:") throw new Error("hosted targets must use HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("target URL cannot contain credentials, query strings, or fragments");
  if (url.port && url.port !== "443") throw new Error("hosted targets must use HTTPS on the standard port");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || isIP(hostname)) {
    throw new Error("target must use an owned public DNS hostname");
  }
  return { url, hostname };
}
