# ADR-0004 — Determinism comes from a seeded RNG and quantised offsets, not a faked clock

**Status:** Accepted
**Date:** 2026-01

## Context

"Deterministic replay" is the load-bearing claim of this project. Everything
downstream — the before/after story, the release gate's rule 7, the assertion
that a fix actually fixed something — depends on *"the same session"* being a
decidable question.

The trouble is that a browser session is not deterministic in any literal sense.
Two runs of the identical page on the identical machine differ in:

- wall-clock timestamps, always;
- millisecond-level event timings, always, by a few ms in each direction;
- frame counts and dropped-frame counts, which depend on what else the machine
  was doing;
- JS heap figures, which depend on when GC felt like running;
- anti-aliasing at sub-pixel boundaries, which differs between GPU drivers and
  sometimes between runs on the same driver;
- anything seeded from `Math.random()` or `Date.now()`.

A replay check that demanded literal equality would fail on every run and would
therefore be turned off within a day. A replay check that tolerated everything
would pass on every run and prove nothing. The decision is about exactly where
between those two the line goes, and — more importantly — about being able to
*state* where it goes.

The most common way to sidestep this is to fake the clock: freeze `Date.now()`,
stub `performance.now()`, install a virtual timer. That was rejected, and the
reason is the central point of this record.

## Decision

**The clock is never faked.** Every run — matrix, baseline, replay — uses the
real system clock and real `performance.now()`. Determinism is achieved by
controlling the *inputs* and by choosing what the comparison ignores.

### 1. Seeded randomness

The experience takes a seed (`--seed`, default fixed) and uses a **mulberry32**
PRNG for every stochastic choice in the scene. `Math.random` is not called. The
animation starts at a fixed phase rather than at a phase derived from the clock.
Given a seed, the scene's *content* at logical step *n* is identical across runs
and machines.

### 2. Time offsets, never timestamps

Nothing inside an event stream carries a wall-clock timestamp. Every event
carries `tOffsetMs`, an offset from the session's own start. The one absolute
timestamp in a trace is `startedAtIso`, which lives on the envelope and is
excluded from every comparison. This is simultaneously a determinism property and
a privacy property (see [PRIVACY.md](../../PRIVACY.md) — `clock-offsets-only`).

### 3. Quantised timing

Event offsets are quantised to `TIME_QUANTUM_MS = 8` — roughly one frame at
120Hz — before hashing. Two runs whose events land within the same 8ms bucket are
timing-identical for comparison purposes; a run that shifts by 400ms is not. The
number is a single exported constant so that the tolerance is arguable in one
place rather than smeared across the comparison code.

### 4. Two hashes, deliberately

[`src/trace/normalize.js`](../../src/trace/normalize.js) computes both:

- **`determinismHash`** — structure *and* quantised timing. "This is the same
  session, including how long it took."
- **`causalHash`** — structure only, with `t` dropped from every event and
  checkpoint. "This is the same sequence of things happening, whenever they
  happened."

Replay reports both. A causal match with a timing difference is the **expected**
result for a separate real run on real clocks, and the release gate records it as
*informational* rather than as a defect. A causal mismatch is a real divergence
and blocks.

Having two hashes rather than one tolerance parameter means the report can say
*which* kind of sameness held, instead of collapsing both into a boolean whose
meaning depends on a threshold the reader cannot see.

### 5. What the hash ignores, explicitly

Ignored: `traceId`, `startedAtIso`, `durationMs`, JS heap figures, sampled frame
counters (`kind: "frame"` events), and any attribute not on the normalisation
allow-list.

Not ignored: the state sequence and its order, lifecycle events, interaction
events, asset events, errors, checkpoints, the served tier, the served path, the
capability bucket, and the manifest hash.

The dividing line is causality. A frame counter is a *performance* observation;
reordering two states is a *different session*. `tests/trace.test.js` asserts
both halves, because a hash that ignored too much would make "reproduced"
meaningless and a hash that ignored too little would make it unachievable.

### 6. Pixels are compared perceptually

Checkpoint screenshots are compared with a per-channel tolerance
(`DEFAULT_CHANNEL_TOLERANCE = 6`) for literal difference, *and* with a
16×16-cell luma-grid perceptual score. A one-pixel shift is a catastrophic pixel
diff and a near-perfect perceptual match, and the report says both numbers rather
than picking one. Separately, `focalCoverage` and `edgeEnergy` answer the
question the timing number cannot: *was anything actually drawn?*

## Consequences

**Good.** Replay runs against a real browser on a real clock, which means it
exercises the same code paths as production rather than a timer-stubbed
approximation. A fix that only works when time is fake is not a fix, and this
design cannot produce that result.

**Good.** The tolerance is a number in a file (`TIME_QUANTUM_MS`), not an
emergent property of a comparison function. When someone argues that 8ms is
wrong, there is exactly one place to change and one test that will tell them what
breaks.

**Costly.** Two hashes is more machinery than one, and every consumer has to
decide which it means. The alternative was worse: a single boolean whose
threshold was invisible.

**Costly.** Because the clock is real, a replay of a 12-second session takes 12
seconds. Faking the clock would let the whole matrix run in milliseconds. That
speed is not worth the fidelity.

**Honest limitation.** This gives determinism *given the same emulated profile on
the same class of machine*. It does not claim run-to-run determinism across
different GPUs — the perceptual score exists precisely because pixel-exactness
across drivers is not achievable and pretending otherwise would be the kind of
claim this project is trying not to make.

## Alternatives considered

**Fake the clock** (freeze `Date.now`, virtual timers). Rejected: it makes replay
test a different system from the one that ships. It also silently breaks anything
that measures itself, which is most of what is being measured here.

**Record and replay at the network/input layer** (a WPR- or VCR-style proxy).
Genuinely powerful, and the right answer for a large product. Rejected as
disproportionate: it is a large subsystem, and it still does not make the
renderer deterministic, which is where the variance actually is.

**One hash with a tolerance parameter.** Rejected because it hides the
distinction that matters. "Did the same things happen?" and "did they happen at
the same speed?" are different questions with different owners, and a single
boolean answers neither.

**Pixel-exact screenshot comparison.** Rejected on the first cross-machine run:
anti-aliasing alone defeats it. The perceptual score plus a channel tolerance
keeps the check meaningful without making it a driver-version detector.
