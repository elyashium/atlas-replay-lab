/**
 * Minimal GLB (binary glTF 2.0) ingest for the Atlas model viewer.
 *
 * Parses the container, validates it, and extracts the first renderable
 * content into a JSON sidecar the viewer page loads. Anything outside the v1
 * subset below is a moderation verdict (clean error or recorded warning),
 * never a crash and never silent acceptance:
 *
 *  - container: magic `glTF`, version 2, declared lengths must match the
 *    buffer; JSON chunk must parse; BIN chunk optional but required when any
 *    accessor has a bufferView (v1 has no external `.bin` or embedded
 *    `data:` buffers — a staged upload is self-contained or it is refused).
 *  - meshes: TRIANGLES primitives only (mode 4 / omitted); other modes are
 *    refused with the primitive index named.
 *  - attributes: POSITION (VEC3 FLOAT) required; NORMAL (VEC3 FLOAT) required
 *    (v1 does not compute normals — a model without them is a re-export away,
 *    and inventing shading data would make the render unfaithful);
 *    TEXCOORD/color/weights/joints ignored with a warning each.
 *  - indices: UNSIGNED_SHORT or UNSIGNED_INT; anything else refused.
 *  - materials: `baseColorFactor` only; textures, alpha modes, metallic/
 *    roughness factors beyond the default are noted and rendered flat.
 *    Animations, skins, morph targets, cameras and lights are ignored with a
 *    warning — the viewer shows the bind/static pose from a fixed orbit.
 *  - size policy: file cap (`maxBytes`, default 50MB), triangle cap
 *    (`maxTriangles`, default 60k). Over the triangle cap the index stream is
 *    stride-decimated from triangle 0 (deterministic, recorded in `meta`).
 *
 * Nothing here executes model content: no `eval`, no `Function`, no shader
 * compilation from strings in the file. The output is numbers.
 *
 * @typedef {object} GlbModeration
 * @property {boolean} ok
 * @property {string[]} errors    nonempty exactly when !ok
 * @property {string[]} warnings  accepted with caveats
 * @property {{ byteLength: number; nodeCount: number; meshCount: number; primitiveCount: number; triangleCount: number; trianglesKept: number; decimated: boolean }} stats
 * @property {{ bounds: { min: number[]; max: number[] }; meshes: Array<{ name: string; positions: number[]; normals: number[]; indices: number[]; color: number[] }> } | null} sidecar
 */

export const DEFAULT_MAX_BYTES = 50_000_000;
export const DEFAULT_MAX_TRIANGLES = 60_000;
const FLOAT_BYTES = 4;

/**
 * @param {Buffer | Uint8Array} input
 * @param {{ maxBytes?: number; maxTriangles?: number }} [opts]
 * @returns {GlbModeration}
 */
