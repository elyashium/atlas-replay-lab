/**
 * Evidence provenance: what actually produced a number, stamped onto it.
 *
 * `docs/handoffs/phase-4.md` asks the device lane to "claim only what was
 * exercised". Today every result in this repository comes from one lane —
 * Chromium emulation on a developer machine — and the honesty about that lives
 * in prose: a paragraph in `src/runner/profiles.js`, a sentence in the README, a
 * `emulationDisclaimer` string in the matrix report.
 *
 * Prose does not survive a copy-paste. A number lifted from a report into a
 * slide loses its paragraph, and the slide then says "tested on mid-range
 * Android". This module makes the lane a field on the datum rather than a
 * caveat near it, and gives the codebase one function that refuses to produce a
 * device claim from an emulated measurement.
 *
 * ## The three lanes, and what each licenses
 *
 * | lane | what it is | what may be claimed |
 * | --- | --- | --- |
 * | `emulation` | Chromium CPU throttling and network shaping with injected hardware hints | ordering, ratios, whether a budget is plausibly met, whether the degrade ladder fires |
 * | `synthetic-xr` | emulation *plus* Atlas's own `navigator.xr` (`src/runner/xr-stub.js`) | the app's session request, refusal path, reference-space setup and frame loop execute |
 * | `device` | a physical handset | thermal behaviour, real GPU drivers, tracking quality, pose latency, actual handset performance |
 *
 * **No run in this repository has ever been in the `device` lane.** The lane
 * exists as a value so that the day one does, nothing else has to change, and so
 * that `assertDeviceClaim` has something true to check rather than being a
 * comment saying "don't".
 *
 * ## What "real" means inside the emulation lane
 *
 * Not everything about an emulated profile is fake, and flattening it to
 * "simulated" would be its own dishonesty — it would imply the CPU throttling is
 * a pretend number when the browser genuinely executes that much slower.
 * `PROFILE_FIDELITY` separates the two: `applied` for controls the browser
 * really enforces, `injected` for values handed to the page so its capability
 * probe sees a plausible device. A reader can then tell which half of a profile
 * they are relying on.
 */

/** @type {readonly ["emulation", "synthetic-xr", "device"]} */
export const LANES = Object.freeze(["emulation", "synthetic-xr", "device"]);

export const PROVENANCE_VERSION = 1;

/**
 * Which parts of a profile the browser enforces and which are hints.
 *
 * Kept next to the lane because the pair answers the question a sceptical
 * reader actually asks: not "is this emulated" but "which bit of it is real".
 */
export const PROFILE_FIDELITY = Object.freeze({
  applied: Object.freeze([
    "cpuThrottleRate — Chromium genuinely executes this much slower (CDP Emulation.setCPUThrottlingRate)",
    "network throughput and latency — Chromium genuinely shapes the connection (CDP Network.emulateNetworkConditions)",
    "viewport and deviceScaleFactor — the page really lays out at this size",
    "cameraPermission — the permission is really granted or denied",
    "disableWebgl — the context is really unavailable when disabled",
    "prefersReducedMotion — the media query really matches",
  ]),
  injected: Object.freeze([
    "deviceMemory — a value handed to the page, not a memory limit",
    "hardwareConcurrency — a value handed to the page; the real core count is the host's",
    "navigator.connection — a value handed to the page, independent of the shaping above",
    "gpuTier — a value handed to the page; the real GPU is the host's",
  ]),
  absent: Object.freeze([
    "thermal throttling — no host-side model exists; a real handset slows down over minutes and this does not",
    "real GPU drivers and their bugs — the host GPU is not the handset GPU",
    "memory pressure and OS-level eviction",
    "real radio behaviour — handover, congestion, packet loss patterns beyond the shaped profile",
    "battery state and its effect on clocks",
  ]),
});

/**
 * What a lane does and does not license, in one place, phrased so it can be
 * pasted into a report without further editing.
 */
export const LANE_CLAIMS = Object.freeze({
  emulation: Object.freeze({
    lane: "emulation",
    surface: "Chromium on a developer or CI host",
    supports:
      "relative ordering between profiles, whether the degrade ladder fires, whether a budget is " +
      "plausibly met under shaped CPU and network, and whether the app's own logic is correct.",
    doesNotSupport:
      "any statement about a physical handset: thermal behaviour, real GPU drivers, actual frame " +
      "rates on device, or how the app performs in a user's hand.",
  }),
  "synthetic-xr": Object.freeze({
    lane: "synthetic-xr",
    surface: "Chromium plus Atlas's synthetic navigator.xr (src/runner/xr-stub.js)",
    supports:
      "that the app requests a session, handles refusal, sets up a reference space and runs its " +
      "frame loop — all of that code really executes.",
    doesNotSupport:
      "tracking quality, pose latency, plane detection, lighting estimation, or anything about how " +
      "the experience feels on a real AR handset. A scripted pose is a scripted pose.",
  }),
  device: Object.freeze({
    lane: "device",
    surface: "a physical handset",
    supports: "device-specific behaviour, within the limits of the specific units and OS versions exercised.",
    doesNotSupport:
      "generalisation to devices not in the matrix. A result on three handsets is a result on three handsets.",
  }),
});

