/**
 * Deterministic diagnosis: turn a failed run into a finding a developer can act
 * on, without inventing a cause.
 *
 * `docs/handoffs/phase-5.md` item 1, verbatim: "attach the failing contract
 * step, profile, trace slice, console/network category (scrubbed), artifact, and
 * policy rule to a concise finding. Keep observations separate from inferred
 * causes and suggested changes."
 *
 * ## Why the separation is the whole design
 *
 * A report that says "the click handler is racing the asset load" reads as
 * knowledge and is a guess. A report that says "step 2 (`click`) failed at
 * 1480ms; `webgl-context-lost` was logged at 1440ms; the trace slice is
 * attached" reads as less and is true. The first shape is worse for the reader
 * *and* worse for whoever later grades whether Atlas was right, because there is
 * nothing to check the guess against.
 *
 * So a finding has three separate lists and they never merge:
 *
 * - `observations` — each one a fact with the artifact that proves it. If it
 *   cannot name an artifact and a field, it is not an observation.
 * - `inferredCauses` — each one carries `basis: "rule"` and the rule that fired,
 *   or it does not exist. An inference with no rule behind it is a guess wearing
 *   a fact's clothes, and this module has no way to produce one.
 * - `suggestedChanges` — **always empty.** Phase 5 item 2 (fix suggestions with
 *   named trade-offs, validated against controlled targets) is not implemented.
 *   The field exists so its emptiness is a recorded fact rather than a missing
 *   key a consumer might fill in from somewhere else.
 *
 * ## Determinism
 *
 * Same run row in, same finding out, byte for byte. No clock is read, no random
 * id is minted, event offsets stay quantised as they arrived from the trace, and
 * the rules fire in declaration order. A finding is therefore diffable across
 * two runs, which is what makes it usable in `atlas diff`'s company rather than
 * being a second, unreconcilable opinion.
 *
 * ## Privacy
 *
 * Everything here reads already-scrubbed fields. Console records arrive
 * code-plus-clipped-message from `src/trace/assemble.js`; only the `code` travels
 * into a finding's category, never the message text, because the message is the
 * one field in a trace that can carry a customer string. Selectors from a target
 * contract are echoed because the customer wrote them, values never are — the
 * driver already replaces typed input with `[redacted]`. No wall-clock, no input
 * coordinates, no URLs beyond what the destination policy already scrubbed.
 */

import { sha256 } from "../util/hash.js";
import { SEVERITY_LEVELS } from "../decision/questions.js";
import { comfortPolicy } from "../gate/comfort.js";

export const FINDING_SCHEMA_VERSION = 1;

/** How many events either side of the failure moment travel with a finding. */
export const TRACE_SLICE_RADIUS_MS = 750;
/** Hard cap on slice length, so one chatty run cannot produce a 10MB finding. */
export const TRACE_SLICE_MAX_EVENTS = 40;

/**
 * Console error codes grouped into categories a developer can route.
 *
 * Grouping is by *what a developer would go look at*, not by severity, because
 * severity is already decided by the gate. A code that matches nothing lands in
 * `uncategorised` and is reported as such — an unrecognised failure mode is
 * information, and quietly bucketing it as "other" would lose it.
 */
export const CONSOLE_CATEGORIES = Object.freeze({
  graphics: Object.freeze(["webgl-context-lost", "webgl-error", "shader-compile-failed", "texture-error"]),
  media: Object.freeze(["camera-denied", "camera-error", "media-error", "autoplay-blocked"]),
  xr: Object.freeze(["xr-session-failed", "xr-not-supported", "xr-reference-space-failed"]),
  network: Object.freeze(["fetch-failed", "asset-404", "asset-timeout", "cors-blocked", "mixed-content"]),
  script: Object.freeze(["type-error", "reference-error", "syntax-error", "unhandled-rejection", "uncaught"]),
  security: Object.freeze(["csp-violation", "permission-denied", "insecure-context"]),
});

