#!/usr/bin/env node
/**
 * Writes a small deterministic GLB (a square pyramid, 6 triangles) for
 * smoke-testing `atlas matrix --glb` without needing a modelling tool.
 *
 * Usage: node scripts/make-demo-glb.js [outPath]
 *
 * The geometry is fixed literals, not random — the same command always
 * produces the same bytes, so staged hashes and reports are reproducible.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const outPath = process.argv[2] ?? path.join("artifacts", "demo-pyramid.glb");

// Square pyramid: base 2x2 at y=0, apex at y=1.5. Six triangles.
const positions = new Float32Array([
  // base (two triangles, normal -Y)
  -1, 0, -1, 1, 0, -1, 1, 0, 1,
  -1, 0, -1, 1, 0, 1, -1, 0, 1,
  // four sides (outward normals, approximated per-face)
  -1, 0, -1, -1, 0, 1, 0, 1.5, 0,
  1, 0, -1, 0, 1.5, 0, -1, 0, -1,
  1, 0, 1, 1, 0, -1, 0, 1.5, 0,
  -1, 0, 1, 0, 1.5, 0, 1, 0, 1,
]);
const normals = new Float32Array([
  0, -1, 0, 0, -1, 0, 0, -1, 0,
  0, -1, 0, 0, -1, 0, 0, -1, 0,
  0, -0.55, -0.83, 0, -0.55, -0.83, 0, -0.55, -0.83,
  0.83, -0.55, 0, 0.83, -0.55, 0, 0.83, -0.55, 0,
  0, -0.55, 0.83, 0, -0.55, 0.83, 0, -0.55, 0.83,
  -0.83, -0.55, 0, -0.83, -0.55, 0, -0.83, -0.55, 0,
]);
const indices = new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);

const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(normals.buffer), Buffer.from(indices.buffer)]);
const json = {
  asset: { version: "2.0", generator: "atlas make-demo-glb" },
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: "pyramid" }],
  meshes: [{
    name: "pyramid",
    primitives: [{
      attributes: { POSITION: 0, NORMAL: 1 },
      indices: 2,
      material: 0,
    }],
  }],
  materials: [{ name: "clay", pbrMetallicRoughness: { baseColorFactor: [0.85, 0.45, 0.2, 1] } }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 18, type: "VEC3", min: [-1, 0, -1], max: [1, 1.5, 1] },
    { bufferView: 1, componentType: 5126, count: 18, type: "VEC3" },
    { bufferView: 2, componentType: 5123, count: 18, type: "SCALAR" },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
    { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength },
    { buffer: 0, byteOffset: positions.byteLength + normals.byteLength, byteLength: indices.byteLength },
  ],
  buffers: [{ byteLength: bin.length }],
};

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

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, out);
console.log(`wrote ${out.length}B → ${outPath}`);
