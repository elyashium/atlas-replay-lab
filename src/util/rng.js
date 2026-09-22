/**
 * Seeded PRNG for the Node side of the harness.
 *
 * mulberry32: 32-bit state, one multiply-xor round, uniform enough for
 * scripting a gesture path and stable across Node versions because it touches
 * nothing but integer arithmetic. `Math.random()` is unseedable and therefore
 * unusable anywhere a replay has to reproduce a decision.
 *
 * `src/runner/inject.js` and `src/runner/xr-stub.js` each carry their own inline
 * copy of this function. That duplication is not laziness: those two are
 * serialised into a page as source text and cannot import anything. The three
 * copies must stay numerically identical, so the algorithm is written the same
 * way in all three and is small enough to compare by eye.
 */

/**
 * @param {number} seed  coerced to uint32
 * @returns {() => number}  successive draws in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derives an independent stream from the same seed.
 *
 * Two callers that need unrelated draws from one seed must not share a stream,
 * or adding a draw in one silently shifts every value in the other. Mixing with
 * the golden-ratio constant is the same trick `inject.js` uses to keep the
 * experience's stray `Math.random` stream off `__ATLAS__.random`.
 *
 * @param {number} seed
 * @param {number} salt
 * @returns {() => number}
 */
export function streamFrom(seed, salt) {
  return mulberry32((seed ^ Math.imul(salt >>> 0, 0x9e3779b9)) >>> 0);
}