/**
 * @param {string} code
 * @returns {string}
 */
export function consoleCategory(code) {
  for (const [category, codes] of Object.entries(CONSOLE_CATEGORIES)) {
    if (codes.includes(code)) return category;
  }
  return "uncategorised";
}

/**
 * The deterministic rules. Each one either fires with a named cause or says
 * nothing; none of them ever produces a maybe.
 *
 * A rule may only cite what is in the row it was handed. `when` returns a
 * `{ cause, why }` or null, and the `why` has to explain the *mechanism*, not
 * restate the observation — "the profile disables WebGL, so a context request
 * cannot succeed" is a mechanism; "WebGL failed because of a WebGL error" is not.
 *
 * Declaration order is output order, so this list is the only thing that decides
 * how two findings on one run are ranked.
 */
export const DIAGNOSIS_RULES = Object.freeze([
  Object.freeze({
    id: "harness-loss",
    when: (row) =>
      row.error
        ? {
            cause: "Atlas lost the browser or the target before a verdict could be formed.",
            why:
              "The row carries a harness error and no trace, so nothing was measured. This is a " +
              "statement about Atlas's run, not about the target application — the target may be " +
              "fine and the evidence is simply absent.",
            aboutTarget: false,
          }
        : null,
  }),
  Object.freeze({
    id: "profile-denied-capability",
    when: (row) => {
      // A profile that switches a capability off is a *known* cause, not an
      // inference: Atlas chose it. Saying so prevents the most common
      // misreading of the matrix, where a deliberately hostile profile is
      // reported as an application defect.
      const denials = {
        "webgl-unavailable": { capability: "WebGL", category: "graphics" },
        "camera-denied": { capability: "camera access", category: "media" },
        "xr-denied": { capability: "an immersive XR session", category: "xr" },
      };
      const denial = denials[row.profileId];
      if (!denial) return null;
      return {
        cause: `The ${row.profileId} profile withholds ${denial.capability} on purpose.`,
        why:
          `Atlas denied ${denial.capability} before the page loaded, so a failure to obtain it is ` +
          "expected. What this run grades is whether the app reached its declared fallback anyway. " +
          "Do not read this as the app being broken on a device where the capability exists.",
        aboutTarget: false,
      };
    },
  }),
  Object.freeze({
    id: "fallback-absent-under-denial",
    when: (row) => {
      const denied = ["webgl-unavailable", "camera-denied", "xr-denied"].includes(row.profileId);
      const failed = row.drive?.journeyOutcome === "fail" || row.verdict?.outcome?.value === "fail";
      if (!denied || !failed) return null;
      return {
        cause: "The declared fallback did not become reachable while a capability was withheld.",
        why:
          "The capability denial is Atlas's doing and expected; the fallback not appearing is not. " +
          "This is the failure this profile exists to find, and it is about the target.",
        aboutTarget: true,
      };
    },
  }),
  Object.freeze({
    id: "replay-did-not-reproduce",
    when: (row) =>
      row.replay && row.replay.reproduced === false
        ? {
            cause: "The run did not reproduce on replay.",
            why:
              "Either the target is non-deterministic across runs or the capture is incomplete. " +
              "Until it reproduces, every other finding on this row is about one unrepeated " +
              "execution and cannot be attributed with confidence.",
            aboutTarget: null,
          }
        : null,
  }),
]);

/**
 * @typedef {object} Observation
 * @property {string} what      the fact, one sentence, no hedging and no cause
 * @property {string} source    the field or artifact the fact was read from
 * @property {string | null} artifact  a repo-relative path a reader can open
 */

