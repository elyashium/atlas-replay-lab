/**
 * The hand-written PNG codec and the perceptual diff.
 *
 * Both exist because this project takes no dependencies (ADR-0002), which means
 * the usual argument for not testing a codec — "it's a well-known library" —
 * does not apply. If `encodePng` emits a subtly malformed chunk, every
 * screenshot in the report is a broken image icon, and the failure surfaces as
 * "the report looks wrong" rather than as a codec bug.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { encodePng, decodePng, blankImage } from "../src/image/png.js";
import {
  diffImages,
  perceptualScore,
  lumaGrid,
  nonBlankness,
  focalCoverage,
  edgeEnergy,
  edgeDrift,
  DEFAULT_CHANNEL_TOLERANCE,
} from "../src/image/diff.js";
import { diffOverlay, sideBySide } from "../src/image/overlay.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A deterministic, non-trivial test image: a two-axis gradient with a square. */
function gradient(width = 37, height = 23) {
  const img = blankImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      img.data[i] = (x * 7) & 0xff;
      img.data[i + 1] = (y * 11) & 0xff;
      img.data[i + 2] = (x * y) & 0xff;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

/** A solid background with a bright rectangle — the "something is drawn" case. */
function withSubject(width = 64, height = 64, box = { x: 20, y: 20, w: 24, h: 24 }) {
  const img = blankImage(width, height);
  for (let i = 0; i < width * height; i++) {
    img.data[i * 4] = 18;
    img.data[i * 4 + 1] = 18;
    img.data[i * 4 + 2] = 22;
    img.data[i * 4 + 3] = 255;
  }
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * width + x) * 4;
      img.data[i] = 240;
      img.data[i + 1] = 210;
      img.data[i + 2] = 90;
    }
  }
  return img;
}

/* ── PNG codec ────────────────────────────────────────────────────────────── */

test("an encoded PNG starts with the signature and an IHDR", () => {
  const buf = encodePng(gradient());
  assert.ok(buf.subarray(0, 8).equals(PNG_MAGIC), "bad PNG signature");
  assert.equal(buf.readUInt32BE(8), 13, "IHDR length must be 13");
  assert.equal(buf.subarray(12, 16).toString("ascii"), "IHDR");
  assert.ok(buf.subarray(16).includes(Buffer.from("IDAT", "ascii")));
  assert.equal(buf.subarray(buf.length - 8, buf.length - 4).toString("ascii"), "IEND");
});

test("the IHDR declares 8-bit RGBA, non-interlaced", () => {
  const buf = encodePng(gradient(9, 5));
  assert.equal(buf.readUInt32BE(16), 9, "width");
  assert.equal(buf.readUInt32BE(20), 5, "height");
  assert.equal(buf[24], 8, "bit depth");
  assert.equal(buf[25], 6, "colour type 6 = RGBA");
  assert.equal(buf[28], 0, "interlace must be off — the decoder does not implement Adam7");
});

test("every implemented filter round-trips byte for byte", () => {
  const source = gradient();
  for (const filter of [0, 1, 2]) {
    const decoded = decodePng(encodePng(source, { filter }));
    assert.equal(decoded.width, source.width, `filter ${filter}`);
    assert.equal(decoded.height, source.height, `filter ${filter}`);
    assert.ok(decoded.data.equals(source.data), `filter ${filter} did not round-trip`);
  }
});

test("an unimplemented filter is refused rather than silently mis-encoded", () => {
  // Emitting a filter byte the decoder cannot read would produce a file that
  // looks valid, passes a size check, and renders as garbage.
  assert.throws(() => encodePng(gradient(), { filter: 4 }), /filter/i);
});

test("the degenerate image sizes round-trip", () => {
  for (const [w, h] of [[1, 1], [1, 64], [64, 1], [3, 3]]) {
    const source = gradient(w, h);
    const decoded = decodePng(encodePng(source));
    assert.equal(decoded.width, w);
    assert.equal(decoded.height, h);
    assert.ok(decoded.data.equals(source.data), `${w}x${h} did not round-trip`);
  }
});

test("a fully transparent image round-trips with its alpha intact", () => {
  // Alpha is where a naive RGB-only codec silently loses information, and the
  // camera-composited path depends on it.
  const source = blankImage(8, 8);
  const decoded = decodePng(encodePng(source));
  assert.ok(decoded.data.equals(source.data));
  assert.ok(decoded.data.every((b) => b === 0));
});

