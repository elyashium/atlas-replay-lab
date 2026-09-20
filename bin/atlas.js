#!/usr/bin/env node
/**
 * Atlas Replay Lab — the one entry point.
 *
 * Everything this project can do is a subcommand here, so that "how do I run
 * it" has a single answer and the README can quote real commands rather than
 * describing a procedure. The headline is:
 *
 *     node bin/atlas.js all
 *
 * which runs the six-profile matrix, replays the failing and the fixed
 * sessions, applies the release rule, runs the §4.4 engine comparison, and
 * renders one HTML report — from a fresh clone, with no arguments, no API key
 * and no dependencies to install.
 *
 * ## Design notes
 *
 * **Argument parsing is hand-rolled.** `node:util`'s `parseArgs` would do it,
 * but it is still marked experimental on the oldest Node this project supports,
 * and its unknown-option error ("Unknown option '--porfile'") is worse than the
 * one below. Forty lines buys a suggestion for a misspelled flag and a usage
 * block per command, which is most of what a CLI is for.
 *
 * **Exit codes are meaningful.** `gate` and `all` exit 1 when the release rule
 * says hold. That is the entire point of a gate: a CI job that cannot fail is
 * decoration. Harness errors also exit 1, but print differently — a gate that
 * held and a runner that crashed are not the same event, and the output says
 * which one happened.
 *
 * **No command silently needs a key.** Every path here works with the
 * rule-based engine and zero configuration. `TYPESAFE_API_KEY` and
 * `ATLAS_JEV_FIXTURES=1` change what runs; their absence never fails a command.
 */

import path from "node:path";
import { existsSync } from "node:fs";

import { readJson, fromRoot } from "../src/util/fsx.js";
import { logger, banner, setLogLevel } from "../src/util/log.js";

const log = logger("atlas");

/** Matches the `engines` field in package.json. Checked before anything else. */
const MIN_NODE = [18, 17, 0];

/**
 * Set by `--verbose`/`--quiet`. The log level itself lives in util/log.js, but
 * two things here need to know independently: whether to print a stack trace on
 * a crash, and whether to suppress the report tables, which are written to
 * stdout directly rather than through the logger (they are tables, not log
 * lines, and threading them through a level-filtered logger would mangle them).
 */
let verbose = process.env.ATLAS_LOG_LEVEL === "debug";
let quiet = false;

/* ── commands ────────────────────────────────────────────────────────────── */

/**
 * @typedef {object} Command
 * @property {string} summary        one line, shown in the top-level help
 * @property {string} usage          the argument line, shown in `--help`
 * @property {string} [detail]       a paragraph, shown in `<cmd> --help`
 * @property {Record<string, FlagSpec>} flags
 * @property {(args: ParsedArgs) => Promise<number | void>} run
 *
 * @typedef {{ type: "string" | "number" | "boolean" | "list"; describe: string; value?: string }} FlagSpec
 * @typedef {{ flags: Record<string, any>; positional: string[] }} ParsedArgs
 */

