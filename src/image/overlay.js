/**
 * Diff visualisation.
 *
 * `diffImages` answers "how different"; this answers "different *where*", which
 * is the thing a human looking at a failed replay actually needs. The output is
 * the baseline screenshot desaturated and dimmed, with every differing pixel
 * painted magenta and the divergence box outlined, so one glance locates the
 * region without cross-referencing coordinates against a report.
 *
 * Kept out of diff.js on purpose: diff.js produces numbers that gate a release,
 * and nothing in it should depend on how those numbers are drawn.
 *
 * @typedef {import("./png.js").RgbaImage} RgbaImage
 */

import { Buffer } from "node:buffer";
import { DEFAULT_CHANNEL_TOLERANCE } from "./diff.js";

/** Magenta: not a colour either the dark UI or the warm product layer produces. */
const MARK = [255, 0, 170];
const OUTLINE = [0, 255, 200];

/**
 * @param {RgbaImage} baseline
 * @param {RgbaImage} candidate
 * @param {{ channelTolerance?: number; box?: { x: number; y: number; w: number; h: number } | null }} [opts]
 * @returns {RgbaImage}
 */
export function diffOverlay(baseline, candidate, opts = {}) {
  const tol = opts.channelTolerance ?? DEFAULT_CHANNEL_TOLERANCE;
  const width = Math.min(baseline.width, candidate.width);
  const height = Math.min(baseline.height, candidate.height);
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const ia = (y * baseline.width + x) * 4;
      const ib = (y * candidate.width + x) * 4;

      const differs =
        Math.abs(baseline.data[ia] - candidate.data[ib]) > tol ||
        Math.abs(baseline.data[ia + 1] - candidate.data[ib + 1]) > tol ||
        Math.abs(baseline.data[ia + 2] - candidate.data[ib + 2]) > tol ||
        Math.abs(baseline.data[ia + 3] - candidate.data[ib + 3]) > tol;

      if (differs) {
        data[o] = MARK[0];
        data[o + 1] = MARK[1];
        data[o + 2] = MARK[2];
      } else {
        // Dimmed greyscale, so the marked pixels are the only saturated thing
        // in the frame.
        const luma =
          0.2126 * baseline.data[ia] + 0.7152 * baseline.data[ia + 1] + 0.0722 * baseline.data[ia + 2];
        const g = Math.round(luma * 0.35);
        data[o] = g;
        data[o + 1] = g;
        data[o + 2] = g;
      }
      data[o + 3] = 255;
    }
  }

  const image = { width, height, data };
  if (opts.box) strokeRect(image, opts.box, OUTLINE);
  return image;
}

/**
 * Two images side by side with a divider, for before/after plates.
 *
 * @param {RgbaImage} left
 * @param {RgbaImage} right
 * @param {{ gap?: number }} [opts]
 * @returns {RgbaImage}
 */
export function sideBySide(left, right, opts = {}) {
  const gap = opts.gap ?? 8;
  const width = left.width + gap + right.width;
  const height = Math.max(left.height, right.height);
  const data = new Uint8ClampedArray(width * height * 4);
  // Opaque near-black backdrop; letterboxing must not read as transparency.
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 12;
    data[i + 1] = 12;
    data[i + 2] = 16;
    data[i + 3] = 255;
  }
  const canvas = { width, height, data };
  blit(canvas, left, 0, 0);
  blit(canvas, right, left.width + gap, 0);
  return canvas;
}

/**
 * @param {RgbaImage} dest
 * @param {RgbaImage} src
 * @param {number} dx
 * @param {number} dy
 */
function blit(dest, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= dest.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= dest.width) continue;
      const s = (y * src.width + x) * 4;
      const d = (ty * dest.width + tx) * 4;
      dest.data[d] = src.data[s];
      dest.data[d + 1] = src.data[s + 1];
      dest.data[d + 2] = src.data[s + 2];
      dest.data[d + 3] = 255;
    }
  }
}

/**
 * @param {RgbaImage} image
 * @param {{ x: number; y: number; w: number; h: number }} box
 * @param {number[]} colour
 */
function strokeRect(image, box, colour) {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.round(box.x)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.round(box.y)));
  const x1 = Math.max(0, Math.min(image.width - 1, Math.round(box.x + box.w - 1)));
  const y1 = Math.max(0, Math.min(image.height - 1, Math.round(box.y + box.h - 1)));

  /** @param {number} x @param {number} y */
  const put = (x, y) => {
    const i = (y * image.width + x) * 4;
    image.data[i] = colour[0];
    image.data[i + 1] = colour[1];
    image.data[i + 2] = colour[2];
    image.data[i + 3] = 255;
  };

  for (let x = x0; x <= x1; x++) {
    put(x, y0);
    put(x, y1);
  }
  for (let y = y0; y <= y1; y++) {
    put(x0, y);
    put(x1, y);
  }
}
