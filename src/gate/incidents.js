/**
 * Failure memory.
 *
 * A test suite that finds the same bug twice and reports it as new both times
 * has no memory, and a team with no memory re-litigates every regression from
 * scratch. This module is the smallest useful version of remembering: a list of
 * failures that have happened before, each written down in plain language, kept
 * so that the next run can be asked "is this that again?"
 *
 * ## Why the matching is semantic and not a rule
 *
 * The obvious implementation is a matcher function per incident — a predicate
 * over the trace. That works exactly once. The second occurrence of a bug looks
 * *like* the first without being identical to it: the p95 is 340ms instead of
 * 290ms, it fires on a different profile, the asset that fails has a different
 * name. A predicate tuned to the first occurrence misses the second and reports
 * a shiny new incident, which is the failure mode this module exists to avoid.
 *
 * So each incident carries a `signature`: a description of the *shape* of the
 * failure, written for a reader rather than a parser, and `src/decision/
 * questions.js` turns each open incident into one noul — "does this session
 * look like that?" — answered with a calibrated probability. Jev is good at
 * exactly this and bad at the arithmetic version, which is why the numbers
 * stayed in `comfort.js` and this stayed here.
 *
 * ## The budget, and what retires
 *
 * Every open incident costs one question on the trace-judge call. Questions
 * ride free on a batched System One call in the sense that they share one
 * forward pass, but their *text* is billed as input tokens, so the set cannot
 * grow without limit. `OPEN_INCIDENT_CAP` bounds it, and when the cap is
 * reached the **oldest** incident retires rather than the least severe: an
 * incident nobody has seen in months is either fixed or not really a pattern,
 * while a recent one is live information. Retirement is recorded, not deleted,
 * so the history survives the fan-out budget.
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readJson, writeJson, fromRoot } from "../util/fsx.js";

/** Where the store lives when no path is given. Survives `artifacts/` wipes. */
export const INCIDENT_STORE = fromRoot("incidents", "store.json");

/**
 * How many incidents may be live in one fan-out.
 *
 * Six is a budget decision, not a research finding. The trace-judge call
 * already carries six questions plus the two Slice 2 additions; six incident
 * nouls puts the set at fourteen, which is comfortably inside the 255-option
 * ceiling and adds roughly 900 tokens of criteria text to a call whose state
 * payload already dominates. Raise it when someone has measured the cost of
 * raising it, not before.
 */
export const OPEN_INCIDENT_CAP = 6;

/**
 * @typedef {object} Incident
 * @property {string} id            stable, content-derived: `inc-<8 hex>`
 * @property {string} title         one line, human
 * @property {string} signature     what this failure looks like, for the noul criteria
 * @property {string} notLike       what would rule it out — the false criterion
 * @property {string} firstSeenIso
 * @property {string} lastSeenIso
 * @property {number} occurrences
 * @property {"open" | "retired" | "fixed"} status
 * @property {string[]} seenOn      profile ids this has been observed on
 * @property {string | null} retiredReason
 */

/**
 * @typedef {object} IncidentStore
 * @property {"atlas.incidents"} kind
 * @property {number} schemaVersion
 * @property {Incident[]} incidents
 */

/**
 * Incidents shipped with the repo.
 *
 * These are the failure shapes Atlas has actually produced or been built to
 * catch during development — not hypotheticals, and not a taxonomy copied from
 * somewhere. They seed the memory so a first run on a stranger's URL has
 * something to compare against; a deployment accumulates its own on top.
 */