test("compression level changes the bytes but never the pixels", () => {
  const source = gradient(48, 48);
  const fast = encodePng(source, { level: 1 });
  const small = encodePng(source, { level: 9 });
  assert.ok(small.length <= fast.length, "level 9 should not be larger than level 1");
  assert.ok(decodePng(fast).data.equals(decodePng(small).data));
});

test("decodePng rejects things that are not PNGs", () => {
  assert.throws(() => decodePng(Buffer.from("not a png at all")), /signature|png/i);
  assert.throws(() => decodePng(Buffer.alloc(0)), /signature|png|length|truncat/i);
});

test("decodePng rejects a truncated file instead of returning half an image", () => {
  const buf = encodePng(gradient());
  assert.throws(() => decodePng(buf.subarray(0, buf.length - 20)));
});

/* ── pixel diff ───────────────────────────────────────────────────────────── */

test("an image is identical to itself", () => {
  const img = withSubject();
  const d = diffImages(img, img);
  assert.equal(d.identical, true);
  assert.equal(d.pixelDiffRatio, 0);
  assert.equal(d.perceptualScore, 1);
  assert.equal(d.firstDivergenceBox, null, "no divergence means no box to draw");
});

test("mismatched dimensions are maximally different, and do not throw", () => {
  // The replay path can hand this two screenshots at different viewport sizes.
  // Reading out of bounds would be a crash; pretending they are similar would be
  // worse.
  const d = diffImages(blankImage(10, 10), blankImage(20, 20));
  assert.equal(d.identical, false);
  assert.equal(d.pixelDiffRatio, 1);
  assert.equal(d.perceptualScore, 0);
  assert.deepEqual(d.firstDivergenceBox, { x: 0, y: 0, w: 20, h: 20 });
});

test("sub-tolerance noise reads as identical", () => {
  // Real browsers do not reproduce anti-aliasing exactly. A diff that gates on
  // literal equality would fail every replay for reasons that are not bugs.
  const a = withSubject();
  const b = { ...a, data: Buffer.from(a.data) };
  for (let i = 0; i < b.data.length; i += 4) b.data[i] = Math.min(255, b.data[i] + DEFAULT_CHANNEL_TOLERANCE - 1);
  assert.equal(diffImages(a, b).identical, true);
});

test("a change just over tolerance is caught", () => {
  const a = withSubject();
  const b = { ...a, data: Buffer.from(a.data) };
  for (let i = 0; i < b.data.length; i += 4) b.data[i] = Math.min(255, b.data[i] + DEFAULT_CHANNEL_TOLERANCE + 2);
  assert.equal(diffImages(a, b).identical, false);
});

test("the divergence box lands on the region that actually changed", () => {
  const a = withSubject(64, 64);
  const b = withSubject(64, 64);
  // Repaint a patch in the lower-right quadrant.
  for (let y = 44; y < 56; y++) {
    for (let x = 44; x < 56; x++) {
      const i = (y * 64 + x) * 4;
      b.data[i] = 255;
      b.data[i + 1] = 0;
      b.data[i + 2] = 0;
    }
  }
  const box = diffImages(a, b).firstDivergenceBox;
  assert.ok(box, "a changed patch must produce a box");
  const b2 = /** @type {any} */ (box);
  assert.ok(b2.x + b2.w > 44 && b2.y + b2.h > 44, `box ${JSON.stringify(b2)} misses the changed region`);
  assert.ok(b2.x < 56 && b2.y < 56, `box ${JSON.stringify(b2)} is nowhere near the changed region`);
});

test("perceptualScore is a bounded, symmetric similarity", () => {
  const a = withSubject();
  const b = blankImage(a.width, a.height);
  const s = perceptualScore(a, b);
  assert.ok(s >= 0 && s <= 1, `score ${s} out of range`);
  assert.equal(perceptualScore(a, b), perceptualScore(b, a));
  assert.ok(s < perceptualScore(a, a));
});

test("perceptualScore survives a shift that wrecks the pixel ratio", () => {
  // The distinction the replay report depends on: "every pixel moved by one" is
  // a catastrophic pixel diff and a near-perfect perceptual match.
  const a = withSubject(64, 64);
  const shifted = withSubject(64, 64, { x: 21, y: 20, w: 24, h: 24 });
  const d = diffImages(a, shifted);
  assert.ok(d.pixelDiffRatio > 0, "a shift must register as a pixel difference");
  assert.ok(d.perceptualScore > 0.9, `perceptual score ${d.perceptualScore} should stay high for a 1px shift`);
});