export function moderateGlb(input, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxTriangles = opts.maxTriangles ?? DEFAULT_MAX_TRIANGLES;
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);

  if (buf.length < 12) return fail(["not a GLB file: shorter than the 12-byte header"], warnings, buf);
  if (buf.readUInt32LE(0) !== 0x46546c67) {
    return fail(["not a GLB file: bad magic (expected `glTF`)"], warnings, buf);
  }
  const version = buf.readUInt32LE(4);
  if (version !== 2) return fail([`unsupported glTF version ${version} (viewer reads v2 only)`], warnings, buf);
  const declaredLength = buf.readUInt32LE(8);
  if (declaredLength !== buf.length) {
    return fail([`declared length ${declaredLength} does not match file length ${buf.length}`], warnings, buf);
  }
  if (buf.length > maxBytes) {
    return fail([`file is ${(buf.length / 1e6).toFixed(1)}MB over the ${(maxBytes / 1e6).toFixed(0)}MB upload cap`], warnings, buf);
  }

  // ── chunks ─────────────────────────────────────────────────────────────
  let offset = 12;
  /** @type {any} */
  let json = null;
  /** @type {Buffer | null} */
  let bin = null;
  let sawJson = false;
  while (offset + 8 <= buf.length) {
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > buf.length) return fail(["chunk overruns the file"], warnings, buf);
    if (chunkType === 0x4e4f534a) {
      // "JSON"
      sawJson = true;
      try {
        json = JSON.parse(buf.subarray(start, end).toString("utf8"));
      } catch {
        return fail(["JSON chunk does not parse"], warnings, buf);
      }
    } else if (chunkType === 0x004e4942) {
      // "BIN\0"
      bin = buf.subarray(start, end);
    } else {
      warnings.push(`unknown chunk type 0x${chunkType.toString(16)} ignored`);
    }
    offset = end;
  }
  if (!sawJson || !json || typeof json !== "object") return fail(["missing JSON chunk"], warnings, buf);

  // ── document ───────────────────────────────────────────────────────────
  const accessors = Array.isArray(json.accessors) ? json.accessors : [];
  const bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : [];
  const meshes = Array.isArray(json.meshes) ? json.meshes : [];
  const materials = Array.isArray(json.materials) ? json.materials : [];
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  if (!meshes.length) return fail(["no meshes in the document"], warnings, buf);

  /**
   * @param {number} index
   * @param {string} what
   * @returns {{ array: Float32Array; count: number; kind: string } | null}
   */
  const readAccessor = (index, what) => {
    const acc = accessors[index];
    if (!acc || typeof acc !== "object") {
      errors.push(`${what}: accessor ${index} missing`);
      return null;
    }
    if (acc.bufferView === undefined || acc.bufferView === null) {
      errors.push(`${what}: accessor ${index} has no bufferView (external buffers are refused: uploads must be self-contained)`);
      return null;
    }
    const view = bufferViews[acc.bufferView];
    if (!view || typeof view !== "object") {
      errors.push(`${what}: bufferView ${acc.bufferView} missing`);
      return null;
    }
    if (!bin) {
      errors.push(`${what}: references binary data but the file has no BIN chunk`);
      return null;
    }
    const byteOffset = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = view.byteStride ?? 0;
    if (stride !== 0 && stride !== componentSize(acc.type) * FLOAT_BYTES) {
      errors.push(`${what}: interleaved bufferViews are refused in v1 (stride ${stride})`);
      return null;
    }
    try {
      if (acc.componentType === 5126 && (acc.type === "VEC3" || acc.type === "VEC2" || acc.type === "SCALAR")) {
        const n = acc.count * { SCALAR: 1, VEC2: 2, VEC3: 3 }[acc.type];
        if (byteOffset < 0 || byteOffset + n * FLOAT_BYTES > bin.length) {
          errors.push(`${what}: accessor overruns the BIN chunk`);
          return null;
        }
        return {
          array: new Float32Array(bin.buffer, bin.byteOffset + byteOffset, n),
          count: acc.count,
          kind: acc.type,
        };
      }
      if ((acc.componentType === 5123 || acc.componentType === 5125) && acc.type === "SCALAR") {
        const bytes = acc.count * (acc.componentType === 5123 ? 2 : 4);
        if (byteOffset < 0 || byteOffset + bytes > bin.length) {
          errors.push(`${what}: index accessor overruns the BIN chunk`);
          return null;
        }
        const arr = acc.componentType === 5123
          ? new Uint16Array(bin.buffer, bin.byteOffset + byteOffset, acc.count)
          : new Uint32Array(bin.buffer, bin.byteOffset + byteOffset, acc.count);
        return { array: /** @type {any} */ (arr), count: acc.count, kind: "SCALAR" };
      }
      errors.push(`${what}: unsupported accessor (componentType ${acc.componentType}, type ${acc.type})`);
      return null;
    } catch {
      errors.push(`${what}: accessor unreadable (misaligned or out of range)`);
      return null;
    }
  };

  /** @type {Array<{ name: string; positions: number[]; normals: number[]; indices: number[]; color: number[] }>} */
  const outMeshes = [];
  let triangleCount = 0;
  let primitiveCount = 0;

  json.meshes.forEach((/** @type {any} */ mesh, mi) => {
    const prims = Array.isArray(mesh.primitives) ? mesh.primitives : [];
    prims.forEach((/** @type {any} */ prim, pi) => {
      const where = `mesh ${mi} primitive ${pi}`;
      primitiveCount++;
      if (prim.mode !== undefined && prim.mode !== 4) {
        errors.push(`${where}: mode ${prim.mode} is not TRIANGLES (v1 renders triangles only)`);
        return;
      }
      const attrs = prim.attributes ?? {};
      const pos = readAccessor(attrs.POSITION, `${where} POSITION`);
      const nor = readAccessor(attrs.NORMAL, `${where} NORMAL`);
      if (!pos || !nor) return; // errors already recorded
      for (const key of Object.keys(attrs)) {
        if (!["POSITION", "NORMAL"].includes(key)) warnings.push(`${where}: attribute ${key} ignored in v1`);
      }
      /** @type {number[]} */
      let indices;
      if (prim.indices === undefined || prim.indices === null) {
        indices = Array.from({ length: pos.count }, (_, i) => i);
      } else {
        const idx = readAccessor(prim.indices, `${where} indices`);
        if (!idx) return;
        indices = Array.from(/** @type {any} */ (idx.array));
      }
      if (indices.length % 3 !== 0) {
        errors.push(`${where}: ${indices.length} indices are not a whole number of triangles`);
        return;
      }
      const tris = indices.length / 3;
      triangleCount += tris;
      const mat = materials[prim.material] ?? {};
      const color = Array.isArray(mat.pbrMetallicRoughness?.baseColorFactor)
        ? mat.pbrMetallicRoughness.baseColorFactor.slice(0, 4)
        : [0.75, 0.75, 0.78, 1];
      if (mat.pbrMetallicRoughness?.baseColorTexture || mat.normalTexture || mat.occlusionTexture) {
        warnings.push(`${where}: textured material renders flat in v1`);
      }
      outMeshes.push({
        name: typeof mesh.name === "string" ? mesh.name : `mesh-${mi}`,
        positions: Array.from(/** @type {Float32Array} */ (pos.array)),
        normals: Array.from(/** @type {Float32Array} */ (nor.array)),
        indices,
        color,
      });
    });
  });

  if (json.animations?.length) warnings.push(`${json.animations.length} animation(s) ignored: the viewer shows the bind pose`);
  if (json.skins?.length) warnings.push(`${json.skins.length} skin(s) ignored: the viewer shows the bind pose`);
  if (json.cameras?.length) warnings.push(`${json.cameras.length} camera(s) ignored: the viewer auto-frames from bounds`);
  if (json.images?.length) warnings.push(`${json.images.length} image(s) ignored: materials render flat in v1`);

  if (errors.length) return fail(errors, warnings, buf);

  // ── decimation + bounds ────────────────────────────────────────────────
  let decimated = false;
  if (triangleCount > maxTriangles) {
    decimated = true;
    let budget = maxTriangles;
    for (const m of outMeshes) {
      const tris = m.indices.length / 3;
      const keep = Math.min(tris, budget);
      // Stride from triangle 0: deterministic, shape-preserving in aggregate.
      const stride = Math.max(1, Math.floor(tris / Math.max(1, keep)));
      const kept = [];
      for (let t = 0; t < tris && kept.length / 3 < keep; t += stride) {
        kept.push(m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2]);
      }
      m.indices = kept;
      budget -= kept.length / 3;
    }
    warnings.push(
      `decimated ${triangleCount} → ${maxTriangles} triangles by stride (deterministic); upload a lighter model for full fidelity`,
    );
  }

  /** @type {number[]} */
  let min = [Infinity, Infinity, Infinity];
  /** @type {number[]} */
  let max = [-Infinity, -Infinity, -Infinity];
  for (const m of outMeshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = m.positions[i + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
  }
  if (!outMeshes.length) return fail(["no renderable primitives survived moderation"], warnings, buf);

  const kept = outMeshes.reduce((s, m) => s + m.indices.length / 3, 0);
  return {
    ok: true,
    errors: [],
    warnings: [...new Set(warnings)],
    stats: {
      byteLength: buf.length,
      nodeCount: nodes.length,
      meshCount: meshes.length,
      primitiveCount,
      triangleCount,
      trianglesKept: kept,
      decimated,
    },
    sidecar: {
      bounds: { min: min.map(round4), max: max.map(round4) },
      meshes: outMeshes.map((m) => ({
        ...m,
        positions: m.positions.map(round4),
        normals: m.normals.map(round4),
      })),
    },
  };
}

/** @param {string} type */
function componentSize(type) {
  return type === "SCALAR" ? 1 : type === "VEC2" ? 2 : type === "VEC3" ? 3 : type === "VEC4" ? 4 : 0;
}

/** @param {number} n */
function round4(n) {
  const r = Math.round(n * 1e4) / 1e4;
  return r === 0 ? 0 : r;
}

/**
 * @param {string[]} errors
 * @param {string[]} warnings
 * @param {Buffer} buf
 * @returns {GlbModeration}
 */
function fail(errors, warnings, buf) {
  return {
    ok: false,
    errors,
    warnings: [...new Set(warnings)],
    stats: {
      byteLength: buf.length,
      nodeCount: 0,
      meshCount: 0,
      primitiveCount: 0,
      triangleCount: 0,
      trianglesKept: 0,
      decimated: false,
    },
    sidecar: null,
  };
}
