/**
 * Which manifest a trace was captured against.
 *
 * Judging every trace against Orbital's manifest was defensible while Orbital
 * was the only thing Atlas could run. It stopped being defensible the moment
 * `--url` existed: Orbital's invariants name `checkout-complete` as the end
 * state and a stranger's app has no checkout, so every generic trace would be
 * scored against a business invariant it could not possibly satisfy.
 *
 * Selection is by recorded id, never by a flag, because the trace already
 * knows what it was captured against and a flag could contradict it. Unknown
 * ids fall back to Orbital (the conservative choice: its invariants are the
 * strictest in the repo) and say so via `matched: false`.
 *
 * Shared by the judge and the gate — two components scoring against different
 * manifests for the same trace would be a disagreement nobody authored.
 */

import { orbitalManifest } from "./atlas-orbital.manifest.js";
import { genericManifest } from "./generic.manifest.js";

/** @type {Record<string, import("../../types/atlas.js").ExperienceManifest>} */
const MANIFESTS = {
  [orbitalManifest.id]: orbitalManifest,
  [genericManifest.id]: genericManifest,
};

/**
 * @param {import("../../types/atlas.js").Trace} trace
 * @returns {{ manifest: import("../../types/atlas.js").ExperienceManifest; matched: boolean; hashMatches: boolean }}
 */
export function manifestFor(trace) {
  const { manifest, matched } = manifestById(trace.resource?.["atlas.manifest.id"]);
  return {
    manifest,
    matched,
    // A trace captured before a manifest edit carries the old hash. The verdict
    // is still computable — the invariants it is judged against are simply not
    // byte-identical to the ones it ran under, and saying so is cheaper than
    // pretending otherwise or refusing to judge.
    hashMatches: trace.resource?.["atlas.manifest.hash"] === manifest.contentHash,
  };
}

/**
 * Manifest lookup by recorded id, for components that read a report rather
 * than a trace (the gate grades matrix rows). Unknown or missing ids fall
 * back to Orbital — the conservative choice: its invariants are the strictest
 * in the repo — and say so via `matched: false`.
 *
 * @param {string | null | undefined} id
 */
export function manifestById(id) {
  const manifest = (id && MANIFESTS[id]) || orbitalManifest;
  return { manifest, matched: Boolean(id && MANIFESTS[id]) };
}
