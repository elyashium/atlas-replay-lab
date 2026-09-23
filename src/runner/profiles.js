/**
 * The adversarial profiles: six core, plus two that synthesise WebXR.
 *
 * Honesty note, repeated in the README because it matters: these are Chromium
 * emulations, not devices. CPU throttling and network shaping are real and
 * applied by the browser; the hardware hints (deviceMemory, hardwareConcurrency,
 * navigator.connection, GPU tier) are injected into the page so the capability
 * probe sees what a device of that class would report. That is enough to
 * exercise the decision layer and the degrade ladder honestly, and it is not
 * enough to make claims about thermal behaviour, real GPU drivers, or actual
 * handset performance. Those need Stage 3's real-device lab.
 *
 * The same honesty note applies twice over to the two `xr-*` profiles. Headless
 * Chromium has no `navigator.xr`, so those two inject Atlas's own synthetic one
 * (`src/runner/xr-stub.js`) and every run that does records `xrStubNote()` in
 * its trace. What that buys is real: the app's session request, its refusal
 * path, its reference-space setup and its frame loop all execute. What it does
 * not buy is any claim about tracking quality, pose latency, or how the app
 * behaves on a real AR handset — a scripted pose is a scripted pose.
 *
 * @typedef {import("../../types/atlas.js").Profile} Profile
 */

const MBPS = 125_000; // bytes per second in one megabit per second

/** @type {Profile[]} */
export const PROFILES = [
  {
    id: "high-wifi",
    label: "High-end / Wi-Fi",
    description: "Reference desktop-class device on a fast connection. The tier ladder should reach 'high' here or something is wrong with the cost model.",
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    cpuThrottleRate: 1,
    network: { offline: false, downloadThroughputBps: 30 * MBPS, uploadThroughputBps: 10 * MBPS, latencyMs: 12 },
    probeOverrides: { deviceMemoryGB: 8, hardwareConcurrency: 12, effectiveConnectionType: "4g", downlinkMbps: 30, rttMs: 20, gpuTier: "high" },
    cameraPermission: "granted",
    disableWebgl: false,
    prefersReducedMotion: false,
    critical: true,
  },
  {
    id: "mid-android-4g",
    label: "Mid Android / 4G",
    description: "The volume case: a mid-range handset on a decent mobile connection.",
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
    cpuThrottleRate: 4,
    network: { offline: false, downloadThroughputBps: 9 * MBPS, uploadThroughputBps: 3 * MBPS, latencyMs: 170 },
    probeOverrides: { deviceMemoryGB: 4, hardwareConcurrency: 8, effectiveConnectionType: "4g", downlinkMbps: 9, rttMs: 170, gpuTier: "mid" },
    cameraPermission: "granted",
    disableWebgl: false,
    prefersReducedMotion: false,
    critical: true,
  },
  {
    id: "low-cpu-3g",
    label: "Low-CPU Android / 3G",
    description: "The failure story. 2GB of memory, four slow cores, 1.1Mbps at 380ms RTT. The baseline experience should not survive this on the 'high' tier.",
    viewport: { width: 360, height: 780, deviceScaleFactor: 2, mobile: true },
    cpuThrottleRate: 6,
    network: { offline: false, downloadThroughputBps: 1.1 * MBPS, uploadThroughputBps: 0.4 * MBPS, latencyMs: 380 },
    probeOverrides: { deviceMemoryGB: 2, hardwareConcurrency: 4, effectiveConnectionType: "3g", downlinkMbps: 1.1, rttMs: 380, gpuTier: "low" },
    cameraPermission: "granted",
    disableWebgl: false,
    prefersReducedMotion: false,
    critical: true,
  },
  {
    id: "packet-loss",
    label: "Lossy 4G",
    description: "A usable-looking connection that is intermittently not one. Exercises asset-failure handling rather than raw slowness.",
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
    cpuThrottleRate: 4,
    network: {
      offline: false,
      downloadThroughputBps: 4 * MBPS,
      uploadThroughputBps: 1 * MBPS,
      latencyMs: 300,
      packetLoss: 12,
      packetQueueLength: 8,
    },
    probeOverrides: { deviceMemoryGB: 4, hardwareConcurrency: 6, effectiveConnectionType: "3g", downlinkMbps: 4, rttMs: 300, gpuTier: "mid" },
    cameraPermission: "granted",
    disableWebgl: false,
    prefersReducedMotion: false,
    critical: true,
  },
  {
    id: "camera-denied",
    label: "Camera permission denied",
    description: "Capable hardware, no camera. The camera-xr path must not be attempted and the business invariant must still hold on the 2D path.",
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
    cpuThrottleRate: 2,
    network: { offline: false, downloadThroughputBps: 12 * MBPS, uploadThroughputBps: 4 * MBPS, latencyMs: 80 },
    probeOverrides: { deviceMemoryGB: 6, hardwareConcurrency: 8, effectiveConnectionType: "4g", downlinkMbps: 12, rttMs: 80, gpuTier: "mid" },
    cameraPermission: "denied",
    disableWebgl: false,
    prefersReducedMotion: false,
    critical: true,
  },
  {
    id: "webgl-unavailable",
    label: "No WebGL",
    description: "getContext('webgl'|'webgl2') returns null, as it does on locked-down or blocklisted devices. Forces the static-safe/2D path; checkout must still be reachable.",
    viewport: { width: 412, height: 915, deviceScaleFactor: 2, mobile: true },
    cpuThrottleRate: 3,
    network: { offline: false, downloadThroughputBps: 8 * MBPS, uploadThroughputBps: 3 * MBPS, latencyMs: 120 },
    probeOverrides: { deviceMemoryGB: 3, hardwareConcurrency: 4, effectiveConnectionType: "4g", downlinkMbps: 8, rttMs: 120, gpuTier: "none" },
    cameraPermission: "granted",
    disableWebgl: true,
    prefersReducedMotion: false,
    critical: true,
  },
];