/**
 * @typedef {object} Finding
 * @property {"atlas.finding"} kind
 * @property {number} schemaVersion
 * @property {string} id                 stable hash of the finding's identity
 * @property {string} title
 * @property {string} severity           one of SEVERITY_LEVELS, from the gate
 * @property {string} profileId
 * @property {string | null} lane        emulation / synthetic-xr / device
 * @property {Observation[]} observations
 * @property {{ id: string; cause: string; why: string; basis: "rule"; aboutTarget: boolean | null }[]} inferredCauses
 * @property {never[]} suggestedChanges
 * @property {object} evidence
 * @property {object} $limitations
 */

/**
 * Build a finding for one matrix run row.
 *
 * Returns `null` for a row that passed — a diagnosis of a healthy run is noise,
 * and a consumer counting findings should be counting problems.
 *
 * @param {any} row   a MatrixRunRow
 * @param {{
 *   manifest?: any;
 *   contract?: any;
 *   trace?: any;
 *   policyStamp?: { id: string; version: string; contentHash: string } | null;
 *   rule?: { id: string; statement: string } | null;
 * }} [context]
 * @returns {Finding | null}
 */
export function findingForRun(row, context = {}) {
  if (!row || typeof row !== "object") return null;

  const failed = Boolean(
    row.error ||
      row.verdict?.outcome?.value === "fail" ||
      row.verdict?.outcome?.value === "inconclusive" ||
      row.drive?.journeyOutcome === "fail" ||
      (row.replay && row.replay.reproduced === false),
  );
  if (!failed) return null;

  const trace = context.trace ?? null;
  const step = failingContractStep(row, context.contract);
  const failureAtMs = failureMoment(row, step, trace);

  const observations = collectObservations(row, { step, trace, failureAtMs, manifest: context.manifest });
  const inferredCauses = DIAGNOSIS_RULES.flatMap((rule) => {
    const hit = rule.when(row);
    return hit ? [{ id: rule.id, basis: /** @type {const} */ ("rule"), ...hit }] : [];
  });

  const title = titleFor(row, step);
  const severity = severityFor(row);

  return {
    kind: "atlas.finding",
    schemaVersion: FINDING_SCHEMA_VERSION,
    // Identity, not novelty: two runs that fail the same way on the same
    // profile produce the same id, so a consumer can tell a recurrence from a
    // new problem without a database.
    id: sha256({ profileId: row.profileId, title, severity, causes: inferredCauses.map((c) => c.id) }, 12),
    title,
    severity,
    profileId: row.profileId ?? "unknown",
    lane: row.provenance?.lane ?? null,
    observations,
    inferredCauses,
    // Phase 5 item 2 is not implemented. Empty on purpose; see the module header.
    suggestedChanges: [],
    evidence: {
      runId: row.runId ?? null,
      runKind: row.runKind ?? null,
      contractStep: step,
      traceSlice: traceSlice(trace, failureAtMs),
      traceSliceWindow: failureAtMs === null ? null : { centreMs: failureAtMs, radiusMs: TRACE_SLICE_RADIUS_MS },
      consoleCategories: consoleCategories(trace ?? row),
      networkCategories: networkCategories(trace),
      hashes: { determinismHash: row.determinismHash ?? null, causalHash: row.causalHash ?? null },
      artifacts: artifacts(row),
      policyRule: context.rule ?? null,
      policy: context.policyStamp ?? null,
      // Guarded: `comfortPolicy` reads `manifest.invariants`, and a caller
      // handing in a partial manifest should get a null rather than a throw
      // from the diagnosis path of all places.
      comfortPolicy: context.manifest?.invariants ? comfortPolicy(context.manifest) : null,
    },
    $limitations: {
      observationsVsCauses:
        "`observations` are read from artifacts. `inferredCauses` are rule output, each naming the " +
        "rule that fired. An empty `inferredCauses` means no rule matched — it does not mean the " +
        "cause is unknowable, only that Atlas will not guess.",
      suggestedChanges:
        "Always empty. Fix suggestion (Phase 5 item 2) is not implemented; no suggestion has been " +
        "validated against a controlled target.",
      lane:
        row.provenance?.doesNotSupport ??
        "Lane not recorded on this row; treat any hardware reading as unsupported.",
      sampleSize: "One run on one profile. A single execution is not a rate.",
    },
  };
}

