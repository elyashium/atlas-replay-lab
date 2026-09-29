# Atlas Replay Lab

A small WebAR-style experience that **degrades on purpose**, a six-profile
adversarial device matrix that tries to break it, a privacy-safe flight recorder,
deterministic replay, a release gate that can actually say *hold* — and a
decision layer with two implementations behind one interface.

```bash
node bin/atlas.js doctor && node bin/atlas.js all
```

No dependencies. No API key. No build step. Node ≥ 18.17 and an installed Chrome
or Edge.

---



## What it actually does

Seven things, each of which is a real artifact on disk after one command:

1. **Serves a capability-aware experience.** Three quality tiers and three
   delivery paths (`camera-xr` → `interactive-2d` → `static-safe`), declared in
   one validated, content-hashed manifest rather than scattered across
   conditionals. [ADR-0003](docs/adr/0003-manifest-as-contract.md)

2. **Attacks it across six profiles** in real Chrome over CDP — CPU throttling,
   network shaping, packet loss, denied camera permission, absent WebGL.

3. **Records a privacy-safe trace** of every session: state transitions,
   asset timings, interaction latencies, checkpoint screenshots. No raw camera
   frames, no raw audio, no wall-clock timestamps inside the event stream, ever.
   [Trace schema](docs/trace-schema.md) · [PRIVACY.md](PRIVACY.md)

4. **Replays a captured session and proves it reproduces** — causal structure,
   quantised timing, and perceptual pixel comparison, with the clock left
   alone. [ADR-0004](docs/adr/0004-determinism-model.md)

5. **Applies a release rule** to what was captured, and exits non-zero when the
   rule says hold — including a deterministic 0–100 Atlas score floor per
   critical profile. A gate that cannot fail is decoration.

6. **Predicts before running** (`atlas preflight --url`): sizes a page's
   assets by header without executing anything, and says which tier the
   weight points at. The matrix then confirms or refutes.

7. **Diagnoses what failed** (`atlas findings`): attaches the failing step, the
   trace slice around the failure, the scrubbed console/network categories, the
   artifacts and the release rule in force to each failed run. Observations name
   the field they were read from; inferred causes name the rule that fired; the
   suggested-changes list is always empty, because suggesting fixes is not
   implemented and an empty list is an honest record of that.

## The decision layer

Three decisions in the system are judgement calls rather than calculations: which
tier to serve a given device (live, on every page load), whether a completed
session passed, degraded acceptably, failed, or produced too little evidence to
say (offline, over each captured trace), and which tier a page's static weight
points at before any browser runs (preflight, over measured bytes).

Both go through one `DecisionEngine` interface with three implementations:

| | |
|---|---|
| **`RuleBasedDecisionEngine`** | The default. Zero external calls, zero API key, zero network. This is what CI runs and what a fresh clone runs. |
| **`JevDecisionEngine`** | Optional. Active only when `TYPESAFE_API_KEY` is present, or against hand-authored fixtures with `ATLAS_JEV_FIXTURES=1`. Live calls go to `POST /v1/systemone` (see `atlas jev-check`). |
| **`GuardedDecisionEngine`** | A wrapper, not an engine. Whenever a model is configured, this is what runs: it overrides on error, on infeasibility, and on low confidence, in that order — and verdicts fail closed, so a model may tighten a verdict but never loosen one. |

[ADR-0005](docs/adr/0005-decision-engine-interface.md) covers the interface and
the guard. [ADR-0006](docs/adr/0006-jev-typed-answers-only.md) covers what the
model is allowed to say.

### Comparing the two engines

```bash
node bin/atlas.js compare
```

Runs every synthetic packet and trace through **both** engines and reports the
agreement rate, plus the Jev side's measured calls/latency/tokens/cost. It runs
end to end with no key — in that state it reports
`agreement N/A — no live Jev key` rather than failing, because a harness that
requires a credential to run is a harness nobody runs.

### Judging captured traces at volume

```bash
node bin/atlas.js judge
```

