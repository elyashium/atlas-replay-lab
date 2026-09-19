/**
 * Zero-dependency manifest validator.
 *
 * Deliberately hand-written rather than schema-library driven: the interesting
 * checks here are cross-field invariants (does the tier ladder actually
 * monotonically decrease cost? is every checkpoint state reachable through the
 * declared transition graph? does the static-safe path still satisfy the
 * business invariant?) which a JSON-Schema validator cannot express anyway.
 *
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 * @typedef {import("../../types/atlas.js").ValidationIssue} ValidationIssue
 * @typedef {import("../../types/atlas.js").ValidationResult} ValidationResult
 * @typedef {import("../../types/atlas.js").ExperienceState} ExperienceState
 */

import { sha256 } from "../util/hash.js";

const TIER_ORDER = ["high", "mid", "low"];
const KNOWN_REQUIREMENTS = new Set(["webgl1", "webgl2", "webgpu", "webcodecs", "camera", "motion"]);

/**
 * @param {unknown} input
 * @returns {ValidationResult}
 */
export function validateManifest(input) {
  /** @type {ValidationIssue[]} */
  const issues = [];
  /** @param {string} path @param {string} message */
  const err = (path, message) => issues.push({ path, message, severity: "error" });
  /** @param {string} path @param {string} message */
  const warn = (path, message) => issues.push({ path, message, severity: "warning" });

  if (!input || typeof input !== "object") {
    return { ok: false, issues: [{ path: "$", message: "manifest must be an object", severity: "error" }] };
  }
  const m = /** @type {ExperienceManifest} */ (input);

  if (m.schemaVersion !== 1) err("$.schemaVersion", "expected schemaVersion 1");
  if (!m.id || typeof m.id !== "string") err("$.id", "id is required");
  if (!/^\d+\.\d+\.\d+$/.test(String(m.version))) err("$.version", "version must be semver x.y.z");

  // ── content hash ───────────────────────────────────────────────────────────
  if (typeof m.contentHash !== "string" || m.contentHash.length < 8) {
    err("$.contentHash", "contentHash missing; run hashManifest()");
  } else {
    const { contentHash, ...rest } = m;
    const expected = sha256(rest, contentHash.length);
    if (expected !== contentHash) {
      err("$.contentHash", `contentHash ${contentHash} does not match content (${expected})`);
    }
  }

  // ── budgets ────────────────────────────────────────────────────────────────
  const b = m.budgets;
  if (!b) err("$.budgets", "budgets are required");
  else {
    for (const key of /** @type {const} */ ([
      "firstFrameMs", "timeToInteractiveMs", "p95InteractionMs",
      "maxDroppedFrameRatio", "maxTransferBytes", "maxJsHeapMB",
    ])) {
      if (typeof b[key] !== "number" || !(b[key] > 0)) err(`$.budgets.${key}`, "must be a positive number");
    }
    if (b.firstFrameMs >= b.timeToInteractiveMs) {
      err("$.budgets", "firstFrameMs must be strictly less than timeToInteractiveMs");
    }
    if (b.maxDroppedFrameRatio > 1) err("$.budgets.maxDroppedFrameRatio", "must be <= 1");
  }

  // ── invariants ─────────────────────────────────────────────────────────────
  const inv = m.invariants;
  if (!inv?.visual || !inv?.interaction || !inv?.business) {
    err("$.invariants", "visual, interaction and business invariants are all required");
  } else {
    if (inv.visual.forbidBlankFirstFrame !== true) {
      err("$.invariants.visual.forbidBlankFirstFrame", "must be true; a blank first frame is never acceptable");
    }
    if (!(inv.visual.minFocalCoverage > 0 && inv.visual.minFocalCoverage < 1)) {
      err("$.invariants.visual.minFocalCoverage", "must be in (0,1)");
    }
    if (inv.interaction.p95TapResponseMs !== m.budgets?.p95InteractionMs) {
      warn(
        "$.invariants.interaction.p95TapResponseMs",
        `interaction invariant (${inv.interaction.p95TapResponseMs}ms) and budget ` +
          `(${m.budgets?.p95InteractionMs}ms) disagree; the gate will use the stricter of the two`,
      );
    }
    // Business invariant must be reachable through the declared transitions.
    const reachable = reachableStates(inv.interaction.allowedTransitions, "boot");
    if (!reachable.has(inv.business.endState)) {
      err("$.invariants.business.endState", `${inv.business.endState} is unreachable from "boot" via allowedTransitions`);
    }
    const path = shortestPath(inv.interaction.allowedTransitions, "interactive", inv.business.endState);
    if (path && path.length - 1 > inv.business.maxStepsToEndState) {
      err(
        "$.invariants.business.maxStepsToEndState",
        `shortest interactive -> ${inv.business.endState} path is ${path.length - 1} steps, ` +
          `exceeding maxStepsToEndState=${inv.business.maxStepsToEndState}`,
      );
    }
  }

  // ── tiers ──────────────────────────────────────────────────────────────────
  if (!Array.isArray(m.tiers) || m.tiers.length !== 3) {
    err("$.tiers", "exactly three quality tiers are required (high, mid, low)");
  } else {
    const ids = m.tiers.map((t) => t.id);
    for (const want of TIER_ORDER) {
      if (!ids.includes(/** @type {any} */ (want))) err("$.tiers", `missing tier "${want}"`);
    }
    // The ladder must be monotonically cheaper as it descends.
    const ordered = TIER_ORDER.map((id) => m.tiers.find((t) => t.id === id)).filter(Boolean);
    for (let i = 1; i < ordered.length; i++) {
      const prev = /** @type {any} */ (ordered[i - 1]).params;
      const cur = /** @type {any} */ (ordered[i]).params;
      if (cur.particleCount >= prev.particleCount) {
        err(`$.tiers[${i}].params.particleCount`, "quality ladder must strictly decrease particleCount");
      }
      if (cur.textureSize > prev.textureSize) {
        err(`$.tiers[${i}].params.textureSize`, "quality ladder must not increase textureSize");
      }
      if (cur.perFrameWorkMs >= prev.perFrameWorkMs) {
        err(`$.tiers[${i}].params.perFrameWorkMs`, "quality ladder must strictly decrease per-frame work");
      }
    }
    m.tiers.forEach((t, i) => {
      if (!Array.isArray(t.assets) || t.assets.length === 0) {
        err(`$.tiers[${i}].assets`, "each tier needs at least one asset");
      }
      for (const r of t.requires ?? []) {
        if (!KNOWN_REQUIREMENTS.has(r)) err(`$.tiers[${i}].requires`, `unknown requirement "${r}"`);
      }
      const total = (t.assets ?? []).reduce((s, a) => s + (a.approxBytes || 0), 0);
      if (m.budgets && total > m.budgets.maxTransferBytes) {
        err(`$.tiers[${i}].assets`, `tier "${t.id}" declares ${total}B, over maxTransferBytes ${m.budgets.maxTransferBytes}B`);
      }
    });
    // The lowest tier must be servable with no optional capability at all.
    const low = m.tiers.find((t) => t.id === "low");
    if (low && (low.requires ?? []).length > 0) {
      err("$.tiers[low].requires", 'the "low" tier must require nothing, so it is always servable');
    }
  }

  // ── fallback paths ─────────────────────────────────────────────────────────
  if (!Array.isArray(m.fallbackPaths) || m.fallbackPaths.length < 3) {
    err("$.fallbackPaths", "camera-xr, interactive-2d and static-safe paths are all required");
  } else {
    const prios = m.fallbackPaths.map((p) => p.priority);
    if (new Set(prios).size !== prios.length) err("$.fallbackPaths", "priorities must be unique");
    const terminal = [...m.fallbackPaths].sort((a, b) => b.priority - a.priority)[0];
    if (terminal && (terminal.requires ?? []).length > 0) {
      err("$.fallbackPaths", `lowest-priority path "${terminal.id}" must have no requirements`);
    }
    for (const p of m.fallbackPaths) {
      for (const r of p.requires ?? []) {
        if (!KNOWN_REQUIREMENTS.has(r)) err(`$.fallbackPaths[${p.id}].requires`, `unknown requirement "${r}"`);
      }
    }
  }

  // ── checkpoints ────────────────────────────────────────────────────────────
  if (!Array.isArray(m.checkpoints) || m.checkpoints.length === 0) {
    err("$.checkpoints", "at least one checkpoint is required");
  } else if (inv?.interaction?.allowedTransitions) {
    const reachable = reachableStates(inv.interaction.allowedTransitions, "boot");
    for (const cp of m.checkpoints) {
      if (!reachable.has(cp.onState)) {
        err(`$.checkpoints[${cp.id}]`, `checkpoint state "${cp.onState}" is unreachable`);
      }
    }
    if (!m.checkpoints.some((cp) => cp.onState === "first-frame")) {
      err("$.checkpoints", "a first-frame checkpoint is required to prove the no-blank-first-frame invariant");
    }
    if (inv.business && !m.checkpoints.some((cp) => cp.onState === inv.business.endState)) {
      err("$.checkpoints", `a checkpoint on the business end state "${inv.business.endState}" is required`);
    }
  }

  // ── privacy ────────────────────────────────────────────────────────────────
  const p = m.privacy;
  if (!p) err("$.privacy", "a privacy rule is required");
  else {
    const never = (p.neverCollect ?? []).join(" ").toLowerCase();
    for (const required of ["raw camera", "raw audio"]) {
      if (!never.includes(required)) err("$.privacy.neverCollect", `must explicitly forbid "${required}"`);
    }
    for (const c of p.collect ?? []) {
      for (const n of p.neverCollect ?? []) {
        if (c.toLowerCase() === n.toLowerCase()) {
          err("$.privacy", `"${c}" appears in both collect and neverCollect`);
        }
      }
    }
    if (!(p.retentionDays > 0 && p.retentionDays <= 90)) {
      err("$.privacy.retentionDays", "retention must be >0 and <=90 days for this project");
    }
    if (p.thirdPartyTraceEgress !== "off-by-default") {
      warn(
        "$.privacy.thirdPartyTraceEgress",
        "third-party trace egress is not off-by-default; the Jev engine would send trace JSON off-box",
      );
    }
  }

  return { ok: !issues.some((i) => i.severity === "error"), issues };
}

