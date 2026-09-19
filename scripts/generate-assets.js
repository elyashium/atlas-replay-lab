/**
 * Generates the Orbital texture and geometry assets.
 *
 * These are real files with real bytes that really cross the throttled link.
 * Nothing about the transfer is simulated — `Network.emulateNetworkConditions`
 * shapes the actual socket, and a 900KB texture on a 1.1Mbps link takes the
 * ~6.5 seconds it takes.
 *
 * The textures are procedural: multi-octave value noise, a radial ring
 * structure, and a fine grain layer. The grain amplitude is tuned by binary
 * search so the encoded PNG lands within a few percent of the byte budget the
 * manifest declares for that tier. That tuning is why the sizes are
 * predictable; the bytes themselves are ordinary image data, not padding.
 *
 * Everything here is seeded, so `npm run assets` on two machines produces
 * byte-identical files and the manifest hash stays meaningful.
 *
 * Usage:  node scripts/generate-assets.js
 */

import path from "node:path";
import { encodePng } from "../src/image/png.js";
import { fromRoot, ensureDir, writeFileEnsured, writeJson } from "../src/util/fsx.js";
import { orbitalManifest } from "../src/manifest/atlas-orbital.manifest.js";
import { logger, banner } from "../src/util/log.js";

const log = logger("assets");

const OUT_DIR = fromRoot("experience", "assets", "generated");

/** How close to the declared budget is close enough. */
const SIZE_TOLERANCE = 0.06;

/** @param {number} seed */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic 2D value noise with bilinear interpolation.
 * @param {number} seed
 * @param {number} gridSize
 */
function valueNoise(seed, gridSize) {
  const rnd = mulberry32(seed);
  const grid = new Float32Array((gridSize + 1) * (gridSize + 1));
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();

  /** @param {number} u @param {number} v in [0,1) */
  return (u, v) => {
    const x = u * gridSize;
    const y = v * gridSize;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const idx = /** @param {number} a @param {number} b */ (a, b) =>
      grid[Math.min(gridSize, b) * (gridSize + 1) + Math.min(gridSize, a)];
    const top = idx(x0, y0) * (1 - sx) + idx(x0 + 1, y0) * sx;
    const bot = idx(x0, y0 + 1) * (1 - sx) + idx(x0 + 1, y0 + 1) * sx;
    return top * (1 - sy) + bot * sy;
  };
}

/**
 * @param {{ size: number; seed: number; grain: number; hueShift: number }} opts
 * @returns {import("../src/image/png.js").RgbaImage}
 */
function renderTexture(opts) {
  const { size, seed, grain, hueShift } = opts;
  const data = Buffer.allocUnsafe(size * size * 4);

  const n1 = valueNoise(seed + 1, 8);
  const n2 = valueNoise(seed + 2, 23);
  const n3 = valueNoise(seed + 3, 61);
  const grainRnd = mulberry32(seed + 99);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const dx = u - 0.5;
      const dy = v - 0.5;
      const r = Math.hypot(dx, dy) * 2; // 0 at centre, 1 at edge midpoint

      // Radial ring structure: the "orbital" look.
      const rings = 0.5 + 0.5 * Math.sin(r * 26 - 1.2);
      const fbm = n1(u, v) * 0.55 + n2(u, v) * 0.3 + n3(u, v) * 0.15;
      const body = Math.pow(Math.max(0, 1 - r), 1.6);
      const intensity = Math.min(1, body * (0.45 + 0.55 * rings) * (0.6 + 0.8 * fbm));

      // Chroma varies with angle so the texture is not a greyscale ramp.
      const angle = Math.atan2(dy, dx);
      const hue = (angle / (Math.PI * 2) + 0.5 + hueShift) % 1;
      const [cr, cg, cb] = hueToRgb(hue, 0.55, 0.62);

      const g = () => (grainRnd() - 0.5) * grain;
      const i = (y * size + x) * 4;
      data[i] = clamp255(cr * intensity * 255 + g());
      data[i + 1] = clamp255(cg * intensity * 255 + g());
      data[i + 2] = clamp255(cb * intensity * 255 + g());
      data[i + 3] = clamp255(Math.pow(intensity, 0.75) * 255 + g() * 0.5);
    }
  }
  return { width: size, height: size, data };
}

