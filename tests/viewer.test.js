/**
 * GLB ingest — all offline. Test GLBs are built byte-for-byte in this file so
 * the suite depends on no binary fixture that could silently rot.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { moderateGlb } from "../src/viewer/parse-glb.js";
import { viewerTierSettings, viewerTiers, frameDistance, lookAt, perspective, multiply } from "../experience/viewer/ladder.js";

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
  // Every animating rung is lit: the probe's blank detector reads luma
  // variance, and flat shading scores a uniformly-filled frame as blank.
  for (const id of ["high", "mid", "low"]) {
    assert.equal(viewerTierSettings(id).shading, "lit", `${id} must stay detectable`);
  }
  // Unknown tiers fall through to the poster, never to an invented setting.
  assert.deepEqual(viewerTierSettings("ultra"), poster);
});

test("auto-framing keeps every corner inside NDC on any aspect", () => {
  // Regression test for two real failures: fitting vertical FOV alone
  // overflowed portrait viewports, and fitting the longest axis (not the
  // bounding sphere) clipped rotated corners at ndc.x ±1.15.
  const bounds = { min: [-1, 0, -1], max: [1, 1.5, 1] };
  const center = [0, 0.75, 0];
  const corners = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) corners.push([x, y, z]);
    }
  }
  for (const [w, h] of [[390, 844], [844, 390], [1280, 800], [800, 800]]) {
    const aspect = w / h;
    const dist = frameDistance(bounds, aspect);
    for (const [yaw, pitch] of [[0.6, 0.35], [0, 0], [2.4, -0.8], [4.0, 1.0]]) {
      const eye = [
        center[0] + dist * Math.cos(pitch) * Math.sin(yaw),
        center[1] + dist * Math.sin(pitch),
        center[2] + dist * Math.cos(pitch) * Math.cos(yaw),
      ];
      const mvp = multiply(perspective(35, aspect, dist / 100, dist * 10), lookAt(eye, center));
      for (const v of corners) {
        const c = [0, 1, 2, 3].map((row) => mvp[row] * v[0] + mvp[4 + row] * v[1] + mvp[8 + row] * v[2] + mvp[12 + row]);
        const nx = Math.abs(c[0] / c[3]);
        const ny = Math.abs(c[1] / c[3]);
        assert.ok(nx <= 1 && ny <= 1, `${w}x${h} yaw=${yaw}: corner ${v} at ndc ${nx.toFixed(3)},${ny.toFixed(3)}`);
      }
    }
  }
});

test("stageUpload moderates, hashes, and stages deterministically", async () => {
  const { stageUpload } = await import("../src/runner/run-matrix.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readFile } = await import("node:fs/promises");
  const { json, bin } = triangleDoc();
  const bytes = toGlb(json, bin);
  const outDir = await mkdtemp(join(tmpdir(), "atlas-upload-"));

  const first = await stageUpload(bytes, "tri.glb", outDir, {});
  const second = await stageUpload(bytes, "renamed.glb", outDir, {});
  assert.equal(first.hash, second.hash, "the filename is content, not the original name");
  assert.match(first.hash, /^[0-9a-f]{16}$/);
  const sidecar = JSON.parse(await readFile(join(outDir, "uploads", `${first.hash}.atlas.json`), "utf8"));
  assert.equal(sidecar.sourceHash, first.hash);
  assert.equal(sidecar.meshes.length, 1);

  await assert.rejects(
    stageUpload(Buffer.from("nope"), "nope.glb", outDir, {}),
    /not a GLB file/,
    "moderation refusal must name the reason before any browser launches",
  );
});

test("aliased mounts serve staged files with their own traversal guard", async () => {
  const { startServer } = await import("../src/runner/server.js");
  const { orbitalManifest } = await import("../src/manifest/atlas-orbital.manifest.js");
  const { RuleBasedDecisionEngine } = await import("../src/decision/rule-based.js");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "atlas-alias-"));
  await writeFile(join(dir, "a.atlas.json"), JSON.stringify({ hello: "upload" }));
  const server = await startServer({
    manifest: orbitalManifest,
    engine: new RuleBasedDecisionEngine(),
    traceDir: null,
    aliases: { "/uploads/": dir },
  });
  try {
    const ok = await fetch(`${server.origin}/uploads/a.atlas.json`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { hello: "upload" });
    const traversal = await fetch(`${server.origin}/uploads/../a.atlas.json`);
    assert.ok([403, 404].includes(traversal.status), `traversal must not serve, got ${traversal.status}`);
    const missing = await fetch(`${server.origin}/uploads/nope.json`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});
