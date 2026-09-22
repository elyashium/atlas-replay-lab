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

Five things, each of which is a real artifact on disk after one command:

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
   rule says hold. A gate that cannot fail is decoration.

## The decision layer

Two decisions in the system are judgement calls rather than calculations: which
tier to serve a given device (live, on every page load), and whether a completed
session passed, degraded acceptably, failed, or produced too little evidence to
say (offline, over each captured trace).

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

## The failure story

The repository tells one failure end to end, and every timestamp in it is
captured by the harness rather than typed by a human:

1. A **baseline** run on `low-cpu-3g` bypasses the tier router and serves the
   high tier to a device that cannot render it. It fails.
2. The **adaptive** run on the same profile lets the `DecisionEngine` route,
   which downgrades the tier and resolves a fallback path. It passes.
3. **Replay** re-runs both captures and shows each reproduces, so "the fix
   worked" is a reproducible claim rather than an assertion.

Run it, then read `artifacts/report.html`. The before/after numbers live there,
written by the runner. They are deliberately not quoted in this README — a
hand-copied metric is exactly the kind of number that goes stale and then lies.

## Commands

| | |
|---|---|
| `node bin/atlas.js doctor` | Check Node, the browser, the manifest, assets, engines. Start here. |
| `node bin/atlas.js all` | Everything: matrix → replay → gate → compare → report. Exits 1 on HOLD. |
| `node bin/atlas.js matrix` | The six-profile matrix alone |
| `node bin/atlas.js replay` | Re-run a captured trace and prove it reproduces |
| `node bin/atlas.js gate` | Apply the release rule to what was captured |
| `node bin/atlas.js compare` | §4.4 — both engines over the same fixtures |
| `node bin/atlas.js judge` | batch-judge captured traces + Jev cost/latency |
| `node bin/atlas.js jev-check` | validate `TYPESAFE_API_KEY` with one live call |
| `node bin/atlas.js report` | Render `artifacts/report.html` from what is on disk |
| `node bin/atlas.js fixtures` | Write the illustrative Jev fixtures and `examples/traces/` |
| `node bin/atlas.js assets` | Generate the tier assets (`all` does this on demand) |
| `node bin/atlas.js serve` | Serve the experience locally and drive it by hand |
| `npm test` | `node --test tests/` — no network, no browser, no key |

`node bin/atlas.js <command> --help` for flags.

### Environment

| | |
|---|---|
| `TYPESAFE_API_KEY` | Enables the live `JevDecisionEngine`. Absent by default; only `jev-check` requires it. |
| `TYPESAFE_MODEL` | Model id (default `jev-latest`; pin e.g. `jev-1.13.0` once thresholds are tuned). |
| `TYPESAFE_BASE_URL` | API base override (default `https://api.typesafe.ai`). |
| `TYPESAFE_TIMEOUT_MS` | Live-call timeout (default 4000). |
| `ATLAS_JEV_FIXTURES=1` | Runs the Jev code path against hand-authored illustrative fixtures. |
| `ATLAS_CHROME` | Path to a Chromium-family browser, if detection fails. |
| `ATLAS_HEADFUL=1` | Run the browser visibly. |

No command silently needs a key. Their absence changes what runs; it never fails
a command.

## Layout

```
bin/atlas.js            the single entry point
experience/             the Orbital demo — the thing under test
src/manifest/           the quality ladder as validated, hashed data
src/capability/         bucketing and path resolution — the privacy boundary
src/decision/           the DecisionEngine interface + all three implementations
src/judge/              batch trace triage over captured traces
src/trace/              the flight recorder schema, normalisation and hashing
src/runner/             CDP, WebSocket, profiles, the matrix and replay runners
src/image/              PNG codec and perceptual diff, both hand-written
src/gate/               the release rule
src/report/             the engine comparison and the HTML report
tests/                  six suites, run with node:test
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

## Scope

This is a proof-of-work artifact, not a product. It has no auth, no persistence
beyond `artifacts/`, no multi-user story, and a unit-only CI workflow (browser
stages stay local). The things it
does claim to do are the things it can be run to demonstrate, which is the whole
point of shipping it as a repository rather than as a deck.

MIT.