/**
 * Binary-searches the grain amplitude so the encoded PNG lands near
 * `targetBytes`. Deterministic: the same target always converges to the same
 * amplitude and therefore the same file.
 *
 * @param {{ size: number; seed: number; hueShift: number; targetBytes: number }} opts
 */
function renderToBudget(opts) {
  let lo = 0;
  let hi = 255;
  /** @type {Buffer | null} */
  let best = null;
  let bestGrain = 0;

  for (let iteration = 0; iteration < 12; iteration++) {
    const grain = (lo + hi) / 2;
    const image = renderTexture({ size: opts.size, seed: opts.seed, grain, hueShift: opts.hueShift });
    const png = encodePng(image, { level: 6 });
    best = png;
    bestGrain = grain;

    const ratio = png.length / opts.targetBytes;
    if (Math.abs(ratio - 1) <= SIZE_TOLERANCE) break;
    if (png.length < opts.targetBytes) lo = grain;
    else hi = grain;
  }

  return { png: /** @type {Buffer} */ (best), grain: Math.round(bestGrain * 100) / 100 };
}

/**
 * Interleaved float32 vertex data: position(3) + normal(3) + uv(2) = 32 bytes
 * per vertex. Sized to exactly the declared byte budget.
 *
 * @param {number} seed
 * @param {number} targetBytes
 */
function renderGeometry(seed, targetBytes) {
  const STRIDE_FLOATS = 8;
  const vertexCount = Math.floor(targetBytes / (STRIDE_FLOATS * 4));
  const floats = new Float32Array(vertexCount * STRIDE_FLOATS);
  const rnd = mulberry32(seed);

  // A Fibonacci-sphere shell, which is what the halo geometry would be.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < vertexCount; i++) {
    const t = vertexCount > 1 ? i / (vertexCount - 1) : 0;
    const y = 1 - t * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const jitter = 0.97 + rnd() * 0.06;
    const x = Math.cos(theta) * radius * jitter;
    const z = Math.sin(theta) * radius * jitter;
    const o = i * STRIDE_FLOATS;
    floats[o] = x;
    floats[o + 1] = y * jitter;
    floats[o + 2] = z;
    floats[o + 3] = x;
    floats[o + 4] = y;
    floats[o + 5] = z;
    floats[o + 6] = (theta / (Math.PI * 2)) % 1;
    floats[o + 7] = t;
  }
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

/**
 * The static anchor (stands in for a camera feed on the interactive-2d path)
 * and the static-safe poster. Neither belongs to a tier, so both are kept
 * small deliberately — the static-safe path exists for devices that cannot
 * afford anything.
 *
 * @param {{ width: number; height: number; seed: number; targetBytes: number; dark: number }} opts
 */
function renderBackdrop(opts) {
  const { width, height, seed } = opts;
  const n1 = valueNoise(seed + 11, 6);
  const n2 = valueNoise(seed + 12, 19);

  let lo = 0;
  let hi = 200;
  /** @type {Buffer | null} */
  let best = null;

  for (let iteration = 0; iteration < 10; iteration++) {
    const grain = (lo + hi) / 2;
    const grainRnd = mulberry32(seed + 77);
    const data = Buffer.allocUnsafe(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const u = x / width;
        const v = y / height;
        const fbm = n1(u, v) * 0.7 + n2(u, v) * 0.3;
        // A cool, low-contrast surface: something a product would sit on.
        const base = opts.dark * (0.55 + 0.45 * fbm) * (1 - 0.35 * v);
        const g = () => (grainRnd() - 0.5) * grain;
        const i = (y * width + x) * 4;
        data[i] = clamp255(base * 0.82 + g());
        data[i + 1] = clamp255(base * 0.9 + g());
        data[i + 2] = clamp255(base * 1.0 + g());
        data[i + 3] = 255;
      }
    }
    const png = encodePng({ width, height, data }, { level: 6 });
    best = png;
    const ratio = png.length / opts.targetBytes;
    if (Math.abs(ratio - 1) <= SIZE_TOLERANCE) break;
    if (png.length < opts.targetBytes) lo = grain;
    else hi = grain;
  }
  return /** @type {Buffer} */ (best);
}