Points the same trace judge at real captured traces (`artifacts/matrix`,
`artifacts/live-traces`, `artifacts/replay` by default; `--trace`/`--dir` to
override) and writes `artifacts/judge/judge-report.json`: per-trace verdicts,
outcome/root-cause tallies, agreement, and measured Jev latency/tokens/cost.
Rule-based judging always runs; Jev joins in when configured. Always exits 0 —
judging observes, `gate` decides. This is the Stage 4 production-triage shape,
already pointed at a trace stream.

### Waking up the live Jev path

```bash
export TYPESAFE_API_KEY=<key from console.typesafe.ai/settings/keys>
node bin/atlas.js jev-check
```

Validates the key (`GET /v1/models`) and sends one minimal smoke decision,
reporting latency, input tokens, and the versioned model id that answered
(`jev-latest` currently resolves to `jev-1.13.0`). Every other command picks up
the key automatically once set; `TYPESAFE_MODEL` pins the model id (pin a
versioned id once thresholds are tuned — aliases move), `TYPESAFE_BASE_URL`
points at a gateway instead, `TYPESAFE_TIMEOUT_MS` overrides the 4s default.
`atlas doctor` keeps passing without a key; only `jev-check` requires one.

### Predicting before running: preflight

```bash
node bin/atlas.js preflight --url <https://…>
```

Fetches a page, sizes its assets by header (nothing is downloaded or executed),
and assesses which tier the weight points at — the prediction `atlas matrix
--url` then confirms or refutes. Rules always; Jev joins in when configured.
Private hosts are refused unless `ATLAS_PREFLIGHT_ALLOW_PRIVATE=1`. Always
exits 0: preflight predicts, the matrix decides. Static weight only — decode
cost, render cost, and runtime behavior are invisible here by construction.

## Jev: what is claimed, and by whom

The optional model is **Jev**, TypeSafe AI's "System One" model. It answers in a
fixed vocabulary — Choice, Score, Noul — and has no string channel at all.

Every performance characteristic below is **TypeSafe's own published claim**, not
a measurement made here:

- *TypeSafe reports* latencies in the 70–500ms range.
- *TypeSafe reports* a context budget around 32K tokens.
- *TypeSafe describes* the model as a non-autoregressive parallel sampler, so a
  batch of questions costs approximately what one question costs.
- *TypeSafe describes* it as RLCD-trained for calibration.

**What this repository independently verified:** one live run on 2026-09-22
(`jev-latest`, answered by `jev-1.13.0`): `atlas compare` over the 12 synthetic
packets + 10 synthetic traces (22/22 calls ok, mean ~490ms, 53,583 input tokens
≈ $0.0023) with outcome agreement 10/10, business-invariant agreement 10/10,
release-blocking agreement 9/10, tier agreement 1/12 — and `atlas judge` over the
10 example traces (10/10 ok, ≈ $0.00015/trace, one outcome disagreement on the
packet-loss trace). That is a smoke test on synthetic inputs (n=22), not a
calibration study, not a latency benchmark, and not an audit. Nothing here claims
Jev is production-hardened or that any company uses it. Observed latency here
(~0.5–1.3s/call) exceeded TypeSafe's published 70–500ms band on some calls.

The bundled fixtures are **hand-authored and illustrative**. They are labelled
`ILLUSTRATIVE` in the fixture file itself and in every test that consumes them.
They are not captured Jev responses, and no number computed from them measures
Jev.

## The six profiles

| id | what it emulates | why it is in the matrix |
|---|---|---|
| `high-wifi` | Desktop-class, 30Mbps | The ladder should reach `high` here or the cost model is wrong |
| `mid-android-4g` | 4GB / 8 cores, 9Mbps @ 170ms | The volume case |
| `low-cpu-3g` | 2GB / 4 cores @ 6× throttle, 1.1Mbps @ 380ms | **The failure story** |
| `packet-loss` | 4Mbps @ 300ms with 12% loss | Asset-failure handling, not raw slowness |
| `camera-denied` | Capable hardware, `videoCapture` denied | The camera path must not be attempted; checkout must still work |
| `webgl-unavailable` | `getContext('webgl')` returns null | Forces the 2D/static path; checkout must still work |

