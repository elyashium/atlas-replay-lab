/**
 * Viewer render ladder: tier id → renderer settings.
 *
 * Pure data + pure function, importable from Node tests and from the viewer
 * page alike — which is why it lives here instead of inside `viewer.js`. The
 * tier itself comes from the same `/api/decide` control plane Orbital uses
 * (same engine, same guard, generic manifest); this file only says what the
 * viewer *does* with the answer.
 *
 * The ladder descends in cost and in fidelity together: fewer device pixels,
 * fewer triangles, cheaper shading, and finally no WebGL loop at all. Every
 * rung is deterministic given the same sidecar: triangle subsets stride from
 * index 0, the start orientation is fixed, and nothing reads the clock except
 * the drag handler (whose input is the driver's seeded script).
 */

 /**
  * @typedef {object} ViewerSettings
  * @property {number} dprCap        backing-store pixel ratio ceiling
  * @property {number} triCap        triangles drawn per mesh (stride from 0 past this)
  * @property {"lit" | "flat"} shading
  * @property {boolean} animate      whether the render loop runs (false = one frame + poster)
  */

/** @type {Record<string, ViewerSettings>} */
const LADDER = {
  high: { dprCap: 2, triCap: Infinity, shading: "lit", animate: true },
  mid: { dprCap: 1.5, triCap: 30_000, shading: "lit", animate: true },
  low: { dprCap: 1, triCap: 12_000, shading: "flat", animate: true },
  "static-fallback": { dprCap: 1, triCap: 0, shading: "flat", animate: false },
};

/**
 * @param {string} tierId
 * @returns {ViewerSettings} unknown ids fall through to the poster, never to a guess
 */
export function viewerTierSettings(tierId) {
  return LADDER[tierId] ?? LADDER["static-fallback"];
}

/** @returns {string[]} */
export function viewerTiers() {
  return Object.keys(LADDER);
}