/** @type {Record<string, Command>} */
const COMMANDS = {
  all: {
    summary: "matrix → replay → gate → compare → report (the one command)",
    usage: "atlas all [--seed <n>] [--profile <id>]... [--no-replay]",
    detail:
      "Runs the whole pipeline end to end and leaves a complete artifacts/ directory behind.\n" +
      "Exits 1 if the release gate holds. Assets are generated on demand if missing.",
    flags: {
      seed: { type: "number", describe: "override the capture seed (hex or decimal)" },
      profile: { type: "list", describe: "restrict the matrix to these profile ids (repeatable)" },
      "no-replay": { type: "boolean", describe: "skip the replay stage" },
    },
    async run(args) {
      const { runMatrix } = await import("../src/runner/run-matrix.js");
      const { runReplay } = await import("../src/runner/run-replay.js");
      const { runGate } = await import("../src/gate/release-gate.js");
      const { runComparison } = await import("../src/report/engine-comparison.js");
      const { renderReport } = await import("../src/report/html-report.js");

      const started = Date.now();

      await runMatrix({ seed: args.flags.seed, profileIds: args.flags.profile });

      if (!args.flags["no-replay"]) {
        // Both halves of the failure story are replayed, in the order the story
        // is told: first that the failure reproduces exactly, then that the fix
        // does. Replaying only the fixed run would leave "the baseline failed"
        // as an assertion rather than a reproducible fact.
        await runReplay({ profileId: "low-cpu-3g", baseline: true });
        await runReplay({ profileId: "low-cpu-3g" });
      }

      const gate = await runGate({ quiet });
      await runComparison({ quiet });
      const report = await renderReport({ quiet });

      banner("done");
      log.info(`${((Date.now() - started) / 1000).toFixed(1)}s total`);
      log.info(`open ${rel(report.file)}`);
      if (!gate.shipped) {
        log.error("release gate: HOLD — see the findings above. Exiting 1.");
        return 1;
      }
      log.info("release gate: SHIP");
      return 0;
    },
  },

  matrix: {
    summary: "run the six-profile capability matrix in Chrome over CDP",
    usage: "atlas matrix [--seed <n>] [--profile <id>]... [--no-baseline] [--out <dir>]",
    detail:
      "Profiles run sequentially, never in parallel: CPU throttling is a whole-browser\n" +
      "setting and two throttled renderers on one machine contend, which would make\n" +
      "every timing in the report a measurement of the harness.",
    flags: {
      seed: { type: "number", describe: "capture seed (default 0x0b17a1)" },
      profile: { type: "list", describe: "run only these profile ids (repeatable)" },
      "no-baseline": { type: "boolean", describe: "skip the router-bypassed baseline run" },
      "no-clean": { type: "boolean", describe: "keep previous artifacts in the output directory" },
      out: { type: "string", describe: "output directory (default artifacts/matrix)" },
    },
    async run(args) {
      const { runMatrix } = await import("../src/runner/run-matrix.js");
      const result = await runMatrix({
        seed: args.flags.seed,
        profileIds: args.flags.profile,
        includeBaseline: !args.flags["no-baseline"],
        clean: !args.flags["no-clean"],
        outDir: args.flags.out ? path.resolve(args.flags.out) : undefined,
      });
      // The matrix reports what happened; it does not decide whether that is
      // shippable. `gate` does, and it exits accordingly. So a matrix whose runs
      // all failed still exits 0 — it did its job, which was to find that out.
      // What does exit 1 is a run the harness *lost*, which is an absence of
      // evidence rather than a result.
      const { total, completed } = result.report.summary;
      if (completed < total) {
        log.error(`${total - completed} of ${total} run(s) did not complete; see the errors above.`);
        return 1;
      }
      return 0;
    },
  },

  replay: {
    summary: "re-run a captured trace and prove it reproduces",
    usage: "atlas replay [--trace <file>] [--profile <id>] [--baseline] [--out <dir>]",
    detail:
      "Defaults to the low-cpu-3g adaptive capture. With --baseline, replays the\n" +
      "router-bypassed failing run instead. Compares causal structure, quantised\n" +
      "timing and checkpoint pixels; see ADR-0004 for why wall-clock is not faked.",
    flags: {
      trace: { type: "string", describe: "path to a trace JSON (overrides --profile)" },
      profile: { type: "string", describe: "profile id to replay (default low-cpu-3g)" },
      baseline: { type: "boolean", describe: "replay the baseline (failing) capture" },
      "no-clean": { type: "boolean", describe: "keep previous artifacts in the output directory" },
      out: { type: "string", describe: "output directory (default artifacts/replay)" },
    },
    async run(args) {
      const { runReplay } = await import("../src/runner/run-replay.js");
      const { report } = await runReplay({
        tracePath: args.flags.trace,
        profileId: args.flags.profile,
        baseline: Boolean(args.flags.baseline),
        clean: !args.flags["no-clean"],
        outDir: args.flags.out ? path.resolve(args.flags.out) : undefined,
      });
      return report.verdict.reproduced ? 0 : 1;
    },
  },

  gate: {
    summary: "apply the release rule to the captured matrix report",
    usage: "atlas gate [--matrix <file>] [--replay <file>|none] [--out <dir>]",
    detail:
      "Reads what was captured; runs no browser. Exits 1 on HOLD.\n" +
      "The rule itself is stated in full at the top of src/gate/release-gate.js.",
    flags: {
      matrix: { type: "string", describe: "matrix report path (default artifacts/matrix/report.json)" },
      replay: { type: "string", describe: "replay report path, or 'none' to skip rule 7" },
      out: { type: "string", describe: "output directory (default artifacts/gate)" },
    },
    async run(args) {
      const { runGate } = await import("../src/gate/release-gate.js");
      const { shipped } = await runGate({
        matrixReportPath: args.flags.matrix ? path.resolve(args.flags.matrix) : undefined,
        replayReportPath: args.flags.replay === "none" ? null : args.flags.replay,
        outDir: args.flags.out ? path.resolve(args.flags.out) : undefined,
        quiet,
      });
      return shipped ? 0 : 1;
    },
  },

  compare: {
    summary: "§4.4 — run every fixture through both decision engines",
    usage: "atlas compare [--out <dir>]",
    detail:
      "Runs end to end with no key, reporting 'agreement N/A — no live Jev key'.\n" +
      "Set ATLAS_JEV_FIXTURES=1 to exercise the Jev path against hand-authored\n" +
      "fixtures, or TYPESAFE_API_KEY to compare against a live deployment.\n" +
      "Always exits 0: a disagreement between two engines is a finding, not an error.",
    flags: {
      out: { type: "string", describe: "output directory (default artifacts/compare)" },
    },
    async run(args) {
      const { runComparison } = await import("../src/report/engine-comparison.js");
      await runComparison({ outDir: args.flags.out ? path.resolve(args.flags.out) : undefined, quiet });
      return 0;
    },
  },

  report: {
    summary: "render artifacts/report.html from whatever is on disk",
    usage: "atlas report [--out <file>]",
    detail:
      "Reads the matrix, replay, gate and comparison reports and renders one\n" +
      "self-contained HTML page. Missing sections are stated as missing rather\n" +
      "than omitted, so the page cannot imply a stage ran when it did not.",
    flags: {
      out: { type: "string", describe: "output file (default artifacts/report.html)" },
    },
    async run(args) {
      const { renderReport } = await import("../src/report/html-report.js");
      const { file } = await renderReport({
        outFile: args.flags.out ? path.resolve(args.flags.out) : undefined,
        quiet,
      });
      log.info(`open ${rel(file)}`);
      return 0;
    },
  },

  assets: {
    summary: "regenerate the deterministic demo assets",
    usage: "atlas assets",
    detail:
      "Textures and geometry are generated to hit the byte budgets the manifest\n" +
      "declares, so the cost model and the wire agree. The matrix does this\n" +
      "automatically when the files are missing; run it by hand after editing\n" +
      "the manifest's asset sizes.",
    flags: {},
    async run() {
      const { generateAssets } = await import("../scripts/generate-assets.js");
      await generateAssets();
      return 0;
    },
  },

  fixtures: {
    summary: "rebuild the illustrative Jev fixture file",
    usage: "atlas fixtures",
    detail:
      "Fixture keys are sha256 over the exact request, so they change whenever the\n" +
      "manifest, the asset sizes or a single word of question criteria changes.\n" +
      "The fixtures are hand-authored and ILLUSTRATIVE — they are not captured\n" +
      "Jev responses, and nothing computed from them measures Jev.",
    flags: {},
    async run() {
      await import("../scripts/build-fixtures.js");
      return 0;
    },
  },

  serve: {
    summary: "serve the experience locally with the live control plane",
    usage: "atlas serve [--port <n>]",
    detail:
      "Open the printed URL in a real browser to drive the experience by hand.\n" +
      "The tier router runs on every load, exactly as it does under the matrix;\n" +
      "traces land in artifacts/live-traces/. Ctrl-C to stop.",
    flags: {
      port: { type: "number", describe: "port to listen on (default: an ephemeral one)" },
    },
    async run(args) {
      const { orbitalManifest } = await import("../src/manifest/atlas-orbital.manifest.js");
      const { selectEngine } = await import("../src/decision/index.js");
      const { startServer } = await import("../src/runner/server.js");

      const selection = await selectEngine({ env: process.env, allowFixture: true });
      const server = await startServer({
        manifest: orbitalManifest,
        engine: selection.engine,
        emulated: false,
        port: args.flags.port,
      });

      banner("Atlas Replay Lab — local");
      log.info(selection.status);
      log.info(`experience:  ${server.origin}/`);
      log.info(`manifest:    ${server.origin}/api/manifest`);
      log.info("traces are written to artifacts/live-traces/ as sessions end.");
      log.info("Ctrl-C to stop.");

      await new Promise((resolve) => {
        const stop = () => {
          process.stdout.write("\n");
          log.info(
            `served ${server.stats.requests} requests, routed ${server.stats.decisions} decisions, ` +
              `received ${server.stats.tracesReceived} traces`,
          );
          server.close().then(resolve, resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    },
  },

  doctor: {
    summary: "check that this machine can run the matrix",
    usage: "atlas doctor",
    detail:
      "Checks Node, the browser, the manifest, the generated assets and the\n" +
      "decision engine selection. Exits 1 if anything would stop `atlas all`.",
    flags: {},
    async run() {
      return doctor();
    },
  },
};

/* ── doctor ──────────────────────────────────────────────────────────────── */

/**
 * The environment check.
 *
 * It launches a real browser rather than only looking for the executable,
 * because "Chrome is installed" and "Chrome starts, speaks CDP and reports a
 * version on this machine" are different claims, and only the second one
 * predicts whether the matrix will run. Corporate policy, a stale sandbox and a
 * missing shared library all pass the first check and fail the second.
 */
async function doctor() {
  banner("atlas doctor");

  /** @type {Array<{ status: "ok" | "warn" | "fail"; label: string; detail: string }>} */
  const checks = [];
  /** @param {"ok"|"warn"|"fail"} status @param {string} label @param {string} detail */
  const add = (status, label, detail) => checks.push({ status, label, detail });

  add(
    nodeOk() ? "ok" : "fail",
    "node",
    `${process.version} on ${process.platform}/${process.arch} (need ≥ ${MIN_NODE.join(".")})`,
  );

  // Manifest.
  try {
    const { orbitalManifest } = await import("../src/manifest/atlas-orbital.manifest.js");
    const { validateManifest } = await import("../src/manifest/validate.js");
    const v = validateManifest(orbitalManifest);
    const errors = v.issues.filter((i) => i.severity === "error");
    const warnings = v.issues.filter((i) => i.severity === "warning");
    add(
      v.ok ? (warnings.length ? "warn" : "ok") : "fail",
      "manifest",
      v.ok
        ? `${orbitalManifest.id}@${orbitalManifest.version} (${orbitalManifest.contentHash})` +
            (warnings.length ? ` — ${warnings.length} warning(s)` : "")
        : errors.map((i) => `${i.path}: ${i.message}`).join("; "),
    );

    // Assets: declared in the manifest, so checked against it rather than
    // against a hardcoded list that would drift.
    const missing = [];
    for (const tier of orbitalManifest.tiers) {
      for (const asset of tier.assets) {
        if (!existsSync(path.join(fromRoot("experience"), asset.url))) missing.push(asset.url);
      }
    }
    add(
      missing.length ? "warn" : "ok",
      "assets",
      missing.length
        ? `${missing.length} missing (generated automatically on the next run): ${missing.slice(0, 3).join(", ")}…`
        : "all declared assets present",
    );
  } catch (err) {
    add("fail", "manifest", message(err));
  }

  // Decision engines. Both are constructed, because "the module imports" and
  // "the engine can be built" are different failures.
  try {
    const { selectEngine } = await import("../src/decision/index.js");
    const selection = await selectEngine({ env: process.env, allowFixture: true, quiet: true });
    add("ok", "engine", selection.status);
    if (selection.mode === "rule-based") {
      add("ok", "jev", "not configured — the rule engine runs everything. This is the default posture.");
    } else {
      add(
        selection.mode === "jev-live" ? "ok" : "warn",
        "jev",
        selection.mode === "jev-live"
          ? "live transport configured (TYPESAFE_API_KEY is set)"
          : "fixture transport — answers are hand-authored and illustrative, not Jev's",
      );
    }
  } catch (err) {
    add("fail", "engine", message(err));
  }

  // Browser. The expensive check, and the one that actually matters.
  try {
    const { launchBrowser } = await import("../src/runner/cdp.js");
    const browser = await launchBrowser();
    try {
      const version = await browser.connection.send("Browser.getVersion");
      add("ok", "browser", `${version.product} — ${browser.executable}`);
      add("ok", "cdp", `connected (${version.protocolVersion ?? "unknown protocol"})`);
    } finally {
      await browser.close();
    }
  } catch (err) {
    add("fail", "browser", `${message(err)}\n      Set ATLAS_CHROME to a Chromium-family executable to override detection.`);
  }

  // Artifacts directory must be writable; a read-only checkout fails late and
  // confusingly otherwise (six minutes into a matrix run).
  try {
    const { writeJson } = await import("../src/util/fsx.js");
    const probe = fromRoot("artifacts", ".doctor-probe.json");
    await writeJson(probe, { ok: true, at: new Date().toISOString() });
    add("ok", "artifacts", `writable — ${rel(fromRoot("artifacts"))}`);
  } catch (err) {
    add("fail", "artifacts", `cannot write to artifacts/: ${message(err)}`);
  }

  const width = Math.max(...checks.map((c) => c.label.length));
  for (const c of checks) {
    const line = `${c.status.toUpperCase().padEnd(4)}  ${c.label.padEnd(width)}  ${c.detail}`;
    if (c.status === "fail") log.error(line);
    else if (c.status === "warn") log.warn(line);
    else log.info(line);
  }

  const failed = checks.filter((c) => c.status === "fail").length;
  banner(failed ? "NOT READY" : "READY");
  if (failed) {
    log.error(`${failed} check(s) would stop \`atlas all\`.`);
    return 1;
  }
  log.info("run: node bin/atlas.js all");
  return 0;
}

/* ── argument parsing ────────────────────────────────────────────────────── */

/**
 * @param {string[]} argv
 * @param {Record<string, FlagSpec>} spec
 * @returns {ParsedArgs}
 */
function parseArgs(argv, spec) {
  /** @type {Record<string, any>} */
  const flags = {};
  /** @type {string[]} */
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("-")) {
      positional.push(token);
      continue;
    }

    // `--flag=value` and `--flag value` are both accepted; the first is what
    // people type from memory, the second is what they copy out of help text.
    const eq = token.indexOf("=");
    const name = (eq === -1 ? token : token.slice(0, eq)).replace(/^--?/, "");
    const inline = eq === -1 ? null : token.slice(eq + 1);

    if (name === "help" || name === "h") {
      flags.help = true;
      continue;
    }
    const flagSpec = spec[name];
    if (!flagSpec) {
      const suggestion = nearest(name, Object.keys(spec));
      throw new UsageError(
        `unknown option "--${name}"` + (suggestion ? `. Did you mean "--${suggestion}"?` : ""),
      );
    }

    if (flagSpec.type === "boolean") {
      if (inline !== null && inline !== "true" && inline !== "false") {
        throw new UsageError(`"--${name}" is a switch and takes no value (got "${inline}")`);
      }
      flags[name] = inline !== "false";
      continue;
    }

    const value = inline !== null ? inline : argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`"--${name}" needs a value (${flagSpec.describe})`);
    }

    if (flagSpec.type === "number") {
      // 0x… is accepted because the seed is written in hex everywhere else in
      // this project, and typing the decimal of 0x0b17a1 is nobody's idea of
      // reproducibility.
      const parsed = /^0x[0-9a-f]+$/i.test(value) ? Number.parseInt(value, 16) : Number(value);
      if (!Number.isFinite(parsed)) throw new UsageError(`"--${name}" expects a number, got "${value}"`);
      flags[name] = parsed;
    } else if (flagSpec.type === "list") {
      (flags[name] ??= []).push(...value.split(",").filter(Boolean));
    } else {
      flags[name] = value;
    }
  }

  return { flags, positional };
}

