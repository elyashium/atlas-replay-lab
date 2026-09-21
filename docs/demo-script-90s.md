# 90-second demo script

For a screen recording or a live walkthrough. Timings are targets, not a
teleprompter — the point is that the whole thing fits in the time before someone
decides whether to keep watching.

**Before recording:** run `node bin/atlas.js all` and let it finish. Every number
you point at must be a number the harness captured in that run. Do not type a
metric into a slide, a caption, or a voiceover. If a number is not on screen in an
artifact, do not say it.

**Do not open with:** a claim that this is fast, impressive, built in a weekend, or
that anyone's existing tooling is missing it. Open with the failure.

---

## 0:00 – 0:12 — The failure, not the pitch

*Screen: `artifacts/report.html`, scrolled to the baseline row for `low-cpu-3g`.*

> "This is one WebAR-style experience under a throttled Android profile — four
> slow cores, 1.1 megabits, 380 millisecond round trip. The quality ladder is
> bypassed here, so it's serving the high tier to a device that can't carry it.
> First frame lands at ‹point at `firstFrameMs`›, and the frame it lands is
> blank. Checkout is never reached."

*Point at `firstFrameNonBlank: false` specifically.*

> "That last part is the one a timing dashboard misses. A fast blank frame looks
> like a win."

## 0:12 – 0:30 — The same device, one difference

*Screen: the adaptive row for the same profile, side by side.*

> "Same profile. Same seed. Same assets on disk. The only difference is that the
> decision layer got to choose the tier instead of the harness pinning it."

*Point at `servedTier`, then at the metrics.*

> "It routed down, resolved a fallback path, and now ‹read the after numbers off
> the report›. Checkout completes."

## 0:30 – 0:48 — The ladder is data, not conditionals

*Screen: `src/manifest/atlas-orbital.manifest.js`.*

> "That routing isn't a pile of if-statements. Three tiers, three delivery paths,
> three invariants, the budgets, and the privacy rule — all declared in one file,
> validated, and content-hashed."

*Scroll to `invariants.visual`, then `privacy`.*

> "Validated means the ladder must strictly decrease in cost, the lowest tier must
> require nothing, checkout must be reachable, and a blank first frame can never
> be declared acceptable. Those are tests, not comments."

> "And because the ladder is a document, it can be handed to a decision engine as
> state. That's the reason it's shaped this way."

## 0:48 – 1:06 — Replay: the fix is reproducible

*Screen: `artifacts/replay/low-cpu-3g/report.json`, or the replay panel in the
report.*

> "Then both halves get replayed. Real Chrome, real clock — the clock is never
> faked, because a fix that only works when time is fake isn't a fix."

*Point at the two hashes.*

> "Two hashes. One says the same things happened in the same order. The other adds
> whether they happened at the same speed, quantised to eight milliseconds. So the
> report can tell you which kind of sameness held instead of giving you a boolean
> with an invisible threshold."

## 1:06 – 1:22 — The gate can say no

*Screen: the gate findings, and the terminal showing the exit code.*

> "A release rule reads what was captured and exits non-zero when it says hold.
> Missing coverage on a critical profile, a failure, a severity at or above major,
> a business invariant that didn't hold, an inconclusive run, a replay that didn't
> reproduce."

> "And it deliberately *doesn't* block on budget breaches, on a low-confidence
> decision — that one ships with a note for a human — or on the baseline, which is
> excluded from grading because it's the control and it's supposed to fail. What
> doesn't stop a release is the half of a gate people get wrong."

## 1:22 – 1:30 — What it is and isn't

*Screen: the README's "What was emulated" section.*

> "One honest caveat, and it's in the README above the fold. These are Chromium
> emulations. CPU throttling and network shaping are real; the hardware hints are
> injected. That's enough to exercise the ladder and the decision layer. It is not
> a claim about any real handset, and it doesn't replace a device lab."

> "Zero dependencies. `node bin/atlas.js all` from a fresh clone. No API key."

*Stop. Do not add a closing pitch.*

---

## If someone asks about the decision layer in the room

Thirty seconds, no slides:

> "One interface, `DecisionEngine`, with two implementations. The rule-based one
> is the default — zero network, zero key, and it's what CI runs. The other is
> backed by Jev, TypeSafe's small typed-answer model, and it's only active if an
> API key is present."

> "Whenever the model is configured, a guard wraps it: it overrides on error, on
> infeasibility — a tier the device provably can't render — and on low confidence,
> in that order. Verdicts fail closed, so the model can make a verdict stricter
> and never looser. And the delivery path is always re-derived from capability,
> never taken from the model, because camera availability is a fact, not a
> judgement call."

> "`node bin/atlas.js compare` runs everything through both and reports the
> agreement rate. With no key it says `agreement N/A — no live Jev key` and
> finishes."

**If asked how fast Jev is:** TypeSafe reports 70 to 500 milliseconds. That is
their published figure. This repo has not measured it and has never run against a
live deployment — the only measurement here is the two-engine agreement on
synthetic inputs, which is not a benchmark and not a calibration study.