All six are treated as release-critical.

## What was emulated, and what was not

This matters more than any number in the report, so it is stated plainly:

**Real, applied by the browser:** CPU throttling
(`Emulation.setCPUThrottlingRate`), network throughput/latency/packet-loss
shaping (`Network.emulateNetworkConditions`), viewport and device-scale metrics,
touch emulation, camera permission state (`Browser.setPermission`), and WebGL
context availability.

**Injected, so the capability probe sees what a device of that class reports:**
`navigator.deviceMemory`, `navigator.hardwareConcurrency`,
`navigator.connection` (effective type, downlink, RTT), and GPU tier.

**Not tested at all:** real GPU drivers, thermal throttling and sustained-load
behaviour, actual handset performance, real radio conditions, iOS/Safari, any
non-Chromium browser, and real camera hardware.

So: this exercises the decision layer and the degrade ladder honestly, against a
real renderer on a real clock. It does **not** support any claim about "all
devices" or about how a specific handset behaves. Those need a real-device lab,
which this is not a substitute for.

## Current local proof status

The latest local run produced a failing forced-high baseline, a
degraded-but-acceptable adaptive low-CPU result, pixel-identical baseline and
adaptive replay checkpoints, and a SHIP gate. The camera-denied and no-WebGL
profiles also passed with their intended 2D fallback. These are local Chromium
emulations, not handset tests. The generated report still needs desktop/mobile
visual review, and no screen recording has been captured. See [the Phase 0
evidence record](docs/evidence/phase0-2026-09-27.md) for per-profile
measurements, commands, and limits; do not infer a hosted workflow from it.

## Commands

| | |
|---|---|
| `node bin/atlas.js doctor` | Check Node, the browser, the manifest, assets, engines. Start here. |
| `node bin/atlas.js all` | Everything: matrix → replay (Orbital only) → gate → judge → compare → diagnose → report. Exits 1 on HOLD. `--url` adds preflight, skips replay. |
| `node bin/atlas.js matrix` | The capability matrix: Orbital, `--url <href>` for a third-party page, `--glb <file>` for an uploaded model in the viewer |
| `node bin/atlas.js matrix --target <contract.json>` | Run a versioned, selector-driven journey against an explicitly authorized development/staging target; report target-policy SHIP/HOLD/INCONCLUSIVE |
| `node bin/atlas.js visual-compare --baseline <png> --actual <png>` | Compare approved/current component screenshots; write deterministic metrics and a heatmap (no release-gate effect) |
| `node bin/atlas.js visual-review --image <png> --consent-to-send-images` | Send one PNG under `artifacts/` to the configured Groq vision model for advisory suggestions |
| `node bin/atlas.js replay` | Re-run a captured trace and prove it reproduces |
| `node bin/atlas.js gate` | Apply the release rule to what was captured |
| `node bin/atlas.js diff --before <a> --after <b>` | Compare two matrix reports, and say first whether the comparison is valid |
| `node bin/atlas.js findings` | Diagnose the failed runs: failing step, trace slice, scrubbed console/network category, artifact, policy rule. Rendered into the report as **Diagnosis** |
| `node bin/atlas.js compare` | §4.4 — both engines over the same fixtures |
| `node bin/atlas.js judge` | batch-judge captured traces + Jev cost/latency |
| `node bin/atlas.js jev-check` | validate `TYPESAFE_API_KEY` with one live call |
| `node bin/atlas.js preflight --url <u>` | static pre-launch weight assessment |
| `node bin/atlas.js report` | Render `artifacts/report.html` from what is on disk |
| `node bin/atlas.js fixtures` | Write the illustrative Jev fixtures and `examples/traces/` |
| `node bin/atlas.js assets` | Generate the tier assets (`all` does this on demand) |
| `node bin/atlas.js serve` | Serve the experience locally and drive it by hand |
| `npm test` | Runs the dependency-free CLI unit suite; no network, browser, or key |

