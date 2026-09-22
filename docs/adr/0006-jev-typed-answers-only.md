# ADR-0006 — Jev answers in a fixed vocabulary; there is no rationale string

**Status:** Accepted
**Date:** 2026-01

## Context

The optional model in this system is **Jev**, TypeSafe AI's "System One" model.
It is worth being precise about what it is, because the design of this
integration follows directly from its shape rather than from a general "add an
LLM" posture.

Per TypeSafe's published description, Jev answers three kinds of question:

- **Choice** — pick one option from a declared set, and return a probability
  distribution over all of them.
- **Score** — place something on an ordered scale of 2–10 named levels, returning
  a fractional score *and* a distribution over the levels.
- **Noul** — a boolean-ish question, returning P(true) between 0 and 1.

It is **not autoregressive**. TypeSafe describes it as a parallel sampler: one
forward pass emits every answer in a batch, so asking three questions costs close
to what asking one costs. Its output vocabulary is fixed — there is no string
channel at all. TypeSafe states it is RLCD-trained for calibration, and reports
latencies in the 70–500ms range with a context budget around 32K tokens.

> **Attribution.** Everything in the paragraph above is TypeSafe's own published
> description of their product. Nothing in this repository independently verifies
> any of it — not the latency, not the token budget, not the calibration claim.
> The only measurement this project makes is the small side-by-side agreement
> comparison in [`src/report/engine-comparison.js`](../../src/report/engine-comparison.js),
> which compares two engines against each other on synthetic inputs and is not a
> calibration study.

The design question this raises is sharper than the usual one. Most LLM
integrations spend their design effort on parsing and trusting free text. Here
there is no free text to parse. The craft moves entirely into **how the question
is written** — the `state` the model is given, and the `criteria` attached to each
option.

There is also a temptation to resist: every report in this project would read
more impressively with a sentence of explanation next to each decision, and it
would be trivially easy to generate one.

## Decision

### 1. The decision layer asks typed questions only

Two call sites, each one batched call:

- **Tier router** ([`tierQuestions`](../../src/decision/questions.js)) — a Choice
  over `["high", "mid", "low", "static-fallback"]`, a Noul on camera-path safety,
  and a Score over five first-frame-risk levels. Three questions rather than one
  ("what should we serve?") because they have different failure modes: a device
  can be fast enough for the high tier while its camera path is still unsafe, and
  collapsing them would hide exactly that.
- **Trace judge** ([`traceQuestions`](../../src/decision/questions.js)) — a Choice
  over outcomes, a Choice over root causes, and a Score over release-blocking
  severity. The three invariants are judged independently rather than as one
  blob, for the same reason.

### 2. `rationale` is always `[]` for the Jev engine

`JevDecisionEngine` returns an empty rationale array. Always.

This is the decision that most needs writing down, because the empty array looks
like an oversight and is not. Jev has no string channel. Any rationale attached
to a Jev decision could only have been **written here**, by this repository's own
code, from the numbers the model returned — and it would then appear in a report,
next to a model's name, reading as though the model had said it.

That is a small lie with a large blast radius: it is precisely the kind of
artifact that makes a reader believe a model explained itself when it did not. An
empty array is the honest representation, and the numbers the model *did* return
— the full distribution, the confidence, the score — are carried in the decision
and rendered in the report. Those are more informative than a sentence anyway.

The rule-based engine *does* populate `rationale`, because it genuinely knows why:
it computed the scores itself, and each line corresponds to a term it evaluated.

### 3. The criteria carry the contract, and are derived from the manifest

Because there is no room for a prompt to be clever, every option's `criteria`
must be **mutually exclusive, concrete and unambiguous**, and the numbers in them
must be the real numbers. The budget quoted in a first-frame-risk criterion is
read from the manifest ([ADR-0003](0003-manifest-as-contract.md)), not typed into
a string, so the question a model is asked cannot drift from the contract the
code enforces.

`tests/decision.test.js` asserts the structural half of this: every option has a
criterion, no option is duplicated, and the risk criteria name the literal budget.

### 4. The state sent to Jev is the already-normalised, already-redacted snapshot

Whatever goes to a third party is the same coarse capability snapshot the rest of
the system uses — bucketed, with user agent, IP, and fingerprint-shaped fields
already stripped by `normalizeSnapshot`. `summariseTraceForJev` deliberately omits
`ctx.origin`, so a trace summary cannot leak whether it came from a live server or
a CI matrix run.

Raw camera frames and raw audio never leave the device under any configuration,
with or without Jev. That is a manifest-level invariant the validator enforces
(see [PRIVACY.md](../../PRIVACY.md)), not a property of this integration.

### 5. Answers are read defensively

[`src/decision/jev-transport.js`](../../src/decision/jev-transport.js) reads every
answer through helpers that tolerate a malformed response: distributions are
renormalised and keys not in the declared option set are dropped; a missing or
junk choice reads as `null`; `readProbability({})` returns 0.5. A read that cannot
be trusted becomes a low confidence, which the guard
([ADR-0005](0005-decision-engine-interface.md)) then overrides. There is no path
where a malformed response becomes a confident decision.

## Consequences

**Good.** Nothing in any report attributes words to a model that has no words.
Every Jev-derived number in the HTML report is a number Jev actually returned.

**Good.** The batching property means both integration points are single calls,
which keeps the live-path latency budget to one round trip rather than three.

**Good.** Because the fixtures are hand-authored typed answers, the entire Jev
code path — transport, readers, engine, guard — is exercised in `npm test` with
no key and no network. Those fixtures are marked `$note: ILLUSTRATIVE` in the file
itself and in every test that consumes them, because they measure nothing about
the model.

**Costly.** A reader who wants to know *why* a tier was chosen gets a distribution
rather than a sentence, and has to read the distribution. That is a real usability
cost, accepted deliberately.

**Costly.** All the design leverage sits in criteria wording, which is the hardest
part of this to test. The structural tests catch missing and duplicated criteria;
they cannot catch a criterion that is merely badly worded.

**Honest limitation.** As of 2026-09-22 this repository has made exactly one
small live run (32 calls total: `jev-check` + `compare` + `judge`, all against
`jev-1.13.0`, all on synthetic inputs). The comparison harness reports
`agreement N/A — no live Jev key` without a key and says so in the output rather
than quietly reporting fixture agreement as if it were a live measurement; with
a key it reports measured agreement, latency, tokens, and cost with the
small-sample caveat attached.

## Alternatives considered

**Generate a rationale from the distribution** ("chose `mid` because the
distribution favoured it at 0.62"). Rejected: it is this repo's sentence, not the
model's, and putting it in a `rationale` field next to `engine: "jev"` is
misattribution regardless of intent. The distribution is already in the report.

**Add a second, text-capable model to explain Jev's answers.** Rejected as
strictly worse: a second model's guess about a first model's reasoning is not an
explanation, it is a plausible-sounding fabrication with two sources of error.

**One big question instead of three.** Rejected: it discards the independence
that makes the guard's infeasibility check meaningful, and TypeSafe's own
documented guidance is to decompose into small independent questions. Batching
means three costs about what one costs, so there is no efficiency argument for
merging them either.

**Send the full trace rather than a summary.** Rejected on privacy and on token
budget. The summary carries what the questions actually need.
