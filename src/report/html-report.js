/**
 * Renders one self-contained HTML page from whatever is in `artifacts/`.
 *
 * ## Why an HTML report at all
 *
 * The JSON reports are the record; this is the thing a person reads. A matrix
 * run produces seven traces, forty-odd screenshots, a gate decision and an
 * engine comparison, and "go read artifacts/matrix/report.json" is not a
 * deliverable. The page is static, has no JavaScript and no external requests,
 * and opens over `file://` — so it survives being zipped, emailed or committed,
 * which a dashboard does not.
 *
 * ## Two rules this file follows
 *
 * **Missing is stated, not omitted.** If the replay never ran, the replay
 * section says "not run" and gives the command. A page that silently drops a
 * section lets a reader assume a stage passed when it never executed, which is
 * the single most dangerous failure mode a report like this has.
 *
 * **Every number is traced to its source.** Each metric block carries where it
 * came from — which trace file, captured at which timestamp. Nothing here is
 * typed in by hand, and the page says so in a way a reader can check rather
 * than a way they have to believe.
 *
 * @typedef {import("../../types/atlas.js").ExperienceManifest} ExperienceManifest
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";

import { orbitalManifest } from "../manifest/atlas-orbital.manifest.js";
import { MATRIX_DIR } from "../runner/run-matrix.js";
import { REPLAY_DIR } from "../runner/run-replay.js";
import { GATE_DIR } from "../gate/release-gate.js";
import { COMPARE_DIR } from "./engine-comparison.js";
import { JUDGE_DIR } from "../judge/run-judge.js";
import { readJson, writeFileEnsured, fromRoot, ROOT } from "../util/fsx.js";
import { logger } from "../util/log.js";

const log = logger("report");

/**
 * The three claims this project must never let a reader make on its behalf.
 * They are rendered at the top of the page, before any result, because a
 * disclaimer under the fold is decoration.
 */
const DISCLAIMERS = [
  {
    title: "No Flam integration. None.",
    body:
      "This is an independent demo built from scratch. It does not use, wrap, call or reimplement " +
      "any Flam SDK, API or product, and nothing here was derived from Flam's codebase. " +
      "The experience, the manifest format and the tier ladder are invented for this project. " +
      "Any resemblance to how Flam actually builds WebAR is coincidence or convergent engineering.",
  },
  {
    title: "Emulated browsers, not devices.",
    body:
      "Every result on this page comes from Chromium running on one desktop machine with CPU " +
      "throttling, network shaping and injected capability hints. The throttling and shaping are " +
      "real and applied by the browser; deviceMemory, hardwareConcurrency, navigator.connection " +
      "and the GPU tier are hints this harness injects. These runs say nothing about thermal " +
      "throttling, real GPU drivers, real radio behaviour or actual handset performance. " +
      "Confirming any of that needs a physical device lab, which this is not.",
  },
  {
    title: "Jev's published numbers are TypeSafe's, not measurements taken here.",
    body:
      "Where this page mentions Jev latency, calibration or throughput, those figures are " +
      "TypeSafe's own published claims, attributed as such. This project has not independently " +
      "verified them. The only Jev measurement here is the small side-by-side agreement check in " +
      "the comparison section, run on twelve synthetic capability packets and ten synthetic " +
      "traces — a smoke test on a sample far too small to support a claim about the model.",
  },
];

/**
 * @param {{ outFile?: string; quiet?: boolean }} [opts]
 */
export async function renderReport(opts = {}) {
  const outFile = opts.outFile ?? fromRoot("artifacts", "report.html");
  const outDir = path.dirname(outFile);

  const sources = {
    matrix: await load(path.join(MATRIX_DIR, "report.json")),
    gate: await load(path.join(GATE_DIR, "report.json")),
    compare: await load(path.join(COMPARE_DIR, "engine-comparison.json")),
    judge: await load(path.join(JUDGE_DIR, "judge-report.json")),
    replays: await loadReplays(),
  };

  const html = renderHtml(sources, outDir);
  await writeFileEnsured(outFile, html);

  if (!opts.quiet) {
    const present = [
      sources.matrix ? "matrix" : null,
      sources.replays.length ? `replay×${sources.replays.length}` : null,
      sources.gate ? "gate" : null,
      sources.compare ? "compare" : null,
      sources.judge ? `judge×${sources.judge.data.counts?.judged ?? "?"}` : null,
    ].filter(Boolean);
    log.info(
      present.length
        ? `rendered from: ${present.join(", ")}`
        : "nothing to render yet — no artifacts found. The page explains what to run.",
    );
    log.info(`wrote ${rel(outFile)}`);
  }

  return { file: outFile, sources };
}

/* ── loading ─────────────────────────────────────────────────────────────── */

