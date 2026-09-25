/**
 * Canvas2D product layer — the render path when WebGL is unavailable.
 *
 * Same interface as WebglScene, same seeded layout, same explicit-phase
 * rendering, so the runtime can swap one for the other without knowing which
 * it has, and so checkpoint screenshots stay comparable.
 *
 * Visually this is a deliberately cheaper halo: sprites are drawn with
 * `drawImage` from a pre-tinted offscreen sprite rather than shaded per
 * fragment, and there is one pass regardless of what the tier declares. That
 * difference is the point — the fallback is meant to be visibly simpler and
 * genuinely cheaper, not a pixel-identical imitation that happens to be slow.
 */

export class Canvas2dScene {
  constructor() {
    this.kind = "canvas2d";
    /** @type {CanvasRenderingContext2D | null} */
    this.ctx = null;
    this.particleCount = 0;
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
    const ctx = opts.canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("CANVAS2D_CONTEXT_UNAVAILABLE");
    this.ctx = ctx;
    this.canvas = opts.canvas;

    // The 2D path caps particle count harder than the tier asks for: without
    // a GPU, per-sprite compositing is the whole cost, and honouring a 2600
    // sprite request here would just guarantee a dropped-frame failure on the
    // exact devices this path exists to rescue.
    this.particleCount = Math.min(opts.tier.params.particleCount, 320);
    // The 2D path has no shader glow to amplify each sprite. Give it a larger
    // minimum footprint so its first frame remains visibly non-blank at the
    // lowest tier without increasing the sprite count.
    this.spriteSize = Math.min(24, Math.max(8, Math.round(opts.tier.params.textureSize / 11)));

    /** @type {Array<{ a: number; r: number; speed: number; size: number; tint: number; fade: number }>} */
    this.particles = [];
    for (let i = 0; i < this.particleCount; i++) {
      const s0 = opts.random();
      const s1 = opts.random();
      this.particles.push({
        a: s0 * Math.PI * 2,
        r: 0.22 + opts.random() * 0.46,
        speed: 0.25 + opts.random() * 0.55,
        size: this.spriteSize * (0.55 + 0.75 * s1),
        tint: s0,
        fade: 0.35 + 0.65 * s1,
      });
    }

    this.sprite = buildSprite(opts.textureImage, this.spriteSize * 2);
    return this;
  }

  /** @param {number} phase */
  renderFrame(phase) {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";

    const cx = w / 2;
    const cy = h / 2;
    const scale = Math.min(w, h) / 2;

    for (const p of this.particles) {
      const angle = p.a + phase * p.speed;
      const wobble = Math.sin(phase * 0.7 + p.tint * Math.PI * 2) * 0.06;
      const r = p.r + wobble;
      const x = cx + Math.cos(angle) * r * scale;
      const y = cy + Math.sin(angle) * r * scale * 0.82 + 0.04 * Math.sin(phase * 0.45 + p.a) * scale;
      ctx.globalAlpha = p.fade;
      ctx.drawImage(this.sprite, x - p.size / 2, y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** @param {number} [fromPhase] */
  startAnimating(fromPhase = 0) {
    if (this._animating) return;
    this._animating = true;
    this._startedAt = performance.now();
    const loop = () => {
      if (!this._animating) return;
      this.renderFrame(fromPhase + (performance.now() - this._startedAt) / 1000);
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
    this.ctx = null;
  }
}

/**
 * Bakes the texture into a single tinted sprite once, rather than tinting per
 * draw. On the devices that land on this path, per-draw filter work is exactly
 * what blows the frame budget.
 *
 * @param {HTMLImageElement} image
 * @param {number} size
 * @returns {HTMLCanvasElement}
 */
function buildSprite(image, size) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  ctx.drawImage(image, 0, 0, size, size);
  // Radial alpha falloff so sprite edges stay soft; matches the smoothstep
  // mask the WebGL fragment shader applies.
  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.18, size / 2, size / 2, size * 0.5);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = "source-over";
  return c;
}
