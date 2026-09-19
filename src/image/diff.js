/**
 * Screenshot comparison: pixel diff, coarse perceptual diff, and the two
 * measurements the visual invariant needs.
 *
 * A word on `maxAlphaEdgeDrift`. The manifest expresses the visual invariant
 * partly in terms of alpha-edge stability, because that is the property that
 * actually matters for a transparent product layer composited over a camera
 * feed: if the matte starts crawling, the object stops looking anchored. A
 * `Page.captureScreenshot` PNG is the *composited* result and has no usable
 * alpha channel, so this module evaluates it as normalised edge-energy drift
 * between checkpoints instead. That is a proxy, and it is labelled as one
 * everywhere it is reported. Measuring true alpha drift needs a render target
 * read-back, which this project deliberately does not do from page JS.
 *
 * @typedef {import("./png.js").RgbaImage} RgbaImage
 * @typedef {import("../../types/atlas.js").DiffResult} DiffResult
 */

/** Per-channel tolerance. Software GL is stable but not bit-exact across runs. */
export const DEFAULT_CHANNEL_TOLERANCE = 6;

/** Grid resolution used for the perceptual comparison and the divergence box. */
const GRID = 16;

/**
 * @param {RgbaImage} a
 * @param {RgbaImage} b
 * @param {{ channelTolerance?: number }} [opts]
 * @returns {DiffResult}
 */
export function diffImages(a, b, opts = {}) {
  const tol = opts.channelTolerance ?? DEFAULT_CHANNEL_TOLERANCE;

  if (a.width !== b.width || a.height !== b.height) {
    return {
      width: Math.max(a.width, b.width),
      height: Math.max(a.height, b.height),
      pixelDiffRatio: 1,
      perceptualScore: 0,
      firstDivergenceBox: { x: 0, y: 0, w: Math.max(a.width, b.width), h: Math.max(a.height, b.height) },
      identical: false,
    };
  }

  const { width, height } = a;
  const cellW = Math.max(1, Math.ceil(width / GRID));
  const cellH = Math.max(1, Math.ceil(height / GRID));
  const cells = new Int32Array(GRID * GRID);

  let differing = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const dr = Math.abs(a.data[i] - b.data[i]);
      const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
      const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
      const da = Math.abs(a.data[i + 3] - b.data[i + 3]);
      if (dr > tol || dg > tol || db > tol || da > tol) {
        differing++;
        const cx = Math.min(GRID - 1, Math.floor(x / cellW));
        const cy = Math.min(GRID - 1, Math.floor(y / cellH));
        cells[cy * GRID + cx]++;
      }
    }
  }

  const total = width * height;
  const pixelDiffRatio = round6(differing / total);

  return {
    width,
    height,
    pixelDiffRatio,
    perceptualScore: perceptualScore(a, b),
    firstDivergenceBox: differing === 0 ? null : divergenceBox(cells, cellW, cellH, width, height),
    identical: differing === 0,
  };
}

/**
 * Coarse structural similarity: mean absolute difference of a 16x16 luminance
 * grid. Deliberately not SSIM — this only needs to answer "is this the same
 * composition", and a 256-cell mean is robust to the sub-pixel noise that
 * makes a raw pixel diff too twitchy to gate on.
 *
 * @param {RgbaImage} a
 * @param {RgbaImage} b
 * @returns {number} 1 = identical composition, 0 = maximally different
 */
export function perceptualScore(a, b) {
  const ga = lumaGrid(a);
  const gb = lumaGrid(b);
  let sum = 0;
  for (let i = 0; i < ga.length; i++) sum += Math.abs(ga[i] - gb[i]);
  return round6(1 - sum / ga.length / 255);
}

/**
 * @param {RgbaImage} img
 * @returns {Float64Array} GRID*GRID cell luminance means
 */
export function lumaGrid(img) {
  const out = new Float64Array(GRID * GRID);
  const counts = new Int32Array(GRID * GRID);
  const cellW = Math.max(1, Math.ceil(img.width / GRID));
  const cellH = Math.max(1, Math.ceil(img.height / GRID));

  for (let y = 0; y < img.height; y++) {
    const cy = Math.min(GRID - 1, Math.floor(y / cellH));
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const luma = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
      const cell = cy * GRID + Math.min(GRID - 1, Math.floor(x / cellW));
      out[cell] += luma;
      counts[cell]++;
    }
  }
  for (let i = 0; i < out.length; i++) if (counts[i]) out[i] /= counts[i];
  return out;
}

/**
 * Bounding box of the densest contiguous run of differing cells. Reported in
 * the replay output as "where the two runs first stopped agreeing".
 *
 * @param {Int32Array} cells
 * @param {number} cellW
 * @param {number} cellH
 * @param {number} width
 * @param {number} height
 */