export const SEED_INCIDENTS = Object.freeze([
  {
    id: "inc-blankfirst",
    title: "First frame reports a time but paints nothing",
    signature:
      "A first-frame timestamp exists and looks healthy, but the captured frame is blank or " +
      "near-blank: focal coverage at or near zero while the timing budget is met. The session " +
      "may continue normally afterwards, which is what makes the timing number so misleading.",
    notLike:
      "The first frame carries real content — focal coverage is meaningfully above zero — or " +
      "no first-frame measurement was taken at all.",
  },
  {
    id: "inc-heavyblank",
    title: "Heavy payload delivered, nothing rendered",
    signature:
      "Megabytes of assets transferred successfully — no request failures — and yet no live " +
      "canvas covers the viewport and almost no frames were rendered. The bytes arrived and " +
      "the experience did not. Distinct from a deliberate static fallback, which downloads " +
      "almost nothing.",
    notLike:
      "Either the payload was small (a genuine poster or static page), or a canvas is present " +
      "and rendering frames.",
  },
  {
    id: "inc-xrdeadend",
    title: "Refused XR permission leaves a dead end",
    signature:
      "An XR or camera session was requested and refused, and afterwards the session stalls: " +
      "it never reaches its end state, or it enters an error state, or rendering stops. The " +
      "app treats the refusal as fatal rather than as a branch.",
    notLike:
      "No XR was attempted, the session was granted, or the refusal was followed by the app " +
      "continuing normally to its end state on a 2D or static path.",
  },
  {
    id: "inc-stallwindow",
    title: "Sustained frame-rate collapse during interaction",
    signature:
      "Frame pacing is acceptable on average but collapses for a sustained stretch — several " +
      "seconds where p95 frame time is multiples of the budget — typically while the user is " +
      "dragging or looking around. The mean hides it; the worst window does not.",
    notLike:
      "Frame times are consistent throughout, or the only bad frames are isolated single-frame " +
      "hitches rather than a sustained stretch.",
  },
  {
    id: "inc-timingblind",
    title: "Transfer size unmeasurable through cross-origin assets",
    signature:
      "Resource timing reports zero or near-zero transfer bytes while the page clearly loaded " +
      "and rendered substantial content. The assets are cross-origin without a " +
      "Timing-Allow-Origin header, so the harness is blind to their size rather than the app " +
      "being small.",
    notLike:
      "Transfer bytes are consistent with what rendered, or the page genuinely is a small " +
      "static document.",
  },
]);

/* ── reading ─────────────────────────────────────────────────────────────── */

/**
 * @param {string} [storePath]
 * @returns {Promise<IncidentStore>}
 */
export async function loadIncidents(storePath = INCIDENT_STORE) {
  if (!existsSync(storePath)) {
    const now = new Date().toISOString();
    return {
      kind: "atlas.incidents",
      schemaVersion: 1,
      incidents: SEED_INCIDENTS.map((seed) => ({
        ...seed,
        firstSeenIso: now,
        lastSeenIso: now,
        occurrences: 0,
        status: /** @type {const} */ ("open"),
        seenOn: [],
        retiredReason: null,
      })),
    };
  }
  const raw = /** @type {IncidentStore} */ (await readJson(storePath));
  return {
    kind: "atlas.incidents",
    schemaVersion: 1,
    incidents: Array.isArray(raw.incidents) ? raw.incidents.map(coerce).filter(Boolean) : [],
  };
}

/**
 * The incidents a fan-out will actually ask about: open ones, most recently
 * seen first, capped. Anything past the cap is left in the store untouched —
 * this function selects, it does not mutate.
 *
 * @param {IncidentStore} store
 * @param {number} [cap]
 * @returns {Incident[]}
 */
export function openIncidents(store, cap = OPEN_INCIDENT_CAP) {
  return store.incidents
    .filter((i) => i.status === "open")
    .sort((a, b) => Date.parse(b.lastSeenIso) - Date.parse(a.lastSeenIso))
    .slice(0, cap);
}

/* ── writing ─────────────────────────────────────────────────────────────── */

/**
 * Records an occurrence of a known incident, or opens a new one.
 *
 * Identity is content-derived from the title and signature, so recording "the
 * same" incident twice merges rather than duplicating — a store that fills with
 * near-identical entries stops being memory and becomes noise.
 *
 * @param {IncidentStore} store
 * @param {{ title: string; signature: string; notLike: string; profileId?: string | null }} seen
 * @returns {{ store: IncidentStore; incident: Incident; isNew: boolean; retired: Incident[] }}
 */
