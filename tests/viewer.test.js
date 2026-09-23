/**
 * GLB ingest — all offline. Test GLBs are built byte-for-byte in this file so
 * the suite depends on no binary fixture that could silently rot.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { moderateGlb } from "../src/viewer/parse-glb.js";
import { viewerTierSettings, viewerTiers } from "../experience/viewer/ladder.js";

/** Minimal single-triangle document: POSITION + NORMAL + USHORT indices. */
function triangleDoc() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2]);
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(normals.buffer), Buffer.from(indices.buffer)]);
  return {
    bin,
    json: {
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{
        name: "tri",
        primitives: [{
          attributes: { POSITION: 0, NORMAL: 1 },
          indices: 2,
          material: 0,
        }],
      }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 36 },
        { buffer: 0, byteOffset: 72, byteLength: 6 },
      ],
      buffers: [{ byteLength: bin.length }],
    },
  };
}

/** @param {any} json @param {Buffer} bin */
function toGlb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length + jsonPad, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(out, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  const binStart = 20 + jsonBytes.length + jsonPad;
  out.writeUInt32LE(bin.length, binStart);
  out.writeUInt32LE(0x004e4942, binStart + 4);
  bin.copy(out, binStart + 8);
  return out;
}

test("a valid single triangle parses with stats, bounds, and color", () => {
  const { json, bin } = triangleDoc();
  const r = moderateGlb(toGlb(json, bin));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.stats.triangleCount, 1);
  assert.equal(r.stats.meshCount, 1);
  assert.equal(r.stats.decimated, false);
  assert.deepEqual(r.sidecar.bounds.min, [0, 0, 0]);
  assert.deepEqual(r.sidecar.bounds.max, [1, 1, 0]);
  assert.deepEqual(r.sidecar.meshes[0].color, [1, 0, 0, 1]);
  assert.deepEqual(r.sidecar.meshes[0].indices, [0, 1, 2]);
  assert.equal(r.warnings.length, 0);
});

test("garbage is refused with a named reason, never an exception", () => {
  for (const [label, bytes] of [
    ["empty", Buffer.alloc(0)],
    ["short", Buffer.from("glTF")],
    ["bad magic", (() => { const b = Buffer.alloc(12); b.writeUInt32LE(12, 8); return b; })()],
    ["wrong version", (() => { const { json, bin } = triangleDoc(); const g = toGlb(json, bin); g.writeUInt32LE(1, 4); return g; })()],
    ["length mismatch", (() => { const { json, bin } = triangleDoc(); const g = toGlb(json, bin); g.writeUInt32LE(999, 8); return g; })()],
    ["bad json", (() => { const { bin } = triangleDoc(); return toGlb(/** @type {any} */ ("nope"), bin); })()],
  ]) {
    const r = moderateGlb(bytes);
    assert.equal(r.ok, false, label);
    assert.ok(r.errors.length > 0, `${label}: no reason given`);
    assert.equal(r.sidecar, null);
  }
});

test("non-triangle modes and missing normals are refused by name", () => {
  const { json, bin } = triangleDoc();
  const points = JSON.parse(JSON.stringify(json));
  points.meshes[0].primitives[0].mode = 0;
  assert.match(moderateGlb(toGlb(points, bin)).errors.join(";"), /not TRIANGLES/);

  const nonorm = JSON.parse(JSON.stringify(json));
  delete nonorm.meshes[0].primitives[0].attributes.NORMAL;
  assert.match(moderateGlb(toGlb(nonorm, bin)).errors.join(";"), /NORMAL/);
});

test("external buffers and overrunning accessors are refused", () => {
  const { json, bin } = triangleDoc();
  const ext = JSON.parse(JSON.stringify(json));
  ext.meshes[0].primitives[0].attributes.POSITION = 99;
  ext.accessors.push({ bufferView: 99, componentType: 5126, count: 3, type: "VEC3" });
  // Fix indices: accessor 99 does not exist as intended — point POSITION at it.
  ext.meshes[0].primitives[0].attributes.POSITION = 3;
  assert.match(moderateGlb(toGlb(ext, bin)).errors.join(";"), /bufferView 99 missing|self-contained|missing/);

  const over = JSON.parse(JSON.stringify(json));
  over.accessors[0].count = 1_000_000;
  assert.match(moderateGlb(toGlb(over, bin)).errors.join(";"), /overruns the BIN/);
});

test("oversize files and triangle floods are capped, not crashed", () => {
  const { json, bin } = triangleDoc();
  const big = moderateGlb(toGlb(json, bin), { maxBytes: 10 });
  assert.equal(big.ok, false);
  assert.match(big.errors.join(";"), /upload cap/);

  const many = moderateGlb(toGlb(json, bin), { maxTriangles: 0 });
  // maxTriangles 0 with 1 triangle present forces the decimation path.
  assert.equal(many.ok, true);
  assert.equal(many.stats.decimated, true);
  assert.ok(many.warnings.some((w) => /decimated/.test(w)));
});

test("animations, skins, cameras, and images warn rather than block", () => {
  const { json, bin } = triangleDoc();
  const rich = {
    ...json,
    animations: [{}],
    skins: [{}],
    cameras: [{ type: "perspective" }],
    images: [{ name: "tex" }],
  };
  const r = moderateGlb(toGlb(rich, bin));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  for (const word of ["animation", "skin", "camera", "image"]) {
    assert.ok(r.warnings.some((w) => w.includes(word)), `no warning for ${word}`);
  }
});

test("the render ladder descends in cost and never guesses", () => {
  assert.deepEqual(viewerTiers().sort(), ["high", "low", "mid", "static-fallback"].sort());
  const high = viewerTierSettings("high");
  const mid = viewerTierSettings("mid");
  const low = viewerTierSettings("low");
  const poster = viewerTierSettings("static-fallback");
  assert.ok(high.dprCap >= mid.dprCap && mid.dprCap >= low.dprCap, "pixel ratio descends");
  assert.ok(high.triCap >= mid.triCap && mid.triCap >= low.triCap, "triangle budget descends");
  assert.equal(poster.animate, false, "the poster rung runs no WebGL loop");
  assert.equal(high.animate, true);
  // Unknown tiers fall through to the poster, never to an invented setting.
  assert.deepEqual(viewerTierSettings("ultra"), poster);
});
