# Five-minute walkthrough

The longer version: what the pieces are, why each one is shaped the way it is, and
what this does not prove. Aimed at someone who will ask a follow-up question, so
the order is the order the code runs in.

**Before presenting:** run `node bin/atlas.js all`. Every number you cite must
come off an artifact from that run. Nothing hand-entered, in any slide, caption or
sentence.

**Do not open with** credentials, a timeline, or a claim about anyone else's
tooling. Open with the problem.

---

## 0:00 – 0:40 — The problem this is about

> "An adaptive 3D or WebAR experience has a hard measurement problem. It renders
> differently on every device by design, so 'did it work?' has no single answer,
> and the usual dashboard answers a question nobody asked: how fast was the first
> frame. A fast blank frame is a win on that dashboard."

> "Three things are hard here. Knowing what a device can actually carry. Knowing
> what a session actually did, without recording things you shouldn't. And being
> able to re-run a failure so a fix is a reproducible claim instead of an
> assertion."

> "This repo is one small original experience plus the tooling for those three.
> It's not a Flam integration — no SDK, no API, no branding, nothing mocked. That's
> stated in the README above the fold and in ADR-0001, and it's also in the
> manifest as data so it travels with every trace."

## 0:40 – 1:30 — The manifest: the ladder is a document

*Screen: `src/manifest/atlas-orbital.manifest.js`.*

> "Everything starts here. Three quality tiers with explicit cost parameters —
> particle count, texture size, shader passes, frame budget — and the assets each
> loads, with declared byte counts and capability requirements. Three delivery
> paths: camera, 2D, static. Three invariants: visual, interaction, business."

*Scroll through `invariants`.*

> "The invariants are checkable properties, not prose. The visual one has a minimum
> focal coverage and forbids a blank first frame. The interaction one is a p95
> latency and a legal state-transition graph. The business one is: checkout is
> reachable in at most four steps."

*Open `src/manifest/validate.js`.*

> "And it's validated. The ladder must strictly decrease in cost on every axis. The
> lowest tier must require nothing, so there's always something servable. The end
> state must be reachable through the declared transitions. A blank first frame can
> never be declared acceptable. `tests/manifest.test.js` mutates the manifest
> seventeen ways and asserts each one is caught."

> "Judgement calls — a budget that disagrees with an invariant threshold — are
> warnings, not errors. A validator that refuses to run over a debatable number
> gets disabled, and then it's protecting nothing."

> "The manifest is content-hashed, and the hash goes into every trace. So a trace
> can't be replayed against a manifest it wasn't recorded against, and a report
> can't silently mix two different ladders."

> "The real reason it's shaped like this: because the ladder is a document, you can
> hand it to a decision engine as state. A scatter of conditionals can't be
> described to a model without a hand-maintained parallel description, which is the
> first thing to rot."

## 1:30 – 2:30 — The decision layer

*Screen: `types/atlas.d.ts`, the `DecisionEngine` interface.*

> "Two decisions here are genuinely judgement calls. Live: given a capability
> snapshot, which tier, is the camera path safe, how likely is the first frame to
> miss its budget. Offline: given a finished session, did it pass, degrade
> acceptably, fail, or produce too little evidence to say — and what caused it."

> "One interface, three implementations."

*Open `src/decision/rule-based.js`.*

> "`RuleBasedDecisionEngine` is the default. Zero external calls, zero key, zero
> network. It's what CI runs, what a fresh clone runs, and what the comparison
> measures against. It emits the same output shape as the model engine —
> distributions and a confidence — so nothing downstream can tell which engine
> answered by looking at the shape."

*Open `src/decision/questions.js`.*

> "`JevDecisionEngine` is optional. Jev is TypeSafe's 'System One' model — it
> answers in a fixed vocabulary: pick one from a set with a distribution, place
> something on an ordered scale, or give a probability. There's no string channel
> at all."

