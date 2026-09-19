import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted recursively, no insertion-order
 * dependence. Every hash in Atlas goes through this so that two structurally
 * identical objects always hash the same regardless of how they were built.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value)).sort()) {
      out[key] = sortValue(/** @type {Record<string, unknown>} */ (value)[key]);
    }
    return out;
  }
  // Normalise -0 and non-finite numbers so they never produce unstable hashes.
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (Object.is(value, -0)) return 0;
  return value;
}

/**
 * @param {unknown} value
 * @param {number} [length] truncate the hex digest to this many chars
 * @returns {string}
 */
export function sha256(value, length) {
  const hex = createHash("sha256").update(canonicalJson(value)).digest("hex");
  return length ? hex.slice(0, length) : hex;
}

/**
 * Deterministic 32-bit string hash, used for seeding the replay RNG from a
 * trace id so that a given trace always replays with the same random stream.
 *
 * @param {string} str
 * @returns {number}
 */
export function seedFromString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