/** @param {string} file */
async function load(file) {
  if (!existsSync(file)) return null;
  try {
    return { path: file, data: await readJson(file) };
  } catch (err) {
    log.warn(`could not read ${rel(file)}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Every replay under artifacts/replay/, in a stable order with the baseline
 * first — the failure story is told before → after, so its evidence is listed
 * in the same direction.
 */
async function loadReplays() {
  if (!existsSync(REPLAY_DIR)) return [];
  /** @type {Array<{ path: string; data: any }>} */
  const found = [];
  for (const entry of await readdir(REPLAY_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const loaded = await load(path.join(REPLAY_DIR, entry.name, "report.json"));
    if (loaded) found.push(loaded);
  }
  return found.sort((a, b) => {
    const aBase = a.data.source?.runKind === "baseline" ? 0 : 1;
    const bBase = b.data.source?.runKind === "baseline" ? 0 : 1;
    return aBase - bBase || String(a.data.runId).localeCompare(String(b.data.runId));
  });
}

/* ── page ────────────────────────────────────────────────────────────────── */

/**
 * @param {{ matrix: any; gate: any; compare: any; replays: any[] }} s
 * @param {string} outDir
 */
function renderHtml(s, outDir) {
  /** Resolve a stored artifact path into an href relative to the HTML file. */
  const href = (/** @type {string | null} */ stored) => {
    if (!stored) return null;
    const abs = existsSync(path.resolve(stored)) ? path.resolve(stored) : path.resolve(ROOT, stored);
    return path.relative(outDir, abs).split(path.sep).join("/");
  };

  const generatedAt = new Date();
  const body = [
    header(s, generatedAt),
    disclaimers(),
    gateSection(s.gate),
    failureStory(s.matrix, href),
    matrixSection(s.matrix, href),
    replaySection(s.replays, href),
    compareSection(s.compare),
    judgeSection(s.judge),
    provenance(s, generatedAt),
  ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Atlas Replay Lab — run report</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

/**
 * @param {any} s
 * @param {Date} generatedAt
 */
function header(s, generatedAt) {
  const m = s.matrix?.data;
  return `
<section class="hero">
  <p class="eyebrow">Proof of work · independent demo</p>
  <h1>Atlas Replay Lab</h1>
  <p class="lede">
    An adaptive WebAR-shaped experience that degrades on purpose, a capability-aware tier ladder,
    a privacy-safe flight recorder, deterministic replay, and a decision layer with two
    interchangeable engines behind one interface.
  </p>
  <div class="facts">
    ${fact("generated", generatedAt.toISOString())}
    ${fact("matrix captured", m?.startedAtIso ?? "— not run —")}
    ${fact("seed", m ? `0x${Number(m.seed).toString(16)}` : "—")}
    ${fact("manifest", m?.manifest?.contentHash ?? orbitalManifest.contentHash)}
    ${fact("decision engine", m?.engine?.name ?? "—")}
  </div>
</section>`;
}

function disclaimers() {
  return `
<section>
  <h2>Read this first</h2>
  <div class="disclaimers">
    ${DISCLAIMERS.map((d) => `<div class="disclaimer"><h3>${esc(d.title)}</h3><p>${esc(d.body)}</p></div>`).join("\n    ")}
  </div>
</section>`;
}

/** @param {any} gate */
function gateSection(gate) {
  if (!gate) {
    return notRun("Release decision", "node bin/atlas.js gate", "The release rule has not been applied to a captured matrix report.");
  }
  const g = gate.data;
  const bySeverity = { block: [], warn: [], info: [] };
  for (const f of g.findings) (bySeverity[f.severity] ??= []).push(f);

  return `
<section>
  <h2>Release decision</h2>
  <div class="verdict ${g.shipped ? "ship" : "hold"}">
    <span class="verdict-word">${g.shipped ? "SHIP" : "HOLD"}</span>
    <span class="verdict-counts">
      ${g.counts.blocks} blocking · ${g.counts.warnings} warning · ${g.counts.info} informational
      across ${g.counts.graded} graded run${g.counts.graded === 1 ? "" : "s"}
    </span>
  </div>
  <p class="rule">${esc(g.rule.summary)}</p>
  <p class="note">${esc(g.rule.baselineExcluded)}</p>
  ${
    g.findings.length
      ? `<table>
    <thead><tr><th></th><th>rule</th><th>run</th><th>finding</th></tr></thead>
    <tbody>
      ${["block", "warn", "info"]
        .flatMap((sev) =>
          (bySeverity[sev] ?? []).map(
            (/** @type {any} */ f) => `<tr class="sev-${sev}">
        <td><span class="pill ${sev}">${sev}</span></td>
        <td class="mono">${esc(f.rule)}</td>
        <td class="mono">${esc(f.runId)}</td>
        <td>${esc(f.message)}</td>
      </tr>`,
          ),
        )
        .join("\n      ")}
    </tbody>
  </table>`
      : `<p class="note">No findings at all — every check passed clean.</p>`
  }
  <p class="source">Source: <code>${esc(rel(gate.path))}</code> · reproduce with <code>${esc(g.reproduce)}</code></p>
</section>`;
}

/**
 * The §5.2 item-8 requirement: one failure told end to end, entirely from
 * captured numbers. Every cell below is read out of a trace JSON; the page
 * refuses to render the section at all rather than fill a gap by hand.
 *
 * @param {any} matrix
 * @param {(p: string | null) => string | null} href
 */
function failureStory(matrix, href) {
  if (!matrix) {
    return notRun("The failure story", "node bin/atlas.js matrix", "No matrix has been captured, so there is no before and after to compare.");
  }
  const story = matrix.data.summary.failureStory;
  if (story?.unavailable) {
    return `
<section>
  <h2>The failure story</h2>
  <p class="warning">Not available: ${esc(story.unavailable)}</p>
  <p class="note">Run the full matrix (including the baseline) with <code>node bin/atlas.js matrix</code>.</p>
</section>`;
  }

  const before = story.before;
  const after = story.after;
  const rows = [
    metricRow("first frame", before.firstFrameMs, after.firstFrameMs, "ms", story.budgetFirstFrameMs),
    metricRow("time to interactive", before.timeToInteractiveMs, after.timeToInteractiveMs, "ms"),
    metricRow("p95 interaction", before.p95InteractionMs, after.p95InteractionMs, "ms"),
    metricRow("transfer", before.transferBytes, after.transferBytes, "B"),
    metricRow("dropped frames", before.droppedFrameRatio, after.droppedFrameRatio, "ratio"),
  ];

  const beforeRun = matrix.data.runs.find((/** @type {any} */ r) => r.runId === before.runId);
  const afterRun = matrix.data.runs.find((/** @type {any} */ r) => r.runId === after.runId);

  return `
<section>
  <h2>The failure story</h2>
  <p class="lede">
    On <code>${esc(story.profileId)}</code> the high tier is unservable. The baseline run bypasses the
    router and serves it anyway; the adaptive run lets the decision engine choose. Both are real
    captures from this machine, and the replay section below proves each one reproduces.
  </p>

  <div class="story">
    <div class="story-half fail">
      <h3>Before — router bypassed</h3>
      <p class="mono small">${esc(before.runId)} · tier <b>${esc(before.forcedTier ?? before.servedTier ?? "?")}</b> (forced) · path ${esc(before.servedPath ?? "—")}</p>
      <p class="outcome ${before.outcome === "pass" ? "ok" : "bad"}">${esc(before.outcome ?? "no verdict")}${before.rootCause && before.rootCause !== "unknown" ? ` — ${esc(before.rootCause)}` : ""}</p>
      <ul class="checks">
        <li>${check(before.reachedEndState)} reached checkout</li>
        <li>${check(before.firstFrameNonBlank)} first frame non-blank</li>
      </ul>
    </div>
    <div class="story-arrow">→</div>
    <div class="story-half pass">
      <h3>After — decision engine routes</h3>
      <p class="mono small">${esc(after.runId)} · tier <b>${esc(after.servedTier ?? "?")}</b> (chosen) · path ${esc(after.servedPath ?? "—")}</p>
      <p class="outcome ${after.outcome === "pass" ? "ok" : "bad"}">${esc(after.outcome ?? "no verdict")}${after.rootCause && after.rootCause !== "unknown" ? ` — ${esc(after.rootCause)}` : ""}</p>
      <ul class="checks">
        <li>${check(after.reachedEndState)} reached checkout</li>
        <li>${check(after.firstFrameNonBlank)} first frame non-blank</li>
      </ul>
    </div>
  </div>

  <table>
    <thead><tr><th>metric</th><th>before</th><th>after</th><th>change</th></tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table>
  <p class="note">
    Every figure above was read from a captured trace, not entered by hand:
    <code>${esc(before.tracePath ?? "—")}</code> and <code>${esc(after.tracePath ?? "—")}</code>,
    captured during the matrix run that started ${esc(matrix.data.startedAtIso)}.
  </p>

  ${screenshotStrip(beforeRun, afterRun, href)}
</section>`;
}

/**
 * @param {any} beforeRun
 * @param {any} afterRun
 * @param {(p: string | null) => string | null} href
 */
function screenshotStrip(beforeRun, afterRun, href) {
  if (!beforeRun?.screenshots || !afterRun?.screenshots) return "";
  const ids = Object.keys(afterRun.screenshots).filter((id) => beforeRun.screenshots[id]);
  if (!ids.length) return "";

  return `
  <h3>Checkpoints, side by side</h3>
  <p class="note">Left: the bypassed baseline. Right: the routed run. Same seed, same animation phase, same checkpoints.</p>
  <div class="shots">
    ${ids
      .map(
        (id) => `<figure>
      <figcaption>${esc(id)}</figcaption>
      <div class="pair">
        <img loading="lazy" src="${esc(href(beforeRun.screenshots[id]) ?? "")}" alt="baseline ${esc(id)}">
        <img loading="lazy" src="${esc(href(afterRun.screenshots[id]) ?? "")}" alt="adaptive ${esc(id)}">
      </div>
    </figure>`,
      )
      .join("\n    ")}
  </div>`;
}

/**
 * @param {any} matrix
 * @param {(p: string | null) => string | null} href
 */
function matrixSection(matrix, href) {
  if (!matrix) {
    return notRun("Capability matrix", "node bin/atlas.js matrix", "No matrix report on disk.");
  }
  const m = matrix.data;
  const budgets = m.budgets;

  const rows = m.runs.map((/** @type {any} */ r) => {
    const met = r.metrics;
    return `<tr class="${r.runKind === "baseline" ? "baseline-row" : ""}">
      <td>
        <div class="run-id mono">${esc(r.runId)}</div>
        <div class="small dim">${esc(r.label)}</div>
      </td>
      <td class="mono">${esc(r.servedTier ?? "—")}${r.forcedTier ? ` <span class="pill warn">forced</span>` : ""}<div class="small dim">${esc(r.servedPath ?? "")}</div></td>
      <td>${verdictPill(r.verdict)}</td>
      <td class="num ${overBudget(met?.firstFrameMs, budgets.firstFrameMs)}">${ms(met?.firstFrameMs)}</td>
      <td class="num ${overBudget(met?.timeToInteractiveMs, budgets.timeToInteractiveMs)}">${ms(met?.timeToInteractiveMs)}</td>
      <td class="num ${overBudget(met?.p95InteractionMs, budgets.p95InteractionMs)}">${ms(met?.p95InteractionMs)}</td>
      <td class="num ${overBudget(met?.transferBytes, budgets.maxTransferBytes)}">${bytes(met?.transferBytes)}</td>
      <td class="num">${check(met?.reachedEndState)}</td>
      <td class="num">${check(met?.firstFrameNonBlank)}</td>
      <td class="mono small">${r.tracePath ? `<a href="${esc(href(r.tracePath) ?? "")}">trace</a>` : `<span class="dim">none</span>`}</td>
    </tr>`;
  });

  return `
<section>
  <h2>Capability matrix</h2>
  <p class="lede">
    ${m.runs.length} runs — the six profiles plus the bypassed baseline — executed sequentially,
    never in parallel, because CPU throttling is a whole-browser setting and two throttled
    renderers on one machine contend for the same cores.
  </p>
  <table class="matrix">
    <thead><tr>
      <th>run</th><th>served</th><th>verdict</th>
      <th class="num">first frame</th><th class="num">TTI</th><th class="num">p95 tap</th>
      <th class="num">transfer</th><th class="num">checkout</th><th class="num">non-blank</th><th></th>
    </tr></thead>
    <tbody>${rows.join("\n")}</tbody>
  </table>
  <p class="note">
    Red cells are over the manifest's budget. The budgets are <em>high-tier targets</em>: a
    throttled device served the low tier and still missing a high-tier budget is the ladder
    working, not a regression, which is why the release rule treats budget breaches as warnings
    and gates on the invariants instead.
  </p>
  <p class="note">${esc(m.emulationDisclaimer)}</p>
  <p class="source">Source: <code>${esc(rel(matrix.path))}</code> · reproduce with <code>${esc(m.reproduce)}</code></p>
</section>`;
}

/**
 * @param {any[]} replays
 * @param {(p: string | null) => string | null} href
 */
function replaySection(replays, href) {
  if (!replays.length) {
    return notRun(
      "Deterministic replay",
      "node bin/atlas.js replay",
      "No replay has been run, so nothing on this page has been shown to reproduce.",
    );
  }

  return `
<section>
  <h2>Deterministic replay</h2>
  <p class="lede">
    Each captured session is re-run from its trace — same seed, same profile, same recorded input
    offsets — and compared three ways: causal structure, quantised timing, and checkpoint pixels.
  </p>
  ${replays.map((r) => replayCard(r, href)).join("\n")}
</section>`;
}

/**
 * @param {{ path: string; data: any }} replay
 * @param {(p: string | null) => string | null} href
 */
function replayCard(replay, href) {
  const r = replay.data;
  const c = r.comparison;
  const diverged = r.visual.filter((/** @type {any} */ v) => v.status === "diverged" || v.status === "missing" || v.status === "extra");
  const overlays = r.visual.filter((/** @type {any} */ v) => v.overlay);

  return `
  <div class="card">
    <div class="card-head">
      <h3 class="mono">${esc(r.runId)}</h3>
      <span class="pill ${r.verdict.reproduced ? "ok" : "block"}">${r.verdict.reproduced ? "reproduced" : "did not reproduce"}</span>
    </div>
    <p>${esc(r.verdict.reason)}</p>
    <table class="kv">
      <tr><td>causal structure</td><td>${check(c?.causalMatch)} <span class="mono small">${esc(c?.sourceCausalHash ?? "—")}</span> vs <span class="mono small">${esc(c?.replayCausalHash ?? "—")}</span></td></tr>
      <tr><td>quantised timing</td><td>${check(c?.timedMatch)} <span class="mono small">${esc(c?.sourceDeterminismHash ?? "—")}</span> vs <span class="mono small">${esc(c?.replayDeterminismHash ?? "—")}</span></td></tr>
      <tr><td>checkpoints compared</td><td>${r.visual.length} · ${r.visual.filter((/** @type {any} */ v) => v.status === "identical").length} identical · ${r.visual.filter((/** @type {any} */ v) => v.status === "within-tolerance").length} within tolerance · ${diverged.length} diverged</td></tr>
      <tr><td>router</td><td>${r.routerPinned ? `pinned to <b>${esc(r.forcedTier)}</b>, matching the capture` : "live — the engine re-derived the tier from the replayed capability packet"}</td></tr>
      <tr><td>tolerance</td><td class="small">≤ ${(r.tolerances.maxPixelDiffRatio * 100).toFixed(2)}% pixels differing, ≥ ${r.tolerances.minPerceptualScore} perceptual. ${esc(r.tolerances.note)}</td></tr>
    </table>
    ${
      c && !c.timedMatch && c.firstDivergence
        ? `<p class="note">First timing divergence: <code>${esc(JSON.stringify(c.firstDivergence))}</code></p>`
        : ""
    }
    ${
      overlays.length
        ? `<details>
      <summary>${overlays.length} checkpoint${overlays.length === 1 ? "" : "s"} with a pixel difference (overlays)</summary>
      <div class="shots">${overlays
        .map(
          (/** @type {any} */ v) => `<figure>
        <figcaption>${esc(v.id)} — ${(v.diff.pixelDiffRatio * 100).toFixed(3)}% pixels, perceptual ${v.diff.perceptualScore.toFixed(4)}</figcaption>
        <img loading="lazy" src="${esc(href(v.overlay) ?? "")}" alt="diff overlay ${esc(v.id)}">
      </figure>`,
        )
        .join("")}</div>
    </details>`
        : `<p class="note">Every compared checkpoint was pixel-identical.</p>`
    }
    <p class="source">Source: <code>${esc(rel(replay.path))}</code> · reproduce with <code>${esc(r.reproduce)}</code></p>
  </div>`;
}

/** @param {any} compare */
function compareSection(compare) {
  if (!compare) {
    return notRun("Decision engines, side by side (§4.4)", "node bin/atlas.js compare", "The comparison harness has not been run.");
  }
  const c = compare.data;
  const agree = c.agreement;

  const modeNote = `
  <div class="mode-note ${c.mode}">
    <b>${esc(c.mode)}</b> — ${esc(c.$note)}
  </div>`;

  const agreementBlock = agree.available
    ? `<table>
    <thead><tr><th>question</th><th class="num">agreement</th><th class="num">n</th></tr></thead>
    <tbody>${Object.entries(agree)
      .filter(([, v]) => v && typeof v === "object" && "rate" in /** @type {any} */ (v))
      .map(
        ([key, v]) => `<tr><td class="mono">${esc(key)}</td><td class="num">${pct(/** @type {any} */ (v).rate)}</td><td class="num dim">${/** @type {any} */ (v).agreed}/${/** @type {any} */ (v).n}</td></tr>`,
      )
      .join("")}</tbody>
  </table>`
    : `<p class="warning">${esc(agree.reason)}</p>
     <p class="note">${esc(agree.detail)}</p>`;

  const tierRows = c.tierRows
    .map(
      (/** @type {any} */ r) => `<tr>
      <td class="mono">${r.contested ? `<span class="pill dim" title="a reasonable engineer could assign a different label">contested</span> ` : ""}${esc(r.id)}</td>
      <td class="mono">${esc(r.rules.tier)} <span class="dim small">${r.rules.confidence}</span></td>
      <td class="mono">${r.jev ? `${esc(r.jev.tier)} <span class="dim small">${r.jev.confidence}</span>` : r.jevError ? `<span class="bad small">${esc(r.jevError)}</span>` : `<span class="dim">—</span>`}</td>
      <td>${r.agreement ? check(r.agreement.tier) : `<span class="dim">—</span>`}</td>
      <td class="mono dim">${esc(r.groundTruth)}</td>
    </tr>`,
    )
    .join("");

  const traceRows = c.traceRows
    .map(
      (/** @type {any} */ r) => `<tr>
      <td class="mono">${r.contested ? `<span class="pill dim">contested</span> ` : ""}${esc(r.id)}</td>
      <td class="mono">${esc(r.rules.outcome)} <span class="dim small">${esc(r.rules.rootCause)}</span></td>
      <td class="mono">${r.jev ? `${esc(r.jev.outcome)} <span class="dim small">${esc(r.jev.rootCause)}</span>` : r.jevError ? `<span class="bad small">${esc(r.jevError)}</span>` : `<span class="dim">—</span>`}</td>
      <td>${r.agreement ? check(r.agreement.outcome && r.agreement.rootCause) : `<span class="dim">—</span>`}</td>
      <td class="mono dim">${esc(r.expected.outcome)}</td>
    </tr>`,
    )
    .join("");

  return `
<section>
  <h2>Decision engines, side by side (§4.4)</h2>
  <p class="lede">
    Both engines implement one interface and answer the same three questions about a capability
    packet, and the same six about a trace. The rule-based engine is the default and needs no key;
    the Jev engine is optional and degrades to the rule engine when it is unavailable, unsure, or
    wrong in the unsafe direction.
  </p>
  ${modeNote}

  <h3>Agreement</h3>
  ${agreementBlock}

  <h3>Calibration</h3>
  ${
    c.calibration.available
      ? `<p class="warning">${esc(c.calibration.caveat)}</p>
  <table>
    <thead><tr><th>confidence</th><th class="num">n</th><th class="num">mean stated</th><th class="num">observed</th><th class="num">gap</th></tr></thead>
    <tbody>${c.calibration.buckets
      .map(
        (/** @type {any} */ b) => `<tr><td class="mono">${esc(b.range)}</td><td class="num">${b.n}</td><td class="num">${b.meanConfidence ?? "—"}</td><td class="num">${b.observedAccuracy ?? "—"}</td><td class="num">${b.gap === null ? "—" : (b.gap >= 0 ? "+" : "") + b.gap}</td></tr>`,
      )
      .join("")}</tbody>
  </table>`
      : `<p class="note">${esc(c.calibration.reason)}</p>`
  }

  <h3>Tier router — capability packets</h3>
  <table>
    <thead><tr><th>state</th><th>rule engine</th><th>Jev</th><th>agree</th><th>hand label</th></tr></thead>
    <tbody>${tierRows}</tbody>
  </table>

  <h3>Trace judge — synthetic traces</h3>
  <table>
    <thead><tr><th>scenario</th><th>rule engine</th><th>Jev</th><th>agree</th><th>hand label</th></tr></thead>
    <tbody>${traceRows}</tbody>
  </table>

  <p class="note">${esc(c.groundTruth.caveat)}</p>
  <p class="source">Source: <code>${esc(rel(compare.path))}</code> · reproduce with <code>node bin/atlas.js compare</code></p>
</section>`;
}

/**
 * Batch trace triage: every captured trace judged, scored, and — when a model
 * is configured — compared. Missing states as missing per the file's rule.
 * @param {any} judge
 */
function judgeSection(judge) {
  if (!judge) {
    return notRun(
      "Batch trace triage",
      "node bin/atlas.js judge",
      "No captured traces have been batch-judged. Judging observes; the gate decides.",
    );
  }
  const j = judge.data;
  const rows = (j.rows ?? [])
    .map(
      (/** @type {any} */ r) => {
        // Rows written before the Atlas score existed carry no `atlasScore`;
        // state the gap per row rather than crashing the whole page.
        const a = r.atlasScore ?? null;
        const v = r.rules ?? {};
        return `<tr>
      <td class="mono">${esc(r.traceId)}</td>
      <td class="mono dim">${esc(r.profile ?? "—")}</td>
      <td class="num">${a === null || a.score === null ? `<span class="dim">—</span>` : `${a.score} <span class="dim small">${esc(a.label ?? "")}</span>`}</td>
      <td class="mono">${esc(v.outcome ?? "?")} <span class="dim small">${esc(v.rootCause ?? "")}</span></td>
      <td class="mono">${r.jev ? `${esc(r.jev.outcome)} <span class="dim small">${esc(r.jev.rootCause)}</span>` : r.jevError ? `<span class="bad small">${esc(r.jevError)}</span>` : `<span class="dim">—</span>`}</td>
      <td>${r.agreement ? check(r.agreement.outcome) : `<span class="dim">—</span>`}</td>
    </tr>`;
      },
    )
    .join("");

  const s = j.scores ?? {};
  const cost = j.jevRun
    ? `${j.jevRun.calls} call(s), mean ${j.jevRun.meanLatencyMs}ms, ${j.jevRun.inputTokens} input tokens, ≈$${j.jevRun.estimatedUsd} total (≈$${j.jevRun.perTraceUsd}/trace, output free), model ${esc(j.jevRun.model)}`
    : "rule-based judge only — nothing was called, nothing was spent.";

  return `
<section>
  <h2>Batch trace triage</h2>
  <p class="lede">
    The same trace judge pointed at captured traces instead of synthetic scenarios — the shape
    production triage takes. Scores are deterministic (trace + manifest, never a model); verdicts
    come from the rule engine, plus Jev when configured.
  </p>
  <div class="mode-note ${esc(j.mode)}"><b>${esc(j.mode)}</b> — ${esc(j.$note)}</div>
  <div class="facts">
    ${fact("judged", `${j.counts?.judged ?? 0}/${j.counts?.files ?? 0} traces`)}
    ${fact("score median", s.median === null || s.median === undefined ? "—" : String(s.median))}
    ${fact("below 50", String(s.below50 ?? 0))}
    ${fact("Jev errors", String(j.counts?.jevErrors ?? 0))}
    ${fact("open incidents asked", String(j.incidents?.open ?? 0))}
  </div>
  <table>
    <thead><tr><th>trace</th><th>profile</th><th class="num">Atlas score</th><th>rules</th><th>Jev</th><th>agree</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="note">Triage cost: ${cost}</p>
  <p class="source">Source: <code>${esc(rel(judge.path))}</code> · reproduce with <code>node bin/atlas.js judge</code></p>
</section>`;
}

/**
 * @param {any} s
 * @param {Date} generatedAt
 */
function provenance(s, generatedAt) {
  const env = s.matrix?.data?.environment;
  return `
<section>
  <h2>Provenance</h2>
  <p class="lede">
    Nothing on this page was typed in by a human. Every metric was read out of a trace JSON
    written by the harness at capture time; this page is a rendering of those files and nothing
    else. If a section is missing, it is because the stage did not run.
  </p>
  <table class="kv">
    <tr><td>page generated</td><td class="mono">${esc(generatedAt.toISOString())}</td></tr>
    <tr><td>matrix captured</td><td class="mono">${esc(s.matrix?.data?.startedAtIso ?? "— not run —")}${s.matrix ? ` → ${esc(s.matrix.data.finishedAtIso)} (${(s.matrix.data.wallMs / 1000).toFixed(1)}s)` : ""}</td></tr>
    <tr><td>node</td><td class="mono">${esc(env?.node ?? process.version)} on ${esc(env?.platform ?? `${process.platform}-${process.arch}`)}</td></tr>
    <tr><td>browser</td><td class="mono">${esc(env?.chromeProduct ?? "—")}</td></tr>
    <tr><td>headless</td><td class="mono">${env ? String(env.headless) : "—"}</td></tr>
    <tr><td>manifest hash</td><td class="mono">${esc(s.matrix?.data?.manifest?.contentHash ?? orbitalManifest.contentHash)}</td></tr>
    <tr><td>seed</td><td class="mono">${s.matrix ? `0x${Number(s.matrix.data.seed).toString(16)}` : "—"}</td></tr>
    <tr><td>decision engine</td><td class="mono">${esc(s.matrix?.data?.engine?.status ?? "—")}</td></tr>
  </table>

  <h3>Reproduce the whole thing</h3>
  <pre><code>git clone &lt;repo&gt; &amp;&amp; cd atlas-replay-lab
node bin/atlas.js doctor
node bin/atlas.js all</code></pre>
  <p class="note">
    No dependencies to install, no API key, no network access beyond localhost. Chrome (or
    Chromium, or Edge) must be installed; set <code>ATLAS_CHROME</code> if detection fails.
  </p>
</section>

<footer>
  <p>
    Atlas Replay Lab — an independent demo. Not affiliated with, endorsed by, or integrated with
    Flam or TypeSafe AI. Every vendor figure quoted here is attributed to its vendor and has not
    been independently verified by this project.
  </p>
</footer>`;
}

/* ── small renderers ─────────────────────────────────────────────────────── */

/** @param {string} title @param {string} command @param {string} why */
function notRun(title, command, why) {
  return `
<section>
  <h2>${esc(title)}</h2>
  <div class="not-run">
    <p><b>Not run.</b> ${esc(why)}</p>
    <pre><code>${esc(command)}</code></pre>
  </div>
</section>`;
}

/** @param {string} label @param {string} value */
function fact(label, value) {
  return `<div class="fact"><dt>${esc(label)}</dt><dd class="mono">${esc(value)}</dd></div>`;
}

/**
 * @param {string} label
 * @param {number | null} before
 * @param {number | null} after
 * @param {"ms" | "B" | "ratio"} unit
 * @param {number} [budget]
 */
function metricRow(label, before, after, unit, budget) {
  const fmt = unit === "B" ? bytes : unit === "ratio" ? ratio : ms;
  const delta =
    before === null || after === null
      ? null
      : before === 0
        ? null
        : (after - before) / before;

  return `<tr>
      <td>${esc(label)}${budget !== undefined ? ` <span class="dim small">budget ${fmt(budget)}</span>` : ""}</td>
      <td class="num">${fmt(before)}</td>
      <td class="num">${fmt(after)}</td>
      <td class="num ${delta === null ? "" : delta < -0.02 ? "better" : delta > 0.02 ? "worse" : ""}">${
        delta === null ? "—" : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`
      }</td>
    </tr>`;
}

/** @param {any} verdict */
function verdictPill(verdict) {
  if (!verdict) return `<span class="pill dim">none</span>`;
  const outcome = verdict.outcome.value;
  const cls = outcome === "pass" ? "ok" : outcome === "fail" ? "block" : outcome === "inconclusive" ? "warn" : "degraded";
  const cause = verdict.rootCause.value;
  return `<span class="pill ${cls}">${esc(outcome)}</span>${
    cause && cause !== "unknown" ? `<div class="small dim">${esc(cause)}</div>` : ""
  }`;
}

/** @param {boolean | null | undefined} v */
function check(v) {
  if (v === null || v === undefined) return `<span class="dim" title="not measured">—</span>`;
  return v ? `<span class="ok">✓</span>` : `<span class="bad">✗</span>`;
}

/** @param {number | null | undefined} v @param {number} budget */
function overBudget(v, budget) {
  return v !== null && v !== undefined && v > budget ? "worse" : "";
}

/** @param {number | null | undefined} v */
function ms(v) {
  return v === null || v === undefined ? "—" : `${Math.round(v)}<span class="unit">ms</span>`;
}

/** @param {number | null | undefined} v */
function bytes(v) {
  if (v === null || v === undefined) return "—";
  if (v >= 1_048_576) return `${(v / 1_048_576).toFixed(2)}<span class="unit">MB</span>`;
  return `${(v / 1024).toFixed(0)}<span class="unit">KB</span>`;
}

/** @param {number | null | undefined} v */
function ratio(v) {
  return v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}<span class="unit">%</span>`;
}

/** @param {number | null} v */
function pct(v) {
  return v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

/** @param {unknown} v */
function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** @param {string} file */
function rel(file) {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

/* ── style ───────────────────────────────────────────────────────────────── */

const CSS = `
:root {
  --bg: #0d1017; --panel: #141922; --line: #232b38; --text: #dfe5ee; --dim: #8b97ab;
  --ok: #4ec9a0; --bad: #ff6b6b; --warn: #f0b429; --accent: #6ba4ff; --degraded: #b58cf0;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 1100px; margin: 0 auto; padding: 40px 24px 80px; }
section { margin: 0 0 56px; }
h1 { font-size: 40px; line-height: 1.1; margin: 8px 0 16px; letter-spacing: -0.02em; }
h2 { font-size: 22px; margin: 0 0 14px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
h3 { font-size: 15px; margin: 28px 0 10px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.06em; }
p { margin: 0 0 12px; }
a { color: var(--accent); }
code, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 0.92em; }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; overflow-x: auto; }
pre code { font-size: 13px; }

.eyebrow { color: var(--dim); text-transform: uppercase; letter-spacing: 0.14em; font-size: 12px; margin: 0; }
.lede { font-size: 16px; color: #c3ccda; max-width: 76ch; }
.small { font-size: 12px; }
.dim { color: var(--dim); }
.ok { color: var(--ok); }
.bad { color: var(--bad); }
.better { color: var(--ok); }
.worse { color: var(--bad); }
.unit { color: var(--dim); font-size: 0.8em; margin-left: 1px; }
.note { color: var(--dim); font-size: 13px; max-width: 86ch; }
.warning { color: var(--warn); font-size: 13px; max-width: 86ch; }
.source { color: var(--dim); font-size: 12px; margin-top: 14px; }

.hero { padding-bottom: 8px; }
.facts { display: flex; flex-wrap: wrap; gap: 8px 28px; margin-top: 20px; padding: 16px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.fact dt { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
.fact dd { margin: 2px 0 0; font-size: 13px; }

.disclaimers { display: grid; gap: 12px; }
.disclaimer { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--warn); border-radius: 6px; padding: 14px 18px; }
.disclaimer h3 { margin: 0 0 6px; color: var(--warn); text-transform: none; letter-spacing: 0; font-size: 14px; }
.disclaimer p { margin: 0; font-size: 13px; color: #b9c3d3; }

.verdict { display: flex; align-items: baseline; gap: 18px; padding: 18px 22px; border-radius: 8px; margin-bottom: 14px; }
.verdict.ship { background: rgba(78,201,160,0.09); border: 1px solid rgba(78,201,160,0.35); }
.verdict.hold { background: rgba(255,107,107,0.09); border: 1px solid rgba(255,107,107,0.35); }
.verdict-word { font-size: 30px; font-weight: 700; letter-spacing: 0.04em; }
.verdict.ship .verdict-word { color: var(--ok); }
.verdict.hold .verdict-word { color: var(--bad); }
.verdict-counts { color: var(--dim); font-size: 13px; }
.rule { font-size: 14px; color: #c3ccda; max-width: 86ch; }

table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
th { text-align: left; color: var(--dim); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; padding: 8px 10px; border-bottom: 1px solid var(--line); }
td { padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:hover { background: rgba(255,255,255,0.02); }
.baseline-row { background: rgba(255,107,107,0.05); }
.run-id { font-weight: 600; }
table.kv td:first-child { color: var(--dim); width: 190px; white-space: nowrap; }

.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: 0.03em; }
.pill.ok { background: rgba(78,201,160,0.15); color: var(--ok); }
.pill.block { background: rgba(255,107,107,0.15); color: var(--bad); }
.pill.warn { background: rgba(240,180,41,0.15); color: var(--warn); }
.pill.degraded { background: rgba(181,140,240,0.15); color: var(--degraded); }
.pill.info, .pill.dim { background: rgba(139,151,171,0.15); color: var(--dim); }
tr.sev-block td { background: rgba(255,107,107,0.04); }

.story { display: grid; grid-template-columns: 1fr auto 1fr; gap: 16px; align-items: stretch; margin: 18px 0; }
.story-half { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px 18px; }
.story-half.fail { border-left: 3px solid var(--bad); }
.story-half.pass { border-left: 3px solid var(--ok); }
.story-half h3 { margin: 0 0 8px; color: var(--text); text-transform: none; letter-spacing: 0; font-size: 14px; }
.story-arrow { display: flex; align-items: center; color: var(--dim); font-size: 22px; }
.outcome { font-weight: 600; font-size: 15px; margin: 10px 0; }
.outcome.ok { color: var(--ok); }
.outcome.bad { color: var(--bad); }
.checks { list-style: none; padding: 0; margin: 0; font-size: 13px; color: var(--dim); }
.checks li { padding: 1px 0; }

.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; margin: 14px 0; }
.shots figure { margin: 0; }
.shots figcaption { font-size: 11px; color: var(--dim); margin-bottom: 6px; font-family: ui-monospace, monospace; }
.shots img { width: 100%; border: 1px solid var(--line); border-radius: 4px; background: #000; display: block; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }

.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px 20px; margin-bottom: 16px; }
.card-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.card-head h3 { margin: 0; color: var(--text); text-transform: none; letter-spacing: 0; font-size: 15px; }

.not-run { background: var(--panel); border: 1px dashed var(--line); border-radius: 8px; padding: 16px 20px; color: var(--dim); }
.not-run pre { margin: 10px 0 0; }

.mode-note { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 6px; padding: 12px 16px; font-size: 13px; color: #b9c3d3; margin: 12px 0 20px; }
.mode-note.jev-fixture { border-left-color: var(--warn); }

details { margin: 10px 0; }
summary { cursor: pointer; color: var(--accent); font-size: 13px; }

footer { border-top: 1px solid var(--line); padding-top: 18px; color: var(--dim); font-size: 12px; max-width: 86ch; }

@media (max-width: 760px) {
  .story { grid-template-columns: 1fr; }
  .story-arrow { justify-content: center; transform: rotate(90deg); }
}
`;