> "So there's no prompt engineering to do. All the craft moves into the criteria —
> every option needs a concrete, mutually exclusive, unambiguous description. And
> the numbers in those criteria are read from the manifest, not typed into a
> string, so the question the model is asked can't drift from the contract the code
> enforces."

> "Two call sites, each one batched call. Three questions rather than one, because
> they have different failure modes — a device can be fast enough for the high tier
> while its camera path is still unsafe, and one question would hide that."

*Open `src/decision/guarded.js`.*

> "Whenever a model is configured, this is what actually runs. It overrides in a
> fixed order: the primary threw or timed out, the primary chose something the
> device provably can't render, the primary wasn't confident enough. Then it serves
> the model's answer."

> "Two details worth pointing at. The override is recorded on the guard, not on the
> decision — after an override the served decision *is* the rule engine's answer,
> and its confidence is its own. If you recorded 'overridden' on the decision, the
> gate could never tell 'the model was unsure' from 'the replacement is
> confident'."

> "And the path is always re-derived from capability, even on the trusted branch.
> A model can influence how much to render. It never decides whether the camera
> path is available, because that's a permissions-and-features fact. The path is
> never the model's to decide."

> "Verdicts fail closed. Outcomes are ranked, and a model verdict more permissive
> than the deterministic one is rejected. A model may tighten a verdict, never
> loosen one. A gate whose model can argue its way to 'pass' isn't a gate."

## 2:30 – 3:10 — The matrix and the recorder

*Screen: `src/runner/profiles.js`.*

> "Six profiles, all treated as release-critical. High-end Wi-Fi as the reference.
> Mid Android on 4G as the volume case. Low-CPU on 3G as the failure story. Lossy
> 4G for asset-failure handling rather than raw slowness. Camera denied. And no
> WebGL at all."

> "They run sequentially, never in parallel — CPU throttling is a whole-browser
> setting, and two throttled renderers on one machine contend, which would make
> every timing in the report a measurement of the harness."

*Open `src/trace/schema.js`.*

> "Every session produces a trace. OTel-shaped — resource attributes, events with a
> name, a kind and a flat attribute bag — with two deliberate departures. Events
> carry an offset from session start, never a wall clock. And timings are quantised
> before hashing."

> "The privacy boundary is visible in the schema. An interaction is a class label
> plus a latency — the coordinates dispatch the event and are discarded. Capability
> values are bucketed before anything aggregates them. No user agent, no IP, no
> fingerprint. No raw camera frames or raw audio, ever, in any configuration, with
> or without a model — and the manifest validator refuses a manifest that weakens
> that, so it's a failing test rather than a paragraph."

> "Metrics are derived from the event stream, never declared. So a trace captured
> by the browser and one reconstructed from disk go through the same derivation,
> and a fixture can't claim a first frame it doesn't have an event for."

## 3:10 – 3:50 — Replay

*Screen: `src/trace/normalize.js`, then the replay report.*

> "The clock is never faked. Determinism comes from controlling inputs — a seeded
> PRNG, no `Math.random`, a fixed animation phase — and from being explicit about
> what the comparison ignores."

> "Ignored: trace id, start timestamp, duration, heap figures, sampled frame
> counters. Not ignored: the state sequence and its order, lifecycle and interaction
> and asset and error events, checkpoints, served tier, served path, capability
> bucket, manifest hash. The dividing line is causality — a frame counter is a
> performance observation, a reordered state is a different session."

> "Two hashes. One with quantised timing, one without. A causal match with a timing
> difference is the *expected* result for a separate real run on real clocks, and
> the gate records that as informational rather than as a defect. A causal mismatch
> blocks."

> "Screenshots are compared perceptually — a per-channel tolerance and a luma grid
> — because a one-pixel shift is a catastrophic pixel diff and a near-perfect
> perceptual match, and the report should say both numbers rather than pick one.
> Pixel-exact comparison across GPU drivers is a driver-version detector, not a
> test."

## 3:50 – 4:20 — The release rule

*Screen: the top of `src/gate/release-gate.js`, then the gate findings.*