The separate Phase 2 web control-plane foundation is documented in
[the Phase 2 evidence record](docs/evidence/phase2-control-plane-2026-09-27.md).
It needs its own dependencies and local PostgreSQL; it is not a hosted service,
and its queued records do not represent browser test results. The signed-in
project view now includes optional component screenshot review and a guarded
source-code proposal flow. PNG uploads and source files require separate
explicit Groq egress consent and are not retained; report data, hashes, and
proposed diffs expire after 30 days. A proposed diff can repeat source lines.
Proposals are advisory, unapplied, and untested. Configure the server-side
`GROQ_API_KEY`; never put it in browser storage. These synchronous paths are
local-only and do not use the queued browser lane.

`node bin/atlas.js <command> --help` for flags.

### Component visual checks

Place a baseline and current component screenshot under `artifacts/`, captured
at the same browser size, component state, and test data. Compare them with:

```powershell
node bin/atlas.js visual-compare --baseline artifacts/components/baseline.png --actual artifacts/components/current.png
node bin/atlas.js report
```

The JSON report records each image hash, pixel difference, coarse perceptual
score, thresholds, and a red difference heatmap. Different image dimensions
are inconclusive. Thresholds are pairwise comparison settings, not a design
score, accessibility result, or release gate.

For an optional model suggestion pass, provide a Groq key in the process
environment and explicitly approve provider egress for that image:

```powershell
$env:GROQ_API_KEY = "<your key>"
node bin/atlas.js visual-review --image artifacts/components/current.png --consent-to-send-images
node bin/atlas.js report
```

This sends the image to Groq. Output is uncalibrated advice and does not affect
SHIP/HOLD. The image must be within `artifacts/`; inspect it for personal data
and secrets first. A single smoke request with synthetic images returned an
inconclusive result because the model omitted an issue location. The adapter
now keeps such issues unlocalized; review quality has not been evaluated.

To compare against an approved visual reference, place a same-size PNG under
`artifacts/` and supply the team criteria:

```powershell
node bin/atlas.js visual-review --image artifacts/components/current.png --reference artifacts/components/approved.png --criteria "Keep the primary action visually dominant and preserve the approved type scale." --consent-to-send-images
```

Both images and the criteria go to Groq. Findings are still suggestions, and
reported image regions refer to the current component screenshot.

To ask for a source correction proposal, place one UTF-8 component source file
under `artifacts/` and separately approve source egress. Atlas refuses common
credential-like strings, caps the source at 64 KiB, and only accepts a
single-file diff:

```powershell
node bin/atlas.js suggest-code-fix --source artifacts/components/Button.jsx --consent-to-send-code
node bin/atlas.js report
```

The source and visual findings are sent to Groq. Atlas only saves a patch
proposal; it does not apply the diff, run it, run tests, or change the release
verdict. Inspect it and verify it against the actual component before use.

### Owned staging journeys

`--url` remains generic observation. To test what a staging experience means
for your team, start with the [target contract guide](docs/target-contract.md)
and [example JSON](examples/target-contract.json). The local operator attests
authorization; the local CLI checks top-level navigation origins but does not
block browser subresource egress. Credentials are referenced through
`ATLAS_*` environment variables. Screenshots stay disabled unless consent and
redaction selectors are explicit. The built-in loopback scene is a controlled
contract exercise, not evidence from a customer app. A target report's gate
only covers its declared journey and Chromium emulation.

### Environment

