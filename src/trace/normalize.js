/**
 * Trace normalisation — what "deterministic replay" is actually measured
 * against.
 *
 * A raw trace contains things that legitimately differ between two runs of
 * the same session: wall-clock start, a random trace id, sub-quantum timing
 * jitter, byte counts that move by a header or two, heap readings. Hashing a
 * raw trace would produce a determinism check that is always red, which is
 * the same as having no check.
 *
 * So normalisation keeps exactly the things a replay is *supposed* to
 * reproduce — the ordered causal structure of the session — and drops the
 * things it is not:
 *
 *   KEPT    state sequence, ordered event names and kinds, quantised offsets,
 *           interaction classes, served tier/path, decision tier, checkpoint
 *           states and order, manifest hash.
 *   DROPPED wall clocks, trace ids, screenshot paths, absolute byte counts,
 *           heap readings, measured latency values, engine confidences.
 *
 * `determinismHash` is a hash of the kept set. Two runs agreeing on it means
 * the session unfolded the same way; it deliberately does not mean the two
 * runs were equally fast. Speed is compared with the metrics, and pixels are
 * compared with the image diff.
 *
 * @typedef {import("../../types/atlas.js").Trace} Trace
 */

import { sha256 } from "../util/hash.js";
import { TIME_QUANTUM_MS } from "./schema.js";

/**
 * Attributes that survive normalisation, per event kind. Anything not listed
 * is dropped — an allow-list rather than a deny-list, so a new attribute
 * cannot silently start breaking the determinism check.
 *
 * @type {Record<string, string[]>}
 */
const KEPT_ATTRIBUTES = {
  lifecycle: ["state", "tier", "path", "reason", "nonBlank"],
  asset: ["assetId", "kind", "ok", "critical"],
  state: ["from", "to"],
  interaction: ["inputClass", "target", "index"],
  frame: [],
  decision: ["engine", "tier", "path", "guardOverridden"],
  error: ["code", "fatal"],
};

/**
 * @param {Trace} trace
 * @returns {{
 *   manifestHash: string;
 *   profileId: string;
 *   servedTier: string | null;
 *   servedPath: string | null;
 *   decisionTier: string | null;
 *   states: string[];
 *   events: Array<{ t: number; name: string; kind: string; attributes: Record<string, unknown> }>;
 *   checkpoints: Array<{ id: string; state: string; t: number }>;
 *   inputClasses: string[];
 * }}
 */
export function normalizeTrace(trace) {
  return {
    manifestHash: trace.resource["atlas.manifest.hash"],
    profileId: trace.resource["atlas.profile.id"],
    servedTier: trace.servedTier,
    servedPath: trace.servedPath,
    decisionTier: trace.decision?.tier ?? null,
    states: [...trace.states],
    events: trace.events
      // Frame events are aggregate counters sampled on a timer; their exact
      // count is a performance fact, not a causal one.
      .filter((e) => e.kind !== "frame")
      .map((e) => ({
        t: quantise(e.tOffsetMs),
        name: e.name,
        kind: e.kind,
        attributes: pick(e.attributes, KEPT_ATTRIBUTES[e.kind] ?? []),
      })),
    checkpoints: trace.checkpoints.map((c) => ({
      id: c.id,
      state: c.state,
      t: quantise(c.tOffsetMs),
    })),
    inputClasses: [...trace.inputClasses],
  };
}

/**
 * The structural hash. Set on every trace before it is written to disk.
 * @param {Trace} trace
 * @returns {string}
 */
export function determinismHash(trace) {
  return sha256(normalizeTrace(trace), 32);
}

/**
 * A stricter variant that ignores timing entirely, used to distinguish
 * "replayed identically" from "replayed identically but at a different
 * speed" — the latter is expected when the replay runs unthrottled.
 *
 * @param {Trace} trace
 * @returns {string}
 */
export function causalHash(trace) {
  const n = normalizeTrace(trace);
  return sha256(
    {
      ...n,
      events: n.events.map(({ t, ...rest }) => rest),
      checkpoints: n.checkpoints.map(({ t, ...rest }) => rest),
    },
    32,
  );
}

/**
 * Explains the first structural divergence between two traces, for the replay
 * report. Returns null when the causal structures match.
 *
 * @param {Trace} a
 * @param {Trace} b
 * @returns {{ kind: "states" | "events" | "checkpoints"; index: number; a: unknown; b: unknown; message: string } | null}
 */
export function firstDivergence(a, b) {
  const na = normalizeTrace(a);
  const nb = normalizeTrace(b);

  for (let i = 0; i < Math.max(na.states.length, nb.states.length); i++) {
    if (na.states[i] !== nb.states[i]) {
      return {
        kind: "states",
        index: i,
        a: na.states[i] ?? null,
        b: nb.states[i] ?? null,
        message: `state[${i}] diverged: ${na.states[i] ?? "<end>"} vs ${nb.states[i] ?? "<end>"}`,
      };
    }
  }
  for (let i = 0; i < Math.max(na.events.length, nb.events.length); i++) {
    const ea = na.events[i];
    const eb = nb.events[i];
    const ka = ea ? `${ea.name}|${ea.kind}|${JSON.stringify(ea.attributes)}` : "<end>";
    const kb = eb ? `${eb.name}|${eb.kind}|${JSON.stringify(eb.attributes)}` : "<end>";
    if (ka !== kb) {
      return {
        kind: "events",
        index: i,
        a: ea ?? null,
        b: eb ?? null,
        message: `event[${i}] diverged: ${ka} vs ${kb}`,
      };
    }
  }
  for (let i = 0; i < Math.max(na.checkpoints.length, nb.checkpoints.length); i++) {
    const ca = na.checkpoints[i];
    const cb = nb.checkpoints[i];
    if (JSON.stringify(ca) !== JSON.stringify(cb)) {
      return {
        kind: "checkpoints",
        index: i,
        a: ca ?? null,
        b: cb ?? null,
        message: `checkpoint[${i}] diverged`,
      };
    }
  }
  return null;
}

/** @param {number} ms */
function quantise(ms) {
  return Math.round(ms / TIME_QUANTUM_MS) * TIME_QUANTUM_MS;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} keys
 * @returns {Record<string, unknown>}
 */
function pick(obj, keys) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of keys) {
    if (obj && k in obj && obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}
