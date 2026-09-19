/**
 * PNG decode/encode on node:zlib. No dependencies.
 *
 * Needed for two things the pipeline cannot do without: generating real
 * texture assets of genuinely different byte sizes (so 3G throttling produces
 * a real difference rather than a simulated one), and decoding
 * `Page.captureScreenshot` output so checkpoint screenshots can be compared
 * pixel by pixel.
 *
 * Scope: 8-bit, non-interlaced, colour types 0/2/3/4/6. That covers every PNG
 * this project produces and everything Chromium's screenshot encoder emits.
 * Anything else throws with a clear message rather than decoding incorrectly —
 * a diff computed from a misparsed image is worse than no diff.
 */

import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @typedef {object} RgbaImage
 * @property {number} width
 * @property {number} height
 * @property {Buffer} data  RGBA, 4 bytes per pixel, row-major
 */

/* ── CRC32 ───────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** @param {Buffer} buf */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ── encode ──────────────────────────────────────────────────────────── */

/**
 * @param {RgbaImage} image
 * @param {{ level?: number; filter?: 0 | 1 | 2 | 3 | 4 }} [opts]
 * @returns {Buffer}
 */
export function encodePng(image, opts = {}) {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new Error(`encodePng: expected ${width * height * 4} bytes, got ${data.length}`);
  }
  const filter = opts.filter ?? 1; // Sub: cheap, and good on smooth gradients
  const stride = width * 4;

  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const outRow = y * (stride + 1);
    raw[outRow] = filter;
    const inRow = y * stride;
    if (filter === 0) {
      data.copy(raw, outRow + 1, inRow, inRow + stride);
    } else if (filter === 1) {
      for (let x = 0; x < stride; x++) {
        const left = x >= 4 ? data[inRow + x - 4] : 0;
        raw[outRow + 1 + x] = (data[inRow + x] - left) & 0xff;
      }
    } else if (filter === 2) {
      for (let x = 0; x < stride; x++) {
        const up = y > 0 ? data[inRow - stride + x] : 0;
        raw[outRow + 1 + x] = (data[inRow + x] - up) & 0xff;
      }
    } else {
      throw new Error(`encodePng: filter ${filter} is not implemented`);
    }
  }

  const idat = zlib.deflateSync(raw, { level: opts.level ?? 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * @param {string} type
 * @param {Buffer} body
 */
function chunk(type, body) {
  const out = Buffer.allocUnsafe(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 4, "ascii");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/* ── decode ──────────────────────────────────────────────────────────── */

/**
 * @param {Buffer} buf
 * @returns {RgbaImage}
 */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("decodePng: not a PNG (bad signature)");
  }

  let offset = 8;
  /** @type {{ width: number; height: number; depth: number; colorType: number; interlace: number } | null} */
  let header = null;
  /** @type {Buffer[]} */
  const idat = [];
  /** @type {Buffer | null} */
  let palette = null;
  /** @type {Buffer | null} */
  let transparency = null;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
      if (header.depth !== 8) throw new Error(`decodePng: only 8-bit depth is supported (got ${header.depth})`);
      if (header.interlace !== 0) throw new Error("decodePng: interlaced PNGs are not supported");
    } else if (type === "PLTE") {
      palette = Buffer.from(body);
    } else if (type === "tRNS") {
      transparency = Buffer.from(body);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
  }

  if (!header) throw new Error("decodePng: no IHDR chunk");
  if (!idat.length) throw new Error("decodePng: no IDAT chunk");

  const { width, height, colorType } = header;
  const channels = channelsFor(colorType);
  const bpp = channels; // 8-bit, so bytes-per-pixel == channels
  const stride = width * bpp;

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const expected = (stride + 1) * height;
  if (raw.length < expected) {
    throw new Error(`decodePng: inflated ${raw.length} bytes, expected at least ${expected}`);
  }

  // Unfilter in place into a contiguous scanline buffer.
  const lines = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[src + x];
      const a = x >= bpp ? lines[dst + x - bpp] : 0;
      const b = y > 0 ? lines[up + x] : 0;
      const c = y > 0 && x >= bpp ? lines[up + x - bpp] : 0;
      let value;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + ((a + b) >> 1); break;
        case 4: value = rawByte + paeth(a, b, c); break;
        default: throw new Error(`decodePng: unknown filter type ${filter} on row ${y}`);
      }
      lines[dst + x] = value & 0xff;
    }
  }

  return { width, height, data: toRgba(lines, width, height, colorType, palette, transparency) };
}

/** @param {number} colorType */
function channelsFor(colorType) {
  switch (colorType) {
    case 0: return 1; // grayscale
    case 2: return 3; // RGB
    case 3: return 1; // palette index
    case 4: return 2; // grayscale + alpha
    case 6: return 4; // RGBA
    default: throw new Error(`decodePng: unsupported colour type ${colorType}`);
  }
}

/**
 * @param {Buffer} lines
 * @param {number} width
 * @param {number} height
 * @param {number} colorType
 * @param {Buffer | null} palette
 * @param {Buffer | null} transparency
 * @returns {Buffer}
 */
function toRgba(lines, width, height, colorType, palette, transparency) {
  if (colorType === 6) return lines;

  const out = Buffer.allocUnsafe(width * height * 4);
  const pixels = width * height;

  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    if (colorType === 0) {
      const g = lines[i];
      out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
    } else if (colorType === 2) {
      const s = i * 3;
      out[o] = lines[s]; out[o + 1] = lines[s + 1]; out[o + 2] = lines[s + 2]; out[o + 3] = 255;
    } else if (colorType === 3) {
      if (!palette) throw new Error("decodePng: palette colour type without a PLTE chunk");
      const idx = lines[i];
      const p = idx * 3;
      out[o] = palette[p]; out[o + 1] = palette[p + 1]; out[o + 2] = palette[p + 2];
      out[o + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
    } else if (colorType === 4) {
      const s = i * 2;
      const g = lines[s];
      out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = lines[s + 1];
    }
  }
  return out;
}

/** @param {number} a @param {number} b @param {number} c */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Allocates a blank RGBA image.
 * @param {number} width
 * @param {number} height
 * @returns {RgbaImage}
 */
export function blankImage(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}
