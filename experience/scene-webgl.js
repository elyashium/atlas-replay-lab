/**
 * WebGL product layer — the "camera-xr" and "interactive-2d" render path.
 *
 * Draws a halo of textured point sprites over a transparent framebuffer, so
 * the layer composites onto whatever is behind it (camera feed or static
 * anchor) without ever reading those pixels back.
 *
 * Two properties this scene is built for:
 *
 *  1. Cost scales with the tier, for real. `particleCount` is the vertex
 *     count, `textureSize` is the texture actually uploaded, and
 *     `shaderPasses` is the number of full additive passes per frame. On the
 *     high tier that is 2600 sprites sampling a 1024px texture three times
 *     per frame; on the low tier it is 160 sprites and one pass. Nothing here
 *     simulates load with a busy-wait — the manifest's `perFrameWorkMs` is a
 *     *declared estimate* consumed by the rule-based cost model, and the
 *     measured frame time in the trace is whatever the GPU actually did.
 *
 *  2. Rendering is a pure function of (seed, phase). Particle layout comes
 *     from the injected seeded RNG, and animation is driven by an explicit
 *     `phase` argument rather than by reading the clock. Checkpoint frames are
 *     rendered at a fixed phase, which is what makes two runs produce
 *     comparable screenshots without freezing time for the rest of the
 *     session (see docs/adr/0004).
 */

const VERT = `
attribute vec2 aSeed;      // stable per-particle random pair
attribute float aRadius;
attribute float aSpeed;
uniform float uPhase;
uniform float uAspect;
uniform float uPointScale;
varying float vFade;
varying float vTint;

void main() {
  float angle = aSeed.x * 6.2831853 + uPhase * aSpeed;
  float wobble = sin(uPhase * 0.7 + aSeed.y * 6.2831853) * 0.06;
  float r = aRadius + wobble;
  vec2 p = vec2(cos(angle) * r / uAspect, sin(angle) * r * 0.82);
  p.y += 0.04 * sin(uPhase * 0.45 + aSeed.x * 3.14159);
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = uPointScale * (0.55 + 0.75 * aSeed.y);
  vFade = 0.35 + 0.65 * aSeed.y;
  vTint = aSeed.x;
}`;

const FRAG = `
precision mediump float;
uniform sampler2D uTex;
uniform float uPassTint;
varying float vFade;
varying float vTint;

void main() {
  vec2 uv = gl_PointCoord;
  vec4 texel = texture2D(uTex, uv);
  float d = distance(uv, vec2(0.5));
  float mask = smoothstep(0.5, 0.18, d);
  vec3 tint = mix(vec3(0.43, 0.91, 1.0), vec3(0.72, 0.55, 1.0), vTint);
  tint = mix(tint, vec3(1.0), uPassTint * 0.35);
  gl_FragColor = vec4(tint * texel.rgb, texel.a * mask * vFade);
}`;

export class WebglScene {
  constructor() {
    this.kind = "webgl";
    /** @type {WebGLRenderingContext | WebGL2RenderingContext | null} */
    this.gl = null;
    this.particleCount = 0;
    this.shaderPasses = 1;
    this._raf = null;
    this._animating = false;
    this._startedAt = 0;
  }

