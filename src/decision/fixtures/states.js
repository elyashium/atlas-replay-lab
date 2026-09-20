/**
 * Synthetic capability snapshots for the §4.4 engine comparison.
 *
 * These are the "packets" both engines are asked to route. They are
 * hand-authored, not captured — a capability snapshot is a small enough object
 * that writing one by hand is honest, and the alternative (capturing six real
 * ones and calling twelve) would be worse.
 *
 * ## About `groundTruth`
 *
 * `groundTruth` is **a human judgement, not a measurement**. It is what a
 * careful engineer would say is the right tier for that state given this
 * manifest's budgets and assets. It is not the output of running the
 * experience and observing what worked, and the comparison report says so
 * wherever it reports accuracy against it.
 *
 * That distinction matters for reading the report: agreement between the two
 * engines is a real measurement (two implementations, one question set, no
 * human in the loop). Accuracy against `groundTruth` is a measurement of
 * agreement with *me*, and a rule engine I wrote scoring well against labels I
 * also wrote is close to circular. The cases below marked `contested: true`
 * are the ones where I think a reasonable engineer could pick a different
 * label; they are included precisely so the report is not a lap of honour.
 *
 * @typedef {import("../../../types/atlas.js").CapabilitySnapshot} CapabilitySnapshot
 * @typedef {import("../../../types/atlas.js").ServeTier} ServeTier
 */

/**
 * @typedef {object} SyntheticState
 * @property {string} id
 * @property {string} label
 * @property {CapabilitySnapshot} state
 * @property {ServeTier} groundTruth        hand-assigned expected tier
 * @property {boolean} cameraExpectedSafe   hand-assigned expected camera verdict
 * @property {boolean} [contested]          a reasonable engineer might label this differently
 * @property {string} [note]
 */

/** @param {Partial<CapabilitySnapshot>} over @returns {CapabilitySnapshot} */
function snapshot(over) {
  return {
    deviceMemoryGB: 4,
    hardwareConcurrency: 4,
    gpuTier: "mid",
    webglVersion: 2,
    webgpuAvailable: false,
    webcodecsAvailable: true,
    cameraPermission: "prompt",
    effectiveConnectionType: "4g",
    downlinkMbps: 10,
    rttMs: 50,
    reducedMotionPreferred: false,
    viewport: { width: 390, height: 844 },
    recentFrameTimeMsP95: null,
    ...over,
  };
}