class UsageError extends Error {}

/**
 * Levenshtein distance, used only to suggest a flag. Small enough to inline and
 * not worth a dependency — this project has none, deliberately.
 *
 * @param {string} input
 * @param {string[]} candidates
 */
function nearest(input, candidates) {
  let best = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const d = distance(input, candidate);
    if (d < bestScore) {
      bestScore = d;
      best = candidate;
    }
  }
  // A threshold of 3 stops "--wat" suggesting "--out".
  return bestScore <= Math.min(3, Math.max(1, input.length - 1)) ? best : null;
}

/** @param {string} a @param {string} b */
function distance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

/* ── help ────────────────────────────────────────────────────────────────── */

/** @param {string} [version] */
function printRootHelp(version) {
  process.stdout.write(
    [
      `Atlas Replay Lab${version ? ` v${version}` : ""} — adaptive WebAR delivery, adversarially tested.`,
      "",
      "  node bin/atlas.js <command> [options]",
      "",
      "Commands:",
      ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(9)} ${c.summary}`),
      "",
      "Global options:",
      "  --verbose        debug-level logging",
      "  --quiet          warnings and errors only",
      "  --version        print the version and exit",
      "  --help           this, or per-command help after a command name",
      "",
      "Environment:",
      "  TYPESAFE_API_KEY     enables the live JevDecisionEngine. Absent by default;",
      "                       nothing here requires it.",
      "  ATLAS_JEV_FIXTURES=1 runs the Jev code path against hand-authored fixtures.",
      "  ATLAS_CHROME         path to a Chromium-family browser, if detection fails.",
      "  ATLAS_HEADFUL=1      run the browser visibly (useful while debugging a profile).",
      "",
      "Start with:  node bin/atlas.js doctor",
      "",
    ].join("\n"),
  );
}

/** @param {string} name @param {Command} command */
function printCommandHelp(name, command) {
  const lines = [`${command.summary}`, "", `  ${command.usage}`, ""];
  if (command.detail) lines.push(command.detail, "");
  const entries = Object.entries(command.flags);
  if (entries.length) {
    const width = Math.max(...entries.map(([f]) => f.length));
    lines.push("Options:");
    for (const [flag, spec] of entries) {
      const arg = spec.type === "boolean" ? "" : spec.type === "list" ? " <a,b>" : " <value>";
      lines.push(`  --${(flag + arg).padEnd(width + 8)} ${spec.describe}`);
    }
    lines.push("");
  }
  process.stdout.write(lines.join("\n"));
}

/* ── plumbing ────────────────────────────────────────────────────────────── */

function nodeOk() {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  const [wMajor, wMinor, wPatch] = MIN_NODE;
  if (major !== wMajor) return major > wMajor;
  if (minor !== wMinor) return minor > wMinor;
  return patch >= wPatch;
}

/** @param {unknown} err */
function message(err) {
  return err instanceof Error ? err.message : String(err);
}

/** @param {string} file */
function rel(file) {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

async function readVersion() {
  try {
    const pkg = await readJson(fromRoot("package.json"));
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/* ── entry ───────────────────────────────────────────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);

  // Global switches are stripped before the command sees anything, so
  // `atlas matrix --verbose` and `atlas --verbose matrix` both work.
  const rest = [];
  let wantsHelp = false;
  let wantsVersion = false;
  for (const token of argv) {
    if (token === "--verbose" || token === "--debug") {
      setLogLevel("debug");
      verbose = true;
    } else if (token === "--quiet" || token === "-q") {
      setLogLevel("warn");
      quiet = true;
    } else if (token === "--version" || token === "-V") wantsVersion = true;
    else if (token === "--help" || token === "-h") wantsHelp = true;
    else rest.push(token);
  }

  if (wantsVersion) {
    process.stdout.write(`${(await readVersion()) ?? "unknown"}\n`);
    return 0;
  }

  const name = rest.shift();
  if (!name) {
    printRootHelp(await readVersion());
    return wantsHelp ? 0 : 1;
  }

  const command = COMMANDS[name];
  if (!command) {
    const suggestion = nearest(name, Object.keys(COMMANDS));
    log.error(`unknown command "${name}"` + (suggestion ? `. Did you mean "${suggestion}"?` : ""));
    printRootHelp(await readVersion());
    return 1;
  }

  if (wantsHelp) {
    printCommandHelp(name, command);
    return 0;
  }

  // Checked here rather than at import time so that `--help` and `--version`
  // still work on an unsupported Node, which is exactly when someone is trying
  // to find out what this needs.
  if (!nodeOk()) {
    log.error(
      `Node ${process.versions.node} is too old; this needs ≥ ${MIN_NODE.join(".")}. ` +
        "It uses only the standard library, but a recent one.",
    );
    return 1;
  }

  const args = parseArgs(rest, command.flags);
  if (args.flags.help) {
    printCommandHelp(name, command);
    return 0;
  }

  const code = await command.run(args);
  return typeof code === "number" ? code : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    if (err instanceof UsageError) {
      log.error(err.message);
      log.error("run `node bin/atlas.js <command> --help` for usage.");
    } else {
      log.error(message(err));
      // The stack is the useful half when the harness itself broke, and noise
      // when the user typed something wrong — so it follows the log level.
      if (err instanceof Error && err.stack && verbose) {
        process.stderr.write(`${err.stack}\n`);
      }
    }
    process.exitCode = 1;
  });