  /**
   * @param {{
   *   canvas: HTMLCanvasElement;
   *   tier: import("../types/atlas.js").TierSpec;
   *   textureImage: HTMLImageElement;
   *   random: () => number;
   *   dpr: number;
   * }} opts
   */
  init(opts) {
    const { canvas, tier, textureImage, random } = opts;
    const attrs = { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, powerPreference: "low-power" };
    const gl = /** @type {WebGLRenderingContext | null} */ (
      canvas.getContext("webgl2", attrs) ?? canvas.getContext("webgl", attrs)
    );
    if (!gl) throw new Error("WEBGL_CONTEXT_UNAVAILABLE");
    this.gl = gl;
    this.canvas = canvas;
    this.particleCount = tier.params.particleCount;
    this.shaderPasses = tier.params.shaderPasses;
    this.pointScale = Math.max(6, tier.params.textureSize / 26);

    this.program = buildProgram(gl, VERT, FRAG);
    gl.useProgram(this.program);

    // Particle layout is drawn from the seeded RNG, so the same seed lays out
    // the same halo on every run and in every replay.
    const seeds = new Float32Array(this.particleCount * 2);
    const radii = new Float32Array(this.particleCount);
    const speeds = new Float32Array(this.particleCount);
    for (let i = 0; i < this.particleCount; i++) {
      seeds[i * 2] = random();
      seeds[i * 2 + 1] = random();
      radii[i] = 0.22 + random() * 0.46;
      speeds[i] = 0.25 + random() * 0.55;
    }

    this.buffers = {
      seed: makeBuffer(gl, seeds),
      radius: makeBuffer(gl, radii),
      speed: makeBuffer(gl, speeds),
    };
    this.attribs = {
      aSeed: gl.getAttribLocation(this.program, "aSeed"),
      aRadius: gl.getAttribLocation(this.program, "aRadius"),
      aSpeed: gl.getAttribLocation(this.program, "aSpeed"),
    };
    this.uniforms = {
      uPhase: gl.getUniformLocation(this.program, "uPhase"),
      uAspect: gl.getUniformLocation(this.program, "uAspect"),
      uPointScale: gl.getUniformLocation(this.program, "uPointScale"),
      uPassTint: gl.getUniformLocation(this.program, "uPassTint"),
      uTex: gl.getUniformLocation(this.program, "uTex"),
    };

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textureImage);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.clearColor(0, 0, 0, 0);
    return this;
  }

  /**
   * Renders exactly one frame at an explicit animation phase. Deterministic.
   * @param {number} phase
   */
  renderFrame(phase) {
    const gl = this.gl;
    if (!gl || !this.canvas) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    bindAttrib(gl, this.buffers.seed, this.attribs.aSeed, 2);
    bindAttrib(gl, this.buffers.radius, this.attribs.aRadius, 1);
    bindAttrib(gl, this.buffers.speed, this.attribs.aSpeed, 1);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uniforms.uTex, 0);
    gl.uniform1f(this.uniforms.uAspect, this.canvas.width / this.canvas.height);
    gl.uniform1f(this.uniforms.uPointScale, this.pointScale);

    // Each pass is a real additive pass at a slightly advanced phase — this is
    // where the high tier's extra fragment cost actually comes from.
    for (let pass = 0; pass < this.shaderPasses; pass++) {
      gl.uniform1f(this.uniforms.uPhase, phase + pass * 0.11);
      gl.uniform1f(this.uniforms.uPassTint, pass / Math.max(1, this.shaderPasses));
      gl.drawArrays(gl.POINTS, 0, this.particleCount);
    }
  }

  /** @param {number} [fromPhase] */
  startAnimating(fromPhase = 0) {
    if (this._animating) return;
    this._animating = true;
    this._startedAt = performance.now();
    const loop = () => {
      if (!this._animating) return;
      const phase = fromPhase + (performance.now() - this._startedAt) / 1000;
      this.renderFrame(phase);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stopAnimating() {
    this._animating = false;
    if (this._raf !== null) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  dispose() {
    this.stopAnimating();
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    this.gl = null;
  }
}

/**
 * @param {WebGLRenderingContext} gl
 * @param {string} vertSrc
 * @param {string} fragSrc
 */
function buildProgram(gl, vertSrc, fragSrc) {
  const vert = compile(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram();
  if (!program) throw new Error("WEBGL_PROGRAM_ALLOC_FAILED");
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`WEBGL_LINK_FAILED: ${gl.getProgramInfoLog(program)}`);
  }
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  return program;
}

/**
 * @param {WebGLRenderingContext} gl
 * @param {number} type
 * @param {string} src
 */
function compile(gl, type, src) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WEBGL_SHADER_ALLOC_FAILED");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`WEBGL_COMPILE_FAILED: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

/** @param {WebGLRenderingContext} gl @param {Float32Array} data */
function makeBuffer(gl, data) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return buf;
}

/**
 * @param {WebGLRenderingContext} gl
 * @param {WebGLBuffer | null} buffer
 * @param {number} location
 * @param {number} size
 */
function bindAttrib(gl, buffer, location, size) {
  if (location < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
}
