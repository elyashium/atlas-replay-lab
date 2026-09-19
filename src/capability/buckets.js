/**
 * Capability bucketing.
 *
 * Every aggregate in Atlas — dashboards, gate summaries, comparison reports —
 * groups by these coarse buckets and never by the raw snapshot. That is a
 * privacy property, not a cosmetic one: a bucket is deliberately too
 * low-entropy to re-identify a device, while still being the axis you actually
 * want to slice performance by.
 *
 * @typedef {import("../../types/atlas.js").CapabilitySnapshot} CapabilitySnapshot
 * @typedef {import("../../types/atlas.js").CapabilityBucket} CapabilityBucket
 */

/**
 * @param {CapabilitySnapshot} s
 * @returns {CapabilityBucket}
 */
export function bucketOf(s) {
  const mem = s.deviceMemoryGB ?? 4;
  const cores = s.hardwareConcurrency ?? 4;

  /** @type {CapabilityBucket["compute"]} */
  let compute = "moderate";
  if (mem <= 2 || cores <= 4) compute = "weak";
  if (mem >= 8 && cores >= 8) compute = "strong";

  /** @type {CapabilityBucket["network"]} */
  let network = "fair";
  const ect = s.effectiveConnectionType;
  const down = s.downlinkMbps ?? 5;
  const rtt = s.rttMs ?? 120;
  if (ect === "slow-2g" || ect === "2g" || ect === "3g" || down < 2 || rtt > 300) network = "poor";
  else if (ect === "4g" && down >= 8 && rtt <= 150) network = "good";

  /** @type {CapabilityBucket["graphics"]} */
  let graphics = "none";
  if (s.webglVersion >= 1) graphics = "basic";
  if ((s.webglVersion >= 2 && s.gpuTier !== "low") || s.webgpuAvailable) graphics = "accelerated";

  /** @type {CapabilityBucket["camera"]} */
  const camera = s.cameraPermission === "granted" ? "usable" : "blocked";

  return { compute, network, graphics, camera, id: `${compute}/${network}/${graphics}/${camera}` };
}

/**
 * Normalises a partial/untrusted snapshot (e.g. one posted by a browser) into
 * the exact shape the decision layer expects. Unknown fields are dropped — the
 * decision layer must never see anything the schema did not ask for, which is
 * also what keeps accidental PII out of a third-party API call.
 *
 * @param {Partial<CapabilitySnapshot> | null | undefined} raw
 * @returns {CapabilitySnapshot}
 */
export function normalizeSnapshot(raw) {
  const r = raw ?? {};
  const ectAllowed = new Set(["slow-2g", "2g", "3g", "4g", "unknown"]);
  const gpuAllowed = new Set(["unknown", "none", "low", "mid", "high"]);
  const camAllowed = new Set(["granted", "denied", "prompt", "unavailable"]);
  return {
    deviceMemoryGB: num(r.deviceMemoryGB),
    hardwareConcurrency: num(r.hardwareConcurrency),
    gpuTier: /** @type {any} */ (gpuAllowed.has(String(r.gpuTier)) ? r.gpuTier : "unknown"),
    webglVersion: /** @type {0|1|2} */ (r.webglVersion === 2 ? 2 : r.webglVersion === 1 ? 1 : 0),
    webgpuAvailable: Boolean(r.webgpuAvailable),
    webcodecsAvailable: Boolean(r.webcodecsAvailable),
    cameraPermission: /** @type {any} */ (camAllowed.has(String(r.cameraPermission)) ? r.cameraPermission : "unavailable"),
    effectiveConnectionType: /** @type {any} */ (ectAllowed.has(String(r.effectiveConnectionType)) ? r.effectiveConnectionType : "unknown"),
    downlinkMbps: num(r.downlinkMbps),
    rttMs: num(r.rttMs),
    reducedMotionPreferred: Boolean(r.reducedMotionPreferred),
    viewport: {
      width: Math.round(num(r.viewport?.width) ?? 0),
      height: Math.round(num(r.viewport?.height) ?? 0),
    },
    recentFrameTimeMsP95: num(r.recentFrameTimeMsP95),
  };
}

/** @param {unknown} v @returns {number | null} */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Which optional capabilities this state actually satisfies. Used by both
 * engines to resolve the fallback path, which is a pure function of capability
 * and is therefore never delegated to a model.
 *
 * @param {CapabilitySnapshot} s
 * @returns {Set<string>}
 */
export function satisfiedRequirements(s) {
  const out = new Set();
  if (s.webglVersion >= 1) out.add("webgl1");
  if (s.webglVersion >= 2) out.add("webgl2");
  if (s.webgpuAvailable) out.add("webgpu");
  if (s.webcodecsAvailable) out.add("webcodecs");
  if (s.cameraPermission === "granted") out.add("camera");
  if (!s.reducedMotionPreferred) out.add("motion");
  return out;
}

/**
 * Resolves the highest-priority fallback path whose requirements the state
 * satisfies. Deterministic in both engines.
 *
 * @param {CapabilitySnapshot} s
 * @param {import("../../types/atlas.js").ExperienceManifest} manifest
 * @param {import("../../types/atlas.js").ServeTier} tier
 * @returns {import("../../types/atlas.js").PathId}
 */
export function resolvePath(s, manifest, tier) {
  // static-fallback always means the static-safe path, whatever the hardware.
  if (tier === "static-fallback") return "static-safe";
  const have = satisfiedRequirements(s);
  const ordered = [...manifest.fallbackPaths].sort((a, b) => a.priority - b.priority);
  for (const p of ordered) {
    if ((p.requires ?? []).every((r) => have.has(r))) return p.id;
  }
  return "static-safe";
}