export function recordIncident(store, seen) {
  const id = incidentId(seen.title, seen.signature);
  const now = new Date().toISOString();
  const existing = store.incidents.find((i) => i.id === id);

  /** @type {Incident} */
  let incident;
  let isNew = false;

  if (existing) {
    existing.lastSeenIso = now;
    existing.occurrences += 1;
    existing.status = "open";
    existing.retiredReason = null;
    if (seen.profileId && !existing.seenOn.includes(seen.profileId)) {
      existing.seenOn.push(seen.profileId);
    }
    incident = existing;
  } else {
    isNew = true;
    incident = {
      id,
      title: seen.title,
      signature: seen.signature,
      notLike: seen.notLike,
      firstSeenIso: now,
      lastSeenIso: now,
      occurrences: 1,
      status: "open",
      seenOn: seen.profileId ? [seen.profileId] : [],
      retiredReason: null,
    };
    store.incidents.push(incident);
  }

  return { store, incident, isNew, retired: retireOverflow(store, incident.id) };
}

/**
 * Retires the oldest open incidents until the open set fits the cap.
 *
 * Oldest-first rather than least-severe-first: severity is a judgement that
 * changes, but "nobody has seen this in six months" is a fact, and a fact is a
 * better basis for spending a fixed budget. The just-recorded incident is
 * exempt — retiring the thing that just happened would be absurd.
 *
 * @param {IncidentStore} store
 * @param {string} exemptId
 * @returns {Incident[]}
 */
function retireOverflow(store, exemptId) {
  /** @type {Incident[]} */
  const retired = [];
  const open = () => store.incidents.filter((i) => i.status === "open");

  while (open().length > OPEN_INCIDENT_CAP) {
    const candidates = open()
      .filter((i) => i.id !== exemptId)
      .sort((a, b) => Date.parse(a.lastSeenIso) - Date.parse(b.lastSeenIso));
    const oldest = candidates[0];
    if (!oldest) break;
    oldest.status = "retired";
    oldest.retiredReason =
      `retired to stay inside the ${OPEN_INCIDENT_CAP}-incident fan-out budget; ` +
      `last seen ${oldest.lastSeenIso}. Its history is kept — it is out of the question set, not gone.`;
    retired.push(oldest);
  }
  return retired;
}

/**
 * @param {IncidentStore} store
 * @param {string} [storePath]
 */
export async function saveIncidents(store, storePath = INCIDENT_STORE) {
  await writeJson(storePath, store);
  return storePath;
}

/** @param {string} title @param {string} signature */
export function incidentId(title, signature) {
  const h = createHash("sha256").update(`${title} ${signature}`).digest("hex").slice(0, 8);
  return `inc-${h}`;
}

/**
 * @param {any} raw
 * @returns {Incident | null}
 */
function coerce(raw) {
  if (!raw || typeof raw.id !== "string" || typeof raw.signature !== "string") return null;
  const status = ["open", "retired", "fixed"].includes(raw.status) ? raw.status : "open";
  return {
    id: raw.id,
    title: String(raw.title ?? raw.id),
    signature: raw.signature,
    notLike: String(raw.notLike ?? "The session does not show this pattern."),
    firstSeenIso: String(raw.firstSeenIso ?? new Date(0).toISOString()),
    lastSeenIso: String(raw.lastSeenIso ?? raw.firstSeenIso ?? new Date(0).toISOString()),
    occurrences: Number.isFinite(raw.occurrences) ? Number(raw.occurrences) : 0,
    status,
    seenOn: Array.isArray(raw.seenOn) ? raw.seenOn.map(String) : [],
    retiredReason: raw.retiredReason == null ? null : String(raw.retiredReason),
  };
}

/** @param {string} [storePath] */
export function storeRelPath(storePath = INCIDENT_STORE) {
  return path.relative(process.cwd(), storePath).split(path.sep).join("/");
}
