/**
 * Atlas model viewer — a deliberately dumb page.
 *
 * It renders one uploaded model, rotates it on drag, and offers XR entry. It
 * contains no Atlas instrumentation: the generic probe (injected separately by
 * the matrix) records frames, assets, XR phases and errors, and the generic
 * driver performs the look-around and taps the XR button. A page that
 * instrumented itself for the harness would be testing the instrumentation.
 *
 * Determinism: fixed start orientation from the model's bounds, no auto-orbit,
 * no randomness anywhere. Given the same sidecar and the same input script,
 * every run paints the same pixels.
 */

import { viewerTierSettings, frameDistance, lookAt, perspective, multiply } from "./ladder.js";

const params = new URLSearchParams(location.search);
const modelHash = params.get("model") ?? "";
const hudTier = document.getElementById("hud-tier");
const errBox = document.getElementById("err");
/** @type {HTMLCanvasElement} */
const canvas = /** @type {any} */ (document.getElementById("scene"));
const xrButton = document.getElementById("xr-button");
const poster = document.getElementById("poster");
const posterMeta = document.getElementById("poster-meta");

const view = { yaw: 0.6, pitch: 0.35 };
let drag = null;

main().catch((err) => {
  errBox.textContent = `viewer failed: ${err instanceof Error ? err.message : String(err)}`;
});

async function main() {
  if (!/^[0-9a-f]{16,64}$/.test(modelHash)) {
    throw new Error("missing ?model=<content hash> — this page is served by `atlas matrix --glb`, not opened directly");
  }
  // Sidecar and tier decision fetch in parallel so neither waterfall lengthens
  // time-to-first-paint: on fast profiles the probe samples early, and a paint
  // delayed by our own request chain would read as a blank first frame.
  const sidecarPromise = fetch(`/uploads/${modelHash}.atlas.json`, { cache: "no-store" }).then(async (res) => {
    if (!res.ok) throw new Error(`sidecar fetch failed: HTTP ${res.status}`);
    const sidecar = await res.json();
    if (!sidecar?.meshes?.length) throw new Error("sidecar has no meshes");
    return sidecar;
  });
  const tierPromise = decideTier();
  const sidecar = await sidecarPromise;

  const tier = await tierPromise;
  hudTier.textContent = `tier ${tier}`;
  const settings = viewerTierSettings(tier);

  if (!settings.animate) {
    showPoster(sidecar, tier);
    wireXr();
    return;
  }

  const renderer = createRenderer(canvas, sidecar, settings);
  if (!renderer) {
    showPoster(sidecar, `${tier} (webgl unavailable)`);
    wireXr();
    return;
  }

  wireDrag();
  wireXr();
  renderer.frame();
}

function showPoster(sidecar, tier) {
  canvas.style.display = "none";
  const tris = sidecar.meshes.reduce((s, m) => s + m.indices.length / 3, 0);
  posterMeta.textContent = `${sidecar.meshes.length} mesh(es), ${tris} triangles · tier ${tier}`;
  poster.style.display = "flex";
}

/* ── tier decision (same control plane Orbital uses) ─────────────────────── */

async function decideTier() {
  try {
    const probe = await import("../capability-probe.js");
    const state = await probe.probeCapabilities();
    const res = await fetch("/api/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state }),
    });
    if (!res.ok) throw new Error(`decide returned ${res.status}`);
    const body = await res.json();
    if (typeof body?.decision?.tier === "string") return body.decision.tier;
  } catch {
    /* control plane unreachable: safest renderable rung, same as Orbital */
  }
  return "low";
}

/* ── input ───────────────────────────────────────────────────────────────── */

function wireDrag() {
  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    view.yaw = drag.yaw + (e.clientX - drag.x) * 0.008;
    view.pitch = Math.max(-1.2, Math.min(1.2, drag.pitch + (e.clientY - drag.y) * 0.008));
    renderOnce();
  });
  const end = () => { drag = null; };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}

function wireXr() {
  if (!("xr" in navigator)) {
    xrButton.disabled = true;
    xrButton.title = "WebXR not available in this browser";
    return;
  }
  xrButton.addEventListener("click", async () => {
    try {
      const xr = navigator.xr;
      const mode = (await xr.isSessionSupported("immersive-ar").catch(() => false))
        ? "immersive-ar"
        : "immersive-vr";
      if (!(await xr.isSessionSupported(mode).catch(() => false))) {
        xrButton.textContent = "XR unavailable";
        return;
      }
      const session = await xr.requestSession(mode, { optionalFeatures: ["local-floor"] });
      xrButton.textContent = "In XR — ending…";
      session.addEventListener("end", () => { xrButton.textContent = "Enter XR"; });
      // A showcase session, not a session manager: hold briefly so the
      // lifecycle (request → start → end) is exercised, then hand back.
      setTimeout(() => session.end().catch(() => {}), 3000);
    } catch {
      xrButton.textContent = "XR refused";
    }
  });
}

/* ── renderer (raw WebGL, no library) ────────────────────────────────────── */

let renderer = null;
function renderOnce() {
  renderer?.frame();
}