/**
 * Findings for a whole matrix report, in report order.
 *
 * @param {any} report
 * @param {{ traces?: Record<string, any>; contract?: any; manifest?: any; policyStamp?: any }} [context]
 */
export function findingsForReport(report, context = {}) {
  const rows = Array.isArray(report?.runs) ? report.runs : [];
  const contract = context.contract ?? report?.target?.contract ?? null;
  const findings = rows
    .map((row) =>
      findingForRun(row, {
        contract,
        manifest: context.manifest,
        policyStamp: context.policyStamp ?? null,
        trace: context.traces?.[row?.runId] ?? null,
      }),
    )
    .filter(Boolean);

  return {
    kind: "atlas.findings",
    schemaVersion: FINDING_SCHEMA_VERSION,
    counts: {
      rows: rows.length,
      findings: findings.length,
      aboutTarget: findings.filter((f) => f.inferredCauses.some((c) => c.aboutTarget === true)).length,
      aboutHarness: findings.filter(
        (f) => f.inferredCauses.length > 0 && f.inferredCauses.every((c) => c.aboutTarget === false),
      ).length,
      unexplained: findings.filter((f) => f.inferredCauses.length === 0).length,
    },
    findings,
    $limitations: {
      unexplained:
        "A finding with no inferred cause is the normal case, not a defect in the diagnosis. The " +
        "rule set is small and deliberately conservative.",
      coverage: "Only failed rows produce findings; a passing row is not diagnosed.",
    },
  };
}

/* ── observation collection ──────────────────────────────────────────────── */

/**
 * @param {any} row
 * @param {{ step: any; trace: any; failureAtMs: number | null; manifest?: any }} ctx
 * @returns {Observation[]}
 */
function collectObservations(row, ctx) {
  /** @type {Observation[]} */
  const out = [];
  const tracePath = row.tracePath ?? null;

  if (row.error) {
    out.push({ what: `The harness did not complete this run: ${row.error}`, source: "runs[].error", artifact: null });
  }

  if (row.verdict?.outcome?.value) {
    out.push({
      what: `The decision engine judged this run "${row.verdict.outcome.value}".`,
      source: "runs[].verdict.outcome",
      artifact: row.tracePath ? row.tracePath.replace(/trace\.json$/, "verdict.json") : null,
    });
  }

  if (ctx.step) {
    const where = ctx.step.index === undefined ? ctx.step.type : `step ${ctx.step.index} (${ctx.step.type})`;
    out.push({
      what:
        `The declared journey failed at ${where}` +
        (ctx.step.selector ? `, selector \`${ctx.step.selector}\`` : "") +
        ". The selector is the customer's own, from the target contract.",
      source: "runs[].drive.steps",
      artifact: null,
    });
  } else if (row.drive?.journeyOutcome === "fail") {
    out.push({
      what: "The declared journey failed without identifying a step.",
      source: "runs[].drive.journeyOutcome",
      artifact: null,
    });
  }

  if (typeof row.targetScore === "number") {
    out.push({ what: `Atlas score for this run: ${row.targetScore}/100.`, source: "runs[].targetScore", artifact: null });
  }

  for (const [key, value] of Object.entries(row.metrics ?? {})) {
    if (typeof value !== "number") continue;
    if (!["firstFrameMs", "ttiMs", "p95InteractionMs", "sustainedFps", "droppedFrames", "longTasks"].includes(key)) continue;
    out.push({ what: `${key} = ${value}.`, source: `runs[].metrics.${key}`, artifact: tracePath });
  }

  const console_ = consoleCategories(ctx.trace ?? row);
  for (const entry of console_) {
    out.push({
      // Codes and counts only. The scrubbed message text stays in the trace for
      // a human; it does not travel into a finding, because it is the one trace
      // field that can carry a customer string.
      what: `${entry.count} console error(s) in category "${entry.category}" (codes: ${entry.codes.join(", ")}).`,
      source: "trace.consoleErrors[].code",
      artifact: tracePath,
    });
  }

  if (ctx.failureAtMs !== null) {
    out.push({
      what: `Failure moment, as an offset from session start: ${ctx.failureAtMs}ms. No wall-clock time is recorded.`,
      source: "trace.events[].tOffsetMs",
      artifact: tracePath,
    });
  }

  if (row.servedTier) {
    out.push({
      what: `The app delivered tier "${row.servedTier}" on path "${row.servedPath ?? "unknown"}".`,
      source: "runs[].servedTier",
      artifact: tracePath,
    });
  }

  return out;
}