/**
 * @typedef {object} Provenance
 * @property {number} provenanceVersion
 * @property {"emulation" | "synthetic-xr" | "device"} lane
 * @property {string} surface
 * @property {string} supports
 * @property {string} doesNotSupport
 * @property {boolean} physicalDevice   always false outside the device lane
 * @property {{ applied: readonly string[]; injected: readonly string[]; absent: readonly string[] } | null} fidelity
 * @property {string | null} deviceModel
 */

/**
 * Stamp a result with its lane.
 *
 * The lane is derived from the profile rather than passed in, because a caller
 * that can choose its own lane can choose the flattering one. A profile whose id
 * starts `xr-` is synthetic-xr; everything else emulation. The `device` lane is
 * reachable only by passing an explicit `deviceModel`, and passing one is the
 * thing a human has to do deliberately.
 *
 * @param {{ id?: string } | string | null | undefined} profile
 * @param {{ deviceModel?: string | null }} [opts]
 * @returns {Provenance}
 */
export function provenanceFor(profile, opts = {}) {
  const id = typeof profile === "string" ? profile : profile?.id ?? "";
  const deviceModel = opts.deviceModel ?? null;

  const lane = deviceModel ? "device" : id.startsWith("xr-") ? "synthetic-xr" : "emulation";
  const claims = LANE_CLAIMS[lane];

  return {
    provenanceVersion: PROVENANCE_VERSION,
    lane,
    surface: claims.surface,
    supports: claims.supports,
    doesNotSupport: claims.doesNotSupport,
    physicalDevice: lane === "device",
    fidelity: lane === "device" ? null : PROFILE_FIDELITY,
    deviceModel,
  };
}

/**
 * Refuse to let an emulated result be described as a device result.
 *
 * Throws rather than returning a verdict, unlike most of this codebase. The
 * difference is deliberate: a destination check returns a verdict because a
 * refusal is an expected outcome that belongs in a report, whereas reaching this
 * function with emulated evidence means a caller is about to publish a false
 * statement. There is no correct way to record that and continue.
 *
 * @param {Provenance | Provenance[] | null | undefined} provenance
 * @param {string} claim  what is about to be asserted, for the error message
 */
export function assertDeviceClaim(provenance, claim) {
  const list = Array.isArray(provenance) ? provenance : provenance ? [provenance] : [];
  if (!list.length) {
    throw new Error(
      `refusing to make the device claim "${claim}": no provenance was recorded, and an ` +
        "unprovenanced measurement cannot support any claim about physical hardware.",
    );
  }
  const emulated = list.filter((p) => !p?.physicalDevice);
  if (emulated.length) {
    const lanes = [...new Set(emulated.map((p) => p?.lane ?? "unknown"))].join(", ");
    throw new Error(
      `refusing to make the device claim "${claim}": ${emulated.length} of ${list.length} ` +
        `measurement(s) are in the ${lanes} lane. ${LANE_CLAIMS.emulation.doesNotSupport} ` +
        "Phase 4's device lane is not implemented; no run in this repository has used physical hardware.",
    );
  }
  return true;
}

/**
 * One sentence for a report header, naming every lane that contributed.
 *
 * Deliberately blunt about the mixed case: a report drawing on both emulation
 * and device evidence is the easiest one to misread, because the device rows
 * lend their credibility to the emulated ones.
 *
 * @param {Provenance[]} provenances
 */
export function provenanceSummary(provenances) {
  const lanes = [...new Set(provenances.map((p) => p?.lane).filter(Boolean))];
  if (!lanes.length) return "No provenance was recorded for these results.";
  if (lanes.length === 1) {
    const claims = LANE_CLAIMS[/** @type {keyof typeof LANE_CLAIMS} */ (lanes[0])];
    return `All results in this report are ${lanes[0]} (${claims.surface}). ${claims.doesNotSupport}`;
  }
  return (
    `This report mixes ${lanes.join(" and ")} results. Each row carries its own lane; do not read a ` +
    "device row's credibility onto an emulated one, and do not aggregate across lanes into a single number."
  );
}