test("lumaGrid is a fixed 256-cell summary regardless of input size", () => {
  for (const [w, h] of [[1, 1], [37, 23], [640, 480]]) {
    assert.equal(lumaGrid(gradient(w, h)).length, 256, `${w}x${h}`);
  }
});

/* ── blankness and coverage ───────────────────────────────────────────────── */

test("a blank frame scores zero non-blankness", () => {
  // This is the measurement that turns "first frame at 812ms" from a number
  // into a claim. Without it a blank canvas meets every timing budget.
  assert.equal(nonBlankness(blankImage(64, 64)), 0);
  assert.equal(focalCoverage(blankImage(64, 64)), 0);
});

test("a uniformly filled frame is still blank — colour is not content", () => {
  const solid = blankImage(64, 64);
  solid.data.fill(200);
  assert.ok(nonBlankness(solid) < 0.01, `a flat fill scored ${nonBlankness(solid)}`);
});

test("a drawn subject registers coverage roughly matching its area", () => {
  const img = withSubject(64, 64, { x: 20, y: 20, w: 24, h: 24 });
  const expected = (24 * 24) / (64 * 64); // 0.1406
  const measured = focalCoverage(img);
  assert.ok(Math.abs(measured - expected) < 0.02, `coverage ${measured}, expected about ${expected.toFixed(4)}`);
});

test("coverage grows with the subject", () => {
  const small = focalCoverage(withSubject(64, 64, { x: 20, y: 20, w: 8, h: 8 }));
  const large = focalCoverage(withSubject(64, 64, { x: 10, y: 10, w: 40, h: 40 }));
  assert.ok(large > small);
});

test("edgeEnergy separates a flat fill from a drawn one", () => {
  const solid = blankImage(64, 64);
  solid.data.fill(200);
  assert.ok(edgeEnergy(withSubject()) > edgeEnergy(solid));
  assert.ok(edgeEnergy(solid) >= 0 && edgeEnergy(withSubject()) <= 1);
});

test("edgeDrift is zero for an unchanged frame and bounded otherwise", () => {
  const img = withSubject();
  assert.equal(edgeDrift(edgeEnergy(img), edgeEnergy(img)), 0);
  const drift = edgeDrift(edgeEnergy(img), edgeEnergy(blankImage(64, 64)));
  assert.ok(drift > 0 && Number.isFinite(drift), `drift was ${drift}`);
});

test("edgeDrift does not divide by zero when both frames are blank", () => {
  assert.ok(Number.isFinite(edgeDrift(0, 0)));
});

/* ── overlays ─────────────────────────────────────────────────────────────── */

test("the diff overlay marks changed pixels and round-trips through the codec", () => {
  const a = withSubject(64, 64);
  const b = withSubject(64, 64, { x: 30, y: 30, w: 24, h: 24 });
  const overlay = diffOverlay(a, b);
  assert.equal(overlay.width, 64);
  assert.equal(overlay.height, 64);
  // The artifact is only useful if it can actually be written and opened.
  const decoded = decodePng(encodePng(overlay));
  assert.ok(decoded.data.equals(overlay.data));
});

test("an overlay of identical images marks nothing", () => {
  const img = withSubject();
  const overlay = diffOverlay(img, img);
  // Every pixel should be the dimmed passthrough, never the marker colour.
  let marked = 0;
  for (let i = 0; i < overlay.data.length; i += 4) {
    if (overlay.data[i] === 255 && overlay.data[i + 1] === 0) marked++;
  }
  assert.equal(marked, 0);
});

test("sideBySide is wide enough for both frames plus its gutter", () => {
  const left = withSubject(40, 30);
  const right = withSubject(40, 30);
  const combined = sideBySide(left, right);
  assert.ok(combined.width >= 80, `combined width ${combined.width}`);
  assert.ok(combined.height >= 30);
  assert.equal(combined.data.length, combined.width * combined.height * 4);
  decodePng(encodePng(combined)); // must not throw
});

test("sideBySide tolerates frames of different heights", () => {
  const combined = sideBySide(withSubject(40, 30), withSubject(40, 50));
  assert.ok(combined.height >= 50);
  assert.equal(combined.data.length, combined.width * combined.height * 4);
});