/* ── evidence assembly ──────────────────────────────────────────────────── */

/**
 * The first failing step of the customer's declared journey, or null.
 *
 * @param {any} row
 * @param {any} contract
 */
function failingContractStep(row, contract) {
  const steps = Array.isArray(row?.drive?.steps) ? row.drive.steps : [];
  const failed = steps.find((s) => s?.outcome === "fail");
  if (!failed) return null;
  const declared =
    typeof failed.index === "number" ? contract?.journey?.steps?.[failed.index] ?? null : null;
  return {
    index: failed.index ?? null,
    type: failed.type ?? null,
    selector: failed.selector ?? null,
    // Never the typed value: the driver already replaced it with `[redacted]`
    // and re-reading it here would undo that.
    declaredTimeoutMs: declared?.timeoutMs ?? null,
    reason: failed.reason ?? null,
    contractPresent: Boolean(contract),
  };
}

/**
 * When the run went wrong, in trace offsets.
 *
 * Preference order is deliberate: the first console error beats the last event,
 * because the error is usually the cause and the last event is usually the
 * symptom. Returns null rather than 0 when nothing can be located — 0 would put
 * the slice at session start and quietly mislead.
 *
 * @param {any} row
 * @param {any} step
 * @param {any} trace
 * @returns {number | null}
 */
function failureMoment(row, step, trace) {
  const errors = trace?.consoleErrors ?? row?.trace?.consoleErrors ?? [];
  if (errors.length && typeof errors[0].tOffsetMs === "number") return errors[0].tOffsetMs;
  const events = trace?.events ?? [];
  if (events.length) {
    const last = events[events.length - 1];
    if (typeof last?.tOffsetMs === "number") return last.tOffsetMs;
  }
  if (typeof step?.atMs === "number") return step.atMs;
  return null;
}

/**
 * Events around the failure moment. Offsets pass through exactly as the trace
 * recorded them (already quantised to TIME_QUANTUM_MS), so a slice is stable
 * across runs of the same seeded session and can be diffed.
 *
 * @param {any} trace
 * @param {number | null} centreMs
 */
function traceSlice(trace, centreMs) {
  const events = Array.isArray(trace?.events) ? trace.events : [];
  if (!events.length || centreMs === null) return [];
  const inWindow = events.filter(
    (e) => typeof e?.tOffsetMs === "number" && Math.abs(e.tOffsetMs - centreMs) <= TRACE_SLICE_RADIUS_MS,
  );
  // Keep the events nearest the failure when the window is crowded, then
  // restore chronological order — a slice that reads out of order is useless.
  const kept =
    inWindow.length <= TRACE_SLICE_MAX_EVENTS
      ? inWindow
      : [...inWindow]
          .sort((a, b) => Math.abs(a.tOffsetMs - centreMs) - Math.abs(b.tOffsetMs - centreMs))
          .slice(0, TRACE_SLICE_MAX_EVENTS)
          .sort((a, b) => a.tOffsetMs - b.tOffsetMs);
  return kept.map((e) => ({
    tOffsetMs: e.tOffsetMs,
    kind: e.kind ?? null,
    name: e.name ?? null,
    // Attribute *keys* only. The values are numbers today, but a key list is
    // stable against a future attribute that carries text, and the names are
    // what tell a reader what was measured.
    attributeKeys: Object.keys(e.attributes ?? {}).sort(),
  }));
}