/** @type {SyntheticState[]} */
export const SYNTHETIC_STATES = [
  {
    id: "desktop-wifi-strong",
    label: "High-end desktop on Wi-Fi",
    state: snapshot({
      deviceMemoryGB: 16,
      hardwareConcurrency: 12,
      gpuTier: "high",
      webglVersion: 2,
      webgpuAvailable: true,
      cameraPermission: "granted",
      effectiveConnectionType: "4g",
      downlinkMbps: 45,
      rttMs: 15,
      viewport: { width: 1440, height: 900 },
    }),
    groundTruth: "high",
    cameraExpectedSafe: true,
  },
  {
    id: "flagship-android-4g",
    label: "Flagship Android on good 4G",
    state: snapshot({
      deviceMemoryGB: 8,
      hardwareConcurrency: 8,
      gpuTier: "high",
      cameraPermission: "granted",
      downlinkMbps: 18,
      rttMs: 40,
    }),
    groundTruth: "high",
    cameraExpectedSafe: true,
  },
  {
    id: "mid-android-4g",
    label: "Mid-range Android on ordinary 4G",
    state: snapshot({
      deviceMemoryGB: 4,
      hardwareConcurrency: 4,
      gpuTier: "mid",
      cameraPermission: "granted",
      downlinkMbps: 8,
      rttMs: 70,
    }),
    groundTruth: "mid",
    cameraExpectedSafe: true,
  },
  {
    id: "mid-android-3g",
    label: "Mid-range Android dropping to 3G",
    state: snapshot({
      deviceMemoryGB: 4,
      hardwareConcurrency: 4,
      gpuTier: "mid",
      cameraPermission: "granted",
      effectiveConnectionType: "3g",
      downlinkMbps: 1.4,
      rttMs: 300,
    }),
    groundTruth: "low",
    cameraExpectedSafe: true,
    contested: true,
    note:
      "The device could render 'mid'; the network probably cannot deliver its assets " +
      "inside the first-frame budget. Labelled 'low' because the budget is the binding " +
      "constraint, but 'mid' with a slower first frame is a defensible product call.",
  },
  {
    id: "low-cpu-3g",
    label: "Low-CPU device on 3G — the failure-story profile",
    state: snapshot({
      deviceMemoryGB: 2,
      hardwareConcurrency: 2,
      gpuTier: "low",
      webglVersion: 1,
      webcodecsAvailable: false,
      cameraPermission: "granted",
      effectiveConnectionType: "3g",
      downlinkMbps: 1.1,
      rttMs: 350,
      recentFrameTimeMsP95: 48,
    }),
    groundTruth: "low",
    cameraExpectedSafe: false,
  },
  {
    id: "packet-loss-4g",
    label: "Nominal 4G with heavy packet loss",
    state: snapshot({
      deviceMemoryGB: 4,
      hardwareConcurrency: 4,
      gpuTier: "mid",
      cameraPermission: "granted",
      downlinkMbps: 6,
      rttMs: 600,
      recentFrameTimeMsP95: 22,
    }),
    groundTruth: "low",
    cameraExpectedSafe: true,
    contested: true,
    note:
      "Reported downlink looks fine; RTT betrays the loss. A router that reads only " +
      "downlink will say 'mid' here, which is exactly the kind of miss worth surfacing.",
  },
  {
    id: "camera-denied",
    label: "Capable device, camera denied",
    state: snapshot({
      deviceMemoryGB: 8,
      hardwareConcurrency: 8,
      gpuTier: "high",
      cameraPermission: "denied",
      downlinkMbps: 20,
      rttMs: 35,
    }),
    groundTruth: "high",
    cameraExpectedSafe: false,
    note:
      "Denied camera changes the *path*, not the tier. A router that downgrades the " +
      "tier because a permission was refused is conflating two independent decisions.",
  },
  {
    id: "no-webgl",
    label: "WebGL unavailable",
    state: snapshot({
      deviceMemoryGB: 4,
      hardwareConcurrency: 4,
      gpuTier: "none",
      webglVersion: 0,
      webcodecsAvailable: false,
      cameraPermission: "denied",
    }),
    groundTruth: "low",
    cameraExpectedSafe: false,
    note: "The 2D canvas path still renders; 'low' requires no WebGL.",
  },
  {
    id: "reduced-motion",
    label: "Capable device, user prefers reduced motion",
    state: snapshot({
      deviceMemoryGB: 8,
      hardwareConcurrency: 8,
      gpuTier: "high",
      cameraPermission: "granted",
      reducedMotionPreferred: true,
      downlinkMbps: 25,
      rttMs: 30,
    }),
    groundTruth: "static-fallback",
    cameraExpectedSafe: true,
    note:
      "An accessibility preference, not a capability limit. Serving a static poster " +
      "here is respecting a stated request, which is why it outranks raw capability.",
  },
  {
    id: "slow-2g-minimal",
    label: "Minimal device on slow-2G",
    state: snapshot({
      deviceMemoryGB: 1,
      hardwareConcurrency: 1,
      gpuTier: "none",
      webglVersion: 0,
      webcodecsAvailable: false,
      cameraPermission: "unavailable",
      effectiveConnectionType: "slow-2g",
      downlinkMbps: 0.2,
      rttMs: 1800,
    }),
    groundTruth: "static-fallback",
    cameraExpectedSafe: false,
  },
  {
    id: "unknown-everything",
    label: "Probe learned almost nothing",
    state: snapshot({
      deviceMemoryGB: null,
      hardwareConcurrency: null,
      gpuTier: "unknown",
      webglVersion: 1,
      webcodecsAvailable: false,
      cameraPermission: "prompt",
      effectiveConnectionType: "unknown",
      downlinkMbps: null,
      rttMs: null,
    }),
    groundTruth: "low",
    cameraExpectedSafe: false,
    note:
      "Missing signal is not permission to be optimistic. A conservative tier on an " +
      "unknown device is recoverable; an over-ambitious one is a blank screen.",
  },
  {
    id: "stalling-midsession",
    label: "Capable on paper, already stalling",
    state: snapshot({
      deviceMemoryGB: 8,
      hardwareConcurrency: 8,
      gpuTier: "high",
      cameraPermission: "granted",
      downlinkMbps: 30,
      rttMs: 25,
      recentFrameTimeMsP95: 180,
    }),
    groundTruth: "low",
    cameraExpectedSafe: false,
    contested: true,
    note:
      "Every static signal says 'high'; observed frame time says the device is " +
      "already drowning. This is the case for feeding live telemetry back into the " +
      "router rather than deciding once at load.",
  },
];

/** @param {string} id */
export function stateById(id) {
  const found = SYNTHETIC_STATES.find((s) => s.id === id);
  if (!found) throw new Error(`unknown synthetic state "${id}"`);
  return found;
}