function createRenderer(canvas, sidecar, settings) {
  // WebGL2 for native UINT indices; WebGL1 where the device predates it.
  const gl = canvas.getContext("webgl2", { antialias: true }) ??
    canvas.getContext("webgl", { antialias: true });
  if (!gl) return null;

  const dpr = Math.min(window.devicePixelRatio || 1, settings.dprCap);
  const resize = () => {
    canvas.width = Math.max(2, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(2, Math.round(canvas.clientHeight * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  resize();
  window.addEventListener("resize", resize);

  const lit = settings.shading === "lit";
  const prog = link(gl, vertexSrc(lit), fragmentSrc(lit));
  if (!prog) return null;
  gl.useProgram(prog);
  const loc = {
    pos: gl.getAttribLocation(prog, "a_pos"),
    nor: lit ? gl.getAttribLocation(prog, "a_nor") : -1,
    color: gl.getUniformLocation(prog, "u_color"),
    mvp: gl.getUniformLocation(prog, "u_mvp"),
    normalMat: lit ? gl.getUniformLocation(prog, "u_normalMat") : null,
    lightDir: lit ? gl.getUniformLocation(prog, "u_lightDir") : null,
  };

  const drawList = [];
  for (const mesh of sidecar.meshes) {
    const triCount = Math.min(mesh.indices.length / 3, settings.triCap);
    const use = [];
    for (let t = 0; t < triCount; t++) use.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]);
    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.positions), gl.STATIC_DRAW);
    const norBuf = lit ? gl.createBuffer() : null;
    if (lit && norBuf) {
      gl.bindBuffer(gl.ARRAY_BUFFER, norBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.normals), gl.STATIC_DRAW);
    }
    const idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    const needUint = mesh.positions.length / 3 > 65535;
    // The typed array must match the draw type: reading a Uint32 buffer as
    // UNSIGNED_SHORT reinterprets every 4-byte index as two 2-byte ones and
    // draws garbage (usually degenerate, so the failure reads as "blank").
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, needUint ? new Uint32Array(use) : new Uint16Array(use), gl.STATIC_DRAW);
    drawList.push({ posBuf, norBuf, idxBuf, count: use.length, color: mesh.color, uint: needUint });
  }
  if (!drawList.length) return null;

  // Auto-frame from bounds (see ladder.js frameDistance): bounding sphere
  // against the tighter frustum, fixed angles, so the framing is
  // deterministic and rotation-proof.
  const { min, max } = sidecar.bounds;
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const aspect = canvas.width / Math.max(1, canvas.height);
  const dist = frameDistance(sidecar.bounds, aspect);

  function frame() {
    resize();
    gl.clearColor(0.063, 0.078, 0.094, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const eye = [
      center[0] + dist * Math.cos(view.pitch) * Math.sin(view.yaw),
      center[1] + dist * Math.sin(view.pitch),
      center[2] + dist * Math.cos(view.pitch) * Math.cos(view.yaw),
    ];
    const mvp = multiply(
      perspective(35, canvas.width / canvas.height, dist / 100, dist * 10),
      lookAt(eye, center),
    );
    gl.uniformMatrix4fv(loc.mvp, false, mvp);
    if (lit) {
      gl.uniformMatrix4fv(loc.normalMat, false, mvp);
      gl.uniform3f(loc.lightDir, 0.4, 0.8, 0.45);
    }
    for (const d of drawList) {
      gl.bindBuffer(gl.ARRAY_BUFFER, d.posBuf);
      gl.enableVertexAttribArray(loc.pos);
      gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 0, 0);
      if (lit && d.norBuf && loc.nor >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, d.norBuf);
        gl.enableVertexAttribArray(loc.nor);
        gl.vertexAttribPointer(loc.nor, 3, gl.FLOAT, false, 0, 0);
      }
      gl.uniform4f(loc.color, d.color[0], d.color[1], d.color[2], d.color[3] ?? 1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.idxBuf);
      // WebGL2 takes UINT indices natively; WebGL1 needs the (near-universal)
      // extension. A mesh that fits neither is skipped, not wrapped — wrapped
      // indices render garbage that looks like a broken model.
      const uintOk = !d.uint ||
        (typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext) ||
        gl.getExtension("OES_element_index_uint");
      if (!uintOk) continue;
      gl.drawElements(gl.TRIANGLES, d.count, d.uint ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
    }
  }

  renderer = { frame };
  return renderer;
}

/* ── shaders ─────────────────────────────────────────────────────────────── */

function vertexSrc(lit) {
  return `
attribute vec3 a_pos;
${lit ? "attribute vec3 a_nor;\nuniform mat4 u_normalMat;\nvarying vec3 v_nor;" : ""}
uniform mat4 u_mvp;
void main() {
  gl_Position = u_mvp * vec4(a_pos, 1.0);
${lit ? "  v_nor = normalize((u_normalMat * vec4(a_nor, 0.0)).xyz);" : ""}
}`;
}

function fragmentSrc(lit) {
  return `
precision mediump float;
uniform vec4 u_color;
${lit ? "varying vec3 v_nor;\nuniform vec3 u_lightDir;" : ""}
void main() {
${lit
  ? "  float ndl = max(dot(normalize(v_nor), normalize(u_lightDir)), 0.0);\n  vec3 c = u_color.rgb * (0.35 + 0.65 * ndl);\n  gl_FragColor = vec4(c, u_color.a);"
  : "  gl_FragColor = u_color;"}
}`;
}

function link(gl, vs, fs) {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
    return sh;
  };
  const v = compile(gl.VERTEX_SHADER, vs);
  const f = compile(gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  return prog;
}