> "The rule is stated in full at the top of the file, in numbered form, and the
> report says which rule it applied and how to reproduce it."

> "It blocks on: a critical profile with no coverage, a failed run, a severity at
> or above major, a business invariant that didn't hold, an inconclusive run, a
> replay that didn't reproduce. It warns on budget breaches, page errors, and a
> low-confidence decision. And it deliberately excludes the baseline from grading —
> the baseline is *supposed* to fail; it's the control."

> "The half people get wrong is what doesn't block. `tests/gate.test.js` tests both
> halves — including a run that breaches every budget and still ships, and a metric
> exactly on budget not counting as a breach. A release rule that's never been shown
> to block anything is a slogan; one that blocks on everything gets switched off."

## 4:20 – 4:45 — Zero dependencies, and why

*Screen: `package.json` with empty `dependencies` and `devDependencies`.*

> "No runtime dependencies, no dev dependencies. Chrome is driven over CDP through
> a hand-written RFC 6455 WebSocket client. PNG encode and decode through
> `node:zlib`. The image diff, the test runner, the HTTP server — all standard
> library."

> "Two reasons. Clone-and-run: no install step between seeing the repo and running
> it. And auditability — the interesting claims here are all measurement claims, and
> when the harness is a dependency you either take the measurement on faith or go
> read someone else's library."

> "The honest cost is in ADR-0002. No auto-waiting, no retry-on-flake, Chrome and
> Edge only, no trace viewer. And hand-written protocol code is where bugs live,
> which is why `tests/ws.test.js` connects the client to a real socket built from
> the RFC rather than from the implementation — a test that reuses the
> implementation's own framing agrees with any bug it contains."

> "It's reversible. Adopting Playwright would replace three files and touch nothing
> else."

## 4:45 – 5:00 — What this does not prove

> "Stated plainly, because it's the thing most likely to be over-claimed."

> "These are Chromium emulations. The CPU throttling, the network shaping, the
> permission state and the WebGL availability are real and applied by the browser.
> The hardware hints — device memory, core count, connection type, GPU tier — are
> injected so the probe sees what a device of that class reports."

> "Not tested at all: real GPU drivers, thermal throttling, sustained load, actual
> handset performance, iOS or Safari, real camera hardware. So this exercises the
> decision layer and the degrade ladder honestly against a real renderer on a real
> clock. It supports no claim about 'all devices' and doesn't replace a device lab."

> "On the model side: TypeSafe publishes latency and calibration figures for Jev.
> Those are their numbers, not measurements made here. This repo has never run
> against a live deployment. The bundled fixtures are hand-authored and labelled
> illustrative in the file itself — any agreement rate computed against them
> measures the fixture file, and the comparison report says so."

---

## Likely questions

**"Why not Playwright?"** — For a team shipping this, use Playwright. Here the
value is that a reader clones and runs it in one command and can audit the
measurement. ADR-0002 states the cost honestly, and the change is contained to
three files.

**"Isn't the rule engine doing all the work?"** — Yes, by design, and that's the
point of the comparison harness. The model's blast radius is deliberately bounded
to one sentence: it can move a tier within the feasible set, and it can make a
verdict stricter.

**"What if Jev is down?"** — The guard falls back to the rule engine and records
that it did. There is no configuration where a missing key, a down API or a slow
response breaks a run; it can only make a decision less informed.

**"Why is there no rationale text on the model's decisions?"** — Jev has no string
channel. Any rationale would have been written by this repo's own code and would
then appear in a report next to the model's name, reading as though the model said
it. The distribution and the confidence are in the report instead, and they're
more informative. ADR-0006.

**"What would you do next?"** — Three things, in order. Real devices, because
everything above is emulation and the gap is the biggest one here. A live Jev key,
so the comparison reports a real agreement rate and the confidence floors become
measurements rather than judgement calls. And a retention mechanism, because the
manifest declares thirty days and this repo has no server to enforce it — that gap
is stated in PRIVACY.md rather than papered over.