/**
 * @param {any} source  a trace, or a row carrying consoleErrors
 */
function consoleCategories(source) {
  const errors = source?.consoleErrors ?? source?.trace?.consoleErrors ?? [];
  if (!Array.isArray(errors) || !errors.length) return [];
  /** @type {Record<string, { category: string; count: number; codes: string[]; firstAtMs: number | null }>} */
  const grouped = {};
  for (const e of errors) {
    const code = typeof e?.code === "string" ? e.code : "unknown";
    const category = consoleCategory(code);
    const bucket = (grouped[category] ??= { category, count: 0, codes: [], firstAtMs: null });
    bucket.count += 1;
    if (!bucket.codes.includes(code)) bucket.codes.push(code);
    if (typeof e?.tOffsetMs === "number" && (bucket.firstAtMs === null || e.tOffsetMs < bucket.firstAtMs)) {
      bucket.firstAtMs = e.tOffsetMs;
    }
  }
  return Object.values(grouped)
    .map((b) => ({ ...b, codes: [...b.codes].sort() }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * Failed asset loads, grouped by what a developer would go fix.
 *
 * Reads the trace's own asset events rather than a network log, because Atlas
 * does not keep a request log — and a URL from a page Atlas does not control is
 * exactly the field that must not land in an artifact unscrubbed.
 *
 * @param {any} trace
 */
function networkCategories(trace) {
  const events = Array.isArray(trace?.events) ? trace.events : [];
  const assets = events.filter((e) => e?.kind === "asset");
  if (!assets.length) return [];
  const failedCount = assets.filter((e) => e.attributes?.ok === false || e.attributes?.status >= 400).length;
  const out = [{ category: "asset", total: assets.length, failed: failedCount }];
  return failedCount ? out : out.map((o) => ({ ...o, note: "all asset events reported ok" }));
}

/** @param {any} row */
function artifacts(row) {
  const out = [];
  if (row.tracePath) out.push({ what: "trace", path: row.tracePath });
  for (const [id, file] of Object.entries(row.screenshots ?? {})) {
    // Named, not inlined, and flagged: a screenshot needs consent and human
    // review before it leaves the machine (PRIVACY.md).
    out.push({ what: `screenshot:${id}`, path: file, review: "consent + redaction + human review before sharing" });
  }
  return out;
}

/* ── titles and severity ────────────────────────────────────────────────── */

/**
 * @param {any} row
 * @param {any} step
 */
function titleFor(row, step) {
  const profile = row.profileId ?? "unknown profile";
  if (row.error) return `${profile}: harness lost the run before a verdict`;
  if (step) {
    const where = step.index === null || step.index === undefined ? step.type : `step ${step.index} (${step.type})`;
    return `${profile}: declared journey failed at ${where}`;
  }
  if (row.replay && row.replay.reproduced === false) return `${profile}: run did not reproduce on replay`;
  if (row.verdict?.outcome?.value === "inconclusive") return `${profile}: verdict inconclusive`;
  if (row.drive?.journeyOutcome === "fail") return `${profile}: declared journey failed`;
  return `${profile}: run judged ${row.verdict?.outcome?.value ?? "failing"}`;
}

/**
 * Severity is copied from the gate's own judgement, never recomputed.
 *
 * Two components that can disagree about how bad a failure is would give a
 * reader two answers, and the gate's is the one that decides a release.
 *
 * @param {any} row
 */
function severityFor(row) {
  const declared = row.verdict?.releaseBlocking?.value;
  if (typeof declared === "string" && SEVERITY_LEVELS.includes(declared)) return declared;
  // No gate judgement reached this row. Unknown severity is not low severity.
  if (row.error) return "hard block";
  return "major";
}