/* ── main ─────────────────────────────────────────────────────────────── */

export async function generateAssets() {
  banner("Generating Orbital assets");
  await ensureDir(OUT_DIR);

  /** @type {Array<{ file: string; declaredBytes: number | null; actualBytes: number; note: string }>} */
  const produced = [];

  const textureSeeds = { "tex-hi": 1024, "tex-mid": 512, "tex-low": 256 };
  const hueShifts = { "tex-hi": 0.0, "tex-mid": 0.04, "tex-low": 0.08 };

  for (const tier of orbitalManifest.tiers) {
    for (const asset of tier.assets) {
      const file = path.join(fromRoot("experience"), asset.url);
      if (asset.kind === "texture") {
        const size = /** @type {any} */ (textureSeeds)[asset.id] ?? tier.params.textureSize;
        const { png, grain } = renderToBudget({
          size,
          seed: 0x0b17a1 + size,
          hueShift: /** @type {any} */ (hueShifts)[asset.id] ?? 0,
          targetBytes: asset.approxBytes,
        });
        await writeFileEnsured(file, png);
        produced.push({
          file: asset.url,
          declaredBytes: asset.approxBytes,
          actualBytes: png.length,
          note: `${size}x${size} RGBA, grain ${grain}`,
        });
      } else {
        const bin = renderGeometry(0x0b17a1 + asset.approxBytes, asset.approxBytes);
        await writeFileEnsured(file, bin);
        produced.push({
          file: asset.url,
          declaredBytes: asset.approxBytes,
          actualBytes: bin.length,
          note: `${bin.length / 32} vertices, 32B stride`,
        });
      }
    }
  }

  const anchor = renderBackdrop({ width: 720, height: 1280, seed: 4242, targetBytes: 120_000, dark: 96 });
  await writeFileEnsured(path.join(OUT_DIR, "anchor.png"), anchor);
  produced.push({ file: "assets/generated/anchor.png", declaredBytes: null, actualBytes: anchor.length, note: "720x1280 static anchor (interactive-2d path)" });

  const poster = renderBackdrop({ width: 480, height: 854, seed: 909, targetBytes: 42_000, dark: 78 });
  await writeFileEnsured(path.join(OUT_DIR, "poster.png"), poster);
  produced.push({ file: "assets/generated/poster.png", declaredBytes: null, actualBytes: poster.length, note: "480x854 poster (static-safe path)" });

  await writeJson(path.join(OUT_DIR, "sizes.json"), {
    generatedBy: "scripts/generate-assets.js",
    manifestHash: orbitalManifest.contentHash,
    assets: produced,
  });

  let worstDrift = 0;
  for (const p of produced) {
    const drift = p.declaredBytes ? Math.abs(p.actualBytes - p.declaredBytes) / p.declaredBytes : 0;
    worstDrift = Math.max(worstDrift, drift);
    const driftText = p.declaredBytes ? ` (declared ${fmt(p.declaredBytes)}, ${(drift * 100).toFixed(1)}% off)` : "";
    log.info(`${p.file} — ${fmt(p.actualBytes)}${driftText} · ${p.note}`);
  }

  if (worstDrift > 0.15) {
    log.warn(
      `an asset is more than 15% off its declared approxBytes (worst ${(worstDrift * 100).toFixed(1)}%). ` +
        "The rule-based cost model predicts first-frame time from the declared value, so update the manifest.",
    );
  }
  log.info(`wrote ${produced.length} assets to experience/assets/generated/`);
  return produced;
}

/** @param {number} h @param {number} s @param {number} l @returns {[number, number, number]} */
function hueToRgb(h, s, l) {
  /** @param {number} n */
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** @param {number} v */
function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** @param {number} n */
function fmt(n) {
  return n >= 1_000_000 ? `${(n / 1_048_576).toFixed(2)}MB` : `${(n / 1024).toFixed(1)}KB`;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("generate-assets.js")) {
  generateAssets().catch((err) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