| | |
|---|---|
| `TYPESAFE_API_KEY` | Enables the live `JevDecisionEngine`. Absent by default; only `jev-check` requires it. |
| `TYPESAFE_MODEL` | Model id (default `jev-latest`; pin e.g. `jev-1.13.0` once thresholds are tuned). |
| `TYPESAFE_BASE_URL` | API base override (default `https://api.typesafe.ai`). |
| `TYPESAFE_TIMEOUT_MS` | Live-call timeout (default 4000). |
| `GROQ_API_KEY` | Enables optional CLI screenshot review with its consent flag and server-side control-plane visual/code reviews with separate UI consent. |
| `ATLAS_GROQ_VISION_MODEL` | Requested visual review model (default `qwen/qwen3.8-27b`; returned model ID is recorded). |
| `ATLAS_GROQ_CODE_MODEL` | Requested patch proposal model (default `openai/gpt-oss-120b`; returned model ID is recorded). |
| `ATLAS_CODE_PROPOSAL_DAILY_LIMIT` | Local control-plane code proposal ceiling (default five per organization per UTC day; not a customer plan). |
| `ATLAS_JEV_FIXTURES=1` | Runs the Jev code path against hand-authored illustrative fixtures. |
| `ATLAS_PREFLIGHT_ALLOW_PRIVATE=1` | Let `preflight` fetch private/loopback targets (local dev only). |
| `ATLAS_CHROME` | Path to a Chromium-family browser, if detection fails. |
| `ATLAS_HEADFUL=1` | Run the browser visibly. |

Most CLI commands run without API keys. `jev-check` requires its explicit
TypeSafe key; `visual-review` and `suggest-code-fix` require `GROQ_API_KEY` only
when invoked, plus their separate image or source egress-consent flags. Atlas
does not make a model call by default.

## Layout

```
bin/atlas.js            the single entry point
experience/             the Orbital demo + the model viewer (`viewer/`, served for `--glb` runs)
src/viewer/             zero-dep GLB ingest + moderation (the page itself lives in experience/)
src/manifest/           the quality ladder as validated, hashed data
src/capability/         bucketing and path resolution — the privacy boundary
src/decision/           the DecisionEngine interface + all three implementations
src/judge/              batch trace triage over captured traces
src/trace/              the flight recorder schema, normalisation and hashing
src/runner/             CDP, WebSocket, profiles, the matrix and replay runners
src/image/              PNG codec and perceptual diff, both hand-written
src/gate/               the release rule (incl. the Atlas score floor)
src/targets/            the versioned owned-staging contract, score and build binding
src/net/                the destination policy for outbound navigation
src/diagnose/           deterministic findings: observations, rule-named causes, no guesses
src/preflight/          static pre-launch weight assessment
src/report/             the engine comparison, the report diff and the HTML report
tests/                  run with node:test (`node --test tests/<name>.test.js` to focus)
scripts/                deterministic asset and fixture generators
examples/traces/        ten example traces — written by `atlas fixtures`
docs/trace-schema.md    what a trace contains and why
docs/adr/               why things are the way they are
```

## Design records

| | |
|---|---|
| [ADR-0001](docs/adr/0001-original-experience-no-flam-integration.md) | Original experience; no Flam integration |
| [ADR-0002](docs/adr/0002-zero-dependencies-cdp-over-raw-websocket.md) | No dependencies; CDP over a hand-written WebSocket |
| [ADR-0003](docs/adr/0003-manifest-as-contract.md) | The quality ladder is validated, content-hashed data |
| [ADR-0004](docs/adr/0004-determinism-model.md) | Seeded RNG and quantised offsets, not a faked clock |
| [ADR-0005](docs/adr/0005-decision-engine-interface.md) | One interface, rule-based default, a guard with the last word |
| [ADR-0006](docs/adr/0006-jev-typed-answers-only.md) | Typed answers only; there is no rationale string |
| [ADR-0008](docs/adr/0008-optional-visual-and-code-models.md) | Optional Groq visual review and code proposals never decide or apply release changes |

## Scope

This is a proof-of-work artifact, not a product. It has no auth, no persistence
beyond `artifacts/`, no multi-user story, and a unit-only CI workflow (browser
stages stay local). The things it
does claim to do are the things it can be run to demonstrate, which is the whole
point of shipping it as a repository rather than as a deck.

MIT.
