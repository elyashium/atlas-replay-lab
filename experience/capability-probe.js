/**
 * On-device capability probe.
 *
 * Produces exactly the `CapabilitySnapshot` shape in types/atlas.d.ts and
 * nothing else. The shape is an allow-list, not a starting point: the server
 * re-normalises everything it receives (see src/capability/buckets.js), so a
 * field added here by accident would be dropped rather than forwarded.
 *
 * Privacy, deliberately:
 *
 *  - The user agent string is never read.
 *  - `WEBGL_debug_renderer_info` IS read to classify the GPU, and the renderer
 *    string is discarded inside `classifyGpu()` before it can be stored or
 *    transmitted. Only the four-value tier leaves this function. The string is
 *    a strong fingerprinting surface; the tier is not.
 *  - No canvas/font/audio fingerprinting, no storage reads, no cookies.
 *  - `navigator.permissions.query` is used to observe camera permission
 *    *without* prompting. getUserMedia is only called later, and only on the
 *    camera path, and only after the decision layer has said the camera path
 *    is safe.
 *
 * @typedef {import("../types/atlas.js").CapabilitySnapshot} CapabilitySnapshot
 */

/** Values the matrix runner injects so the probe reports emulated hardware. */
const overrides = /** @type {any} */ (globalThis).__ATLAS__?.probeOverrides ?? {};

/**
 * @returns {Promise<CapabilitySnapshot>}
 */
export async function probeCapabilities() {
  const webgl = detectWebgl();

  return {
    deviceMemoryGB: pickNumber(overrides.deviceMemoryGB, /** @type {any} */ (navigator).deviceMemory),
    hardwareConcurrency: pickNumber(overrides.hardwareConcurrency, navigator.hardwareConcurrency),
    gpuTier: overrides.gpuTier ?? webgl.gpuTier,
    webglVersion: webgl.version,
    webgpuAvailable: "gpu" in navigator,
    webcodecsAvailable: typeof globalThis.VideoDecoder === "function",
    cameraPermission: await probeCameraPermission(),
    effectiveConnectionType: overrides.effectiveConnectionType ?? readEct(),
    downlinkMbps: pickNumber(overrides.downlinkMbps, connection()?.downlink),
    rttMs: pickNumber(overrides.rttMs, connection()?.rtt),
    reducedMotionPreferred: matchMedia("(prefers-reduced-motion: reduce)").matches,
    viewport: {
      width: Math.round(window.innerWidth),
      height: Math.round(window.innerHeight),
    },
    // Unknown before any frame has rendered. The runtime re-decides mid-session
    // with this populated — that second call is what makes the router adaptive
    // rather than a one-shot guess at boot.
    recentFrameTimeMsP95: null,
  };
}

/**
 * Probes WebGL once, on a throwaway 1x1 canvas that is never inserted into the
 * document and never read back.
 *
 * @returns {{ version: 0 | 1 | 2; gpuTier: "unknown" | "none" | "low" | "mid" | "high" }}
 */
function detectWebgl() {
  /** @type {HTMLCanvasElement} */
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;

  /** @type {WebGLRenderingContext | WebGL2RenderingContext | null} */
  let gl = null;
  /** @type {0 | 1 | 2} */
  let version = 0;

  try {
    gl = /** @type {WebGL2RenderingContext | null} */ (canvas.getContext("webgl2"));
    if (gl) version = 2;
  } catch {
    gl = null;
  }
  if (!gl) {
    try {
      gl = /** @type {WebGLRenderingContext | null} */ (
        canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")
      );
      if (gl) version = 1;
    } catch {
      gl = null;
    }
  }

  if (!gl) return { version: 0, gpuTier: "none" };

  const tier = classifyGpu(gl);
  // Release the context promptly rather than leaving it to GC; on low-memory
  // devices a stray context is a real cost.
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { version, gpuTier: tier };
}

/**
 * Classifies the GPU into four coarse buckets. The renderer string is read,
 * used, and dropped inside this function — it is never returned, stored, or
 * transmitted.
 *
 * @param {WebGLRenderingContext | WebGL2RenderingContext} gl
 * @returns {"unknown" | "none" | "low" | "mid" | "high"}
 */
function classifyGpu(gl) {
  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
  const maxVarying = gl.getParameter(gl.MAX_VARYING_VECTORS) || 0;

  let renderer = "";
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (ext) renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "").toLowerCase();
  } catch {
    renderer = "";
  }

  // Software rasterisers report large texture limits while being slow, so the
  // substring check has to come before the limit check.
  const software = /swiftshader|llvmpipe|softwarerasterizer|microsoft basic render/.test(renderer);
  renderer = ""; // dropped, explicitly, before anything can capture it

  if (software) return "low";
  if (!maxTexture) return "unknown";
  if (maxTexture >= 16384 && maxVarying >= 30) return "high";
  if (maxTexture >= 8192) return "mid";
  if (maxTexture >= 4096) return "low";
  return "low";
}

/**
 * Reads camera permission without prompting. `permissions.query` is not
 * universally implemented for "camera"; when it is missing, the honest answer
 * is "prompt" (a camera may exist and we have not asked), not "granted".
 *
 * @returns {Promise<"granted" | "denied" | "prompt" | "unavailable">}
 */
async function probeCameraPermission() {
  if (!navigator.mediaDevices?.getUserMedia) return "unavailable";
  try {
    const status = await navigator.permissions?.query(
      /** @type {any} */ ({ name: "camera" }),
    );
    if (status?.state === "granted" || status?.state === "denied" || status?.state === "prompt") {
      return status.state;
    }
  } catch {
    /* Firefox and Safari have historically thrown here. Fall through. */
  }
  return "prompt";
}

/** @returns {any} */
function connection() {
  return /** @type {any} */ (navigator).connection ?? null;
}

/** @returns {"slow-2g" | "2g" | "3g" | "4g" | "unknown"} */
function readEct() {
  const ect = connection()?.effectiveType;
  return ect === "slow-2g" || ect === "2g" || ect === "3g" || ect === "4g" ? ect : "unknown";
}

/**
 * @param {unknown} override
 * @param {unknown} actual
 * @returns {number | null}
 */
function pickNumber(override, actual) {
  if (typeof override === "number" && Number.isFinite(override)) return override;
  if (typeof actual === "number" && Number.isFinite(actual)) return actual;
  return null;
}