/**
 * @param {Array<[ExperienceState, ExperienceState]>} transitions
 * @param {ExperienceState} from
 * @returns {Set<ExperienceState>}
 */
export function reachableStates(transitions, from) {
  /** @type {Set<ExperienceState>} */
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const cur = /** @type {ExperienceState} */ (queue.shift());
    for (const [a, b] of transitions) {
      if (a === cur && !seen.has(b)) {
        seen.add(b);
        queue.push(b);
      }
    }
  }
  return seen;
}

/**
 * @param {Array<[ExperienceState, ExperienceState]>} transitions
 * @param {ExperienceState} from
 * @param {ExperienceState} to
 * @returns {ExperienceState[] | null}
 */
export function shortestPath(transitions, from, to) {
  /** @type {Map<ExperienceState, ExperienceState | null>} */
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = /** @type {ExperienceState} */ (queue.shift());
    if (cur === to) break;
    for (const [a, b] of transitions) {
      if (a === cur && !prev.has(b)) {
        prev.set(b, cur);
        queue.push(b);
      }
    }
  }
  if (!prev.has(to)) return null;
  /** @type {ExperienceState[]} */
  const path = [];
  /** @type {ExperienceState | null | undefined} */
  let cur = to;
  while (cur) {
    path.unshift(cur);
    cur = prev.get(cur) ?? null;
  }
  return path;
}

/**
 * Validates an observed state sequence against the manifest's transition graph.
 *
 * @param {ExperienceState[]} states
 * @param {ExperienceManifest} manifest
 * @returns {{ ok: boolean; firstIllegal: { index: number; from: ExperienceState; to: ExperienceState } | null }}
 */
export function validateStateOrdering(states, manifest) {
  const allowed = new Set(
    manifest.invariants.interaction.allowedTransitions.map(([a, b]) => `${a}>${b}`),
  );
  for (let i = 1; i < states.length; i++) {
    const from = states[i - 1];
    const to = states[i];
    if (from === to) continue;
    if (!allowed.has(`${from}>${to}`)) {
      return { ok: false, firstIllegal: { index: i, from, to } };
    }
  }
  return { ok: true, firstIllegal: null };
}
