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
  // Every animating rung is lit, deliberately: the probe's blank detector reads
  // luma variance, and a flat-shaded frame is near-uniform enough to score as
  // blank (measured: a flat orange pyramid read 0.010 coverage and failed the
  // visual invariant it was plainly satisfying). Shading cost is negligible
  // next to pixels and triangles anyway; the ladder descends on those.
  high: { dprCap: 2, triCap: Infinity, shading: "lit", animate: true },
  mid: { dprCap: 1.5, triCap: 30_000, shading: "lit", animate: true },
  low: { dprCap: 1, triCap: 12_000, shading: "lit", animate: true },
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

/* ── camera math (pure; shared with viewer.js so framing is unit-testable) ── */

/**
 * Fit distance for bounds at a fixed orientation: bounding sphere against the
 * tighter of the two frusta, so drag rotation can never push a corner out of
 * frame. Deterministic given the same inputs — which is what makes checkpoint
 * screenshots comparable.
 *
 * @param {{ min: number[]; max: number[] }} bounds
 * @param {number} aspect   canvas width ÷ height
 * @param {number} [fovDeg] vertical field of view, full angle
 * @param {number} [margin] headroom multiplier
 */
export function frameDistance(bounds, aspect, fovDeg = 35, margin = 1.2) {
  const dx = bounds.max[0] - bounds.min[0];
  const dy = bounds.max[1] - bounds.min[1];
  const dz = bounds.max[2] - bounds.min[2];
  const radius = Math.max(Math.hypot(dx, dy, dz) / 2, 1e-6);
  const halfV = ((fovDeg * Math.PI) / 360);
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  return (radius / Math.sin(Math.min(halfV, halfH))) * margin;
}

/** @param {number[]} eye @param {number[]} center */
export function lookAt(eye, center) {
  const z = norm3([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const x = norm3(cross([0, 1, 0], z));
  const y = cross(z, x);
  return [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ];
}

/** @param {number} fovDeg @param {number} aspect @param {number} near @param {number} far */
export function perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

/** Column-major C = A × B, matching uniformMatrix4fv with transpose=false. */
export function multiply(a, b) {
  const c = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      c[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return c;
}

/** @param {number[]} a @param {number[]} b */
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** @param {number[]} a @param {number[]} b */
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** @param {number[]} v */
function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