function divergenceBox(cells, cellW, cellH, width, height) {
  let peak = 0;
  for (const v of cells) if (v > peak) peak = v;
  const threshold = Math.max(1, peak * 0.25);

  let minX = GRID;
  let minY = GRID;
  let maxX = -1;
  let maxY = -1;
  for (let cy = 0; cy < GRID; cy++) {
    for (let cx = 0; cx < GRID; cx++) {
      if (cells[cy * GRID + cx] < threshold) continue;
      if (cx < minX) minX = cx;
      if (cy < minY) minY = cy;
      if (cx > maxX) maxX = cx;
      if (cy > maxY) maxY = cy;
    }
  }
  if (maxX < 0) return null;
  return {
    x: minX * cellW,
    y: minY * cellH,
    w: Math.min(width - minX * cellW, (maxX - minX + 1) * cellW),
    h: Math.min(height - minY * cellH, (maxY - minY + 1) * cellH),
  };
}

/**
 * Fraction of pixels that differ meaningfully from the image's own modal
 * background colour. Used to answer `forbidBlankFirstFrame`: a frame that is
 * one flat colour scores ~0 whatever that colour is, which catches a black
 * canvas and a white flash equally.
 *
 * @param {RgbaImage} img
 * @returns {number}
 */
export function nonBlankness(img) {
  const { background, total } = modalBackground(img);
  let distinct = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const d =
      Math.abs(img.data[i] - background[0]) +
      Math.abs(img.data[i + 1] - background[1]) +
      Math.abs(img.data[i + 2] - background[2]);
    if (d > 24) distinct++;
  }
  return round6(distinct / total);
}

/**
 * Coverage of the focal product layer: the fraction of pixels that are both
 * distinct from the background AND brighter than it, which is what the
 * additive halo actually is. Compared against `minFocalCoverage`.
 *
 * @param {RgbaImage} img
 * @returns {number}
 */
export function focalCoverage(img) {
  const { background, total } = modalBackground(img);
  const bgLuma = 0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2];
  let focal = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const luma = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
    if (luma > bgLuma + 18) focal++;
  }
  return round6(focal / total);
}

/**
 * Normalised edge energy — a Sobel-magnitude mean over luminance. The drift
 * between two checkpoints' edge energy is the proxy for alpha-edge stability
 * described in this module's header.
 *
 * @param {RgbaImage} img
 * @returns {number}
 */
export function edgeEnergy(img) {
  const { width, height, data } = img;
  if (width < 3 || height < 3) return 0;
  /** @param {number} x @param {number} y */
  const luma = (x, y) => {
    const i = (y * width + x) * 4;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  };
  let sum = 0;
  let count = 0;
  // Stride of 2 keeps this cheap on a 1280x800 screenshot without changing
  // the mean meaningfully.
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const gx =
        -luma(x - 1, y - 1) - 2 * luma(x - 1, y) - luma(x - 1, y + 1) +
        luma(x + 1, y - 1) + 2 * luma(x + 1, y) + luma(x + 1, y + 1);
      const gy =
        -luma(x - 1, y - 1) - 2 * luma(x, y - 1) - luma(x + 1, y - 1) +
        luma(x - 1, y + 1) + 2 * luma(x, y + 1) + luma(x + 1, y + 1);
      sum += Math.hypot(gx, gy);
      count++;
    }
  }
  return count ? round6(sum / count / 1020) : 0;
}

/**
 * Relative drift between two edge-energy readings, in [0,1].
 * @param {number} a
 * @param {number} b
 */
export function edgeDrift(a, b) {
  const denom = Math.max(a, b, 1e-6);
  return round6(Math.abs(a - b) / denom);
}

/**
 * @param {RgbaImage} img
 * @returns {{ background: [number, number, number]; total: number }}
 */
function modalBackground(img) {
  // 5-bit-per-channel histogram: 32768 buckets, cheap and precise enough to
  // find a flat background without being fooled by gradient banding.
  const hist = new Int32Array(32768);
  for (let i = 0; i < img.data.length; i += 4) {
    const key = ((img.data[i] >> 3) << 10) | ((img.data[i + 1] >> 3) << 5) | (img.data[i + 2] >> 3);
    hist[key]++;
  }
  let best = 0;
  let bestCount = -1;
  for (let k = 0; k < hist.length; k++) {
    if (hist[k] > bestCount) {
      bestCount = hist[k];
      best = k;
    }
  }
  return {
    background: [((best >> 10) & 31) << 3, ((best >> 5) & 31) << 3, (best & 31) << 3],
    total: img.width * img.height,
  };
}

/** @param {number} n */
function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