/**
 * The XR pair, deliberately *not* part of `PROFILES`.
 *
 * Orbital's matrix is the six above and must stay the six above: adding two
 * profiles to it would change every existing baseline, every stored trace's
 * peer set, and the gate's pass/fail denominator, for an experience that has no
 * XR entry point to exercise. These two are opt-in — `atlas matrix --url` runs
 * them because a stranger's WebAR build is exactly what they are for, and
 * `--profiles xr-denied` names them explicitly.
 *
 * @type {Profile[]}
 */
export const XR_PROFILES = [
  {
    id: "xr-granted",
    label: "WebXR available / session granted",
    description:
      "Capable handset that has WebXR and says yes. Exercises the immersive path end to end: request, session start, reference space, the XR frame loop, and session end.",
    viewport: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
    cpuThrottleRate: 2,
    network: { offline: false, downloadThroughputBps: 14 * MBPS, uploadThroughputBps: 5 * MBPS, latencyMs: 70 },
    probeOverrides: { deviceMemoryGB: 6, hardwareConcurrency: 8, effectiveConnectionType: "4g", downlinkMbps: 14, rttMs: 70, gpuTier: "high" },
    cameraPermission: "granted",
    disableWebgl: false,
    prefersReducedMotion: false,
    // Not release-blocking. The stub is Atlas's model of a headset, not a
    // headset, so a red light here is evidence to go and look — not grounds to
    // hold a release on emulated XR.
    critical: false,
    xr: "granted",
  },
  {
    id: "xr-denied",
    label: "WebXR available / session refused",
    description:
      "The same capable handset, refusing the session with a real NotAllowedError. This is the one most apps get wrong: WebXR exists, so the AR button appears, and then the rejection is never handled and the page is left dead behind a spinner.",
    viewport: { width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
    cpuThrottleRate: 2,
    network: { offline: false, downloadThroughputBps: 14 * MBPS, uploadThroughputBps: 5 * MBPS, latencyMs: 70 },
    probeOverrides: { deviceMemoryGB: 6, hardwareConcurrency: 8, effectiveConnectionType: "4g", downlinkMbps: 14, rttMs: 70, gpuTier: "high" },
    cameraPermission: "granted",
    disableWebgl: false,
    prefersReducedMotion: false,
    // Critical, unlike its twin, and the asymmetry is the point. A refusal is
    // an ordinary browser response that needs no stub fidelity to be real: the
    // promise rejects, and either the app recovers to something usable or it
    // does not. That is a claim emulation can support, so it can block.
    critical: true,
    xr: "denied",
  },
];

/** Every profile `profileById` can resolve. Order: core first, then XR. */
export const ALL_PROFILES = [...PROFILES, ...XR_PROFILES];

/** The default matrix for a `--url` run: everything. */
export const GENERIC_PROFILES = ALL_PROFILES;

/** @param {string} id */
export function profileById(id) {
  const p = ALL_PROFILES.find((x) => x.id === id);
  if (!p) throw new Error(`unknown profile "${id}". Known: ${ALL_PROFILES.map((x) => x.id).join(", ")}`);
  return p;
}

/**
 * Applies a profile to an attached page session. Order matters: emulation
 * before navigation, and the injected script before anything the page runs.
 *
 * `extraScripts` are registered after `injectedScript`, in the order given, and
 * that order is load-bearing rather than incidental. Chromium replays
 * `addScriptToEvaluateOnNewDocument` sources in registration order, so the
 * bootstrap (which installs `__atlasConfig` and the deterministic RNG) has to
 * land before the XR stub (which seeds its head path from it), which has to
 * land before the generic probe (which reads `navigator.xr` at install time to
 * decide whether XR is present at all). Shuffle these and the probe reports a
 * page with no WebXR on the very profile that exists to provide it.
 *
 * @param {import("./cdp.js").CdpSession} session
 * @param {Profile} profile
 * @param {{ origin: string; injectedScript: string; extraScripts?: string[] }} opts
 */
export async function applyProfile(session, profile, opts) {
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Network.enable");
  await session.send("Performance.enable", { timeDomain: "timeTicks" });
  await session.send("Log.enable").catch(() => {});

  await session.send("Emulation.setDeviceMetricsOverride", {
    width: profile.viewport.width,
    height: profile.viewport.height,
    deviceScaleFactor: profile.viewport.deviceScaleFactor,
    mobile: profile.viewport.mobile,
  });
  await session.send("Emulation.setTouchEmulationEnabled", {
    enabled: profile.viewport.mobile,
    maxTouchPoints: profile.viewport.mobile ? 5 : 0,
  }).catch(() => {});

  if (profile.cpuThrottleRate > 1) {
    await session.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuThrottleRate });
  }

  if (profile.network) {
    /** @type {Record<string, unknown>} */
    const conditions = {
      offline: profile.network.offline,
      latency: profile.network.latencyMs,
      downloadThroughput: profile.network.downloadThroughputBps,
      uploadThroughput: profile.network.uploadThroughputBps,
    };
    if (profile.network.packetLoss !== undefined) conditions.packetLoss = profile.network.packetLoss;
    if (profile.network.packetQueueLength !== undefined) conditions.packetQueueLength = profile.network.packetQueueLength;
    try {
      await session.send("Network.emulateNetworkConditions", conditions);
    } catch (e) {
      // packetLoss/packetQueueLength are newer additions; retry without them
      // rather than losing the throughput shaping entirely.
      delete conditions.packetLoss;
      delete conditions.packetQueueLength;
      await session.send("Network.emulateNetworkConditions", conditions);
    }
  }

  await session.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: profile.prefersReducedMotion ? "reduce" : "no-preference" },
      { name: "prefers-color-scheme", value: "dark" },
    ],
  });

  // Permission state is a browser-context concern, not a page one.
  if (profile.cameraPermission === "denied") {
    await session.sendBrowser("Browser.setPermission", {
      origin: opts.origin,
      permission: { name: "videoCapture" },
      setting: "denied",
      browserContextId: session.browserContextId,
    }).catch(() => {});
  } else {
    await session.sendBrowser("Browser.grantPermissions", {
      origin: opts.origin,
      permissions: ["videoCapture"],
      browserContextId: session.browserContextId,
    }).catch(() => {});
  }

  await session.send("Page.addScriptToEvaluateOnNewDocument", { source: opts.injectedScript });
  for (const source of opts.extraScripts ?? []) {
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }
}
