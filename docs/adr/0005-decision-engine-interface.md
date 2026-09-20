# ADR-0005 — The decision layer is an interface; the rule engine is the default and a guard has the last word

**Status:** Accepted
**Date:** 2026-01

## Context

Two decisions in this system are genuinely judgement calls rather than
calculations:

1. **The live tier router.** Given a capability snapshot, which of `high` / `mid`
   / `low` / `static-fallback` should this device be served, is the camera path
   safe, and how likely is the first frame to miss its budget?
2. **The trace judge.** Given a completed session, did it pass, degrade
   acceptably, fail, or produce too little evidence to say — what was the root
   cause, and how release-blocking is it?

Both are the kind of question a small calibrated model is good at: bounded option
sets, several weakly-correlated signals, no single threshold that is right. Both
are also the kind of question where a model being wrong has a real cost — serving
a tier a device cannot render is a black screen, and a judge that says "pass" on
a broken session poisons the release gate.

So the question is not "model or rules". It is: **what is the model allowed to
decide, and what happens when it is wrong or absent?**

## Decision

### One interface, three implementations

A single `DecisionEngine` interface ([`types/atlas.d.ts`](../../types/atlas.d.ts)):

```
kind:  "deterministic" | "model"
name:  string
routeTier(capability, ctx)   → TierDecision      (async)
routeTierSync(capability, ctx) → TierDecision    (deterministic engines only)
judgeTrace(trace, ctx)       → TraceVerdict      (async)
judgeTraceSync(trace, ctx)   → TraceVerdict      (deterministic engines only)
```

Three implementations sit behind it:

- **`RuleBasedDecisionEngine`** — the default. Zero external calls, zero API key,
  zero network. It is what CI runs, what a fresh clone runs, and what the
  comparison harness measures against. It produces the *same output shape* as the
  model engine, including probability distributions (via `softmax` over scored
  options) and a confidence — not because it is Bayesian, but because a
  downstream consumer must not be able to tell which engine answered by looking
  at the shape of the answer.
- **`JevDecisionEngine`** — optional, constructed only when a transport exists.
  See [ADR-0006](0006-jev-typed-answers-only.md) for what it is allowed to say.
- **`GuardedDecisionEngine`** — a wrapper, not an engine. It is what actually
  runs whenever Jev is configured.

### Selection is one function with one rule

[`src/decision/index.js`](../../src/decision/index.js) is the only place that
decides who answers:

- `TYPESAFE_API_KEY` present → `Guarded(Jev → rules)`.
- `ATLAS_JEV_FIXTURES=1` and fixtures on disk → `Guarded(Jev-over-fixtures →
  rules)`, loudly labelled illustrative.
- Otherwise → rules, with a log line naming the reason.

There is no configuration in which a missing key, a down API, or a slow response
breaks the run. It can only make the decision less informed.

### The guard, and its order

[`src/decision/guarded.js`](../../src/decision/guarded.js) overrides the primary
engine in a fixed order, and records what it did in a `GuardReport` attached at
`decision.guard`:

1. **The primary threw, or timed out.** → rule-based answer.
2. **The primary chose something infeasible** — a tier the device provably cannot
   render, per the manifest's declared requirements. → rule-based answer.
3. **The primary was not confident enough** — below the floor
   (`ATLAS_TIER_CONFIDENCE_FLOOR`, `ATLAS_VERDICT_CONFIDENCE_FLOOR`). → rule-based
   answer.
4. Otherwise the primary's answer is served unchanged.

Two details in that mechanism are deliberate and easy to get wrong.

**The override is recorded on the guard, not on the decision.** After an override
the served decision *is* the rule engine's answer, whose confidence is its own and
normally well above the floor. Recording "overridden" on the decision itself would
mean the gate's rule 6 could never distinguish "the model was unsure" from "the
replacement is confident". The release gate reads `decision.guard.overridden`
precisely for this reason.

**The path is always re-derived from capability, even on the trusted branch.**
`resolvePath()` runs against the manifest regardless of what the primary said. A
model may influence *how much* to render; it never decides whether the camera
path is available, because that is a permissions-and-features fact, not a
judgement call. The path is never the model's to decide.

### Verdicts fail closed

For the trace judge the guard is asymmetric. Outcomes are ranked
(`pass` < `degraded-but-acceptable` < `inconclusive` < `fail`), and a model
verdict that is **more permissive** than the deterministic one is rejected. A
model may tighten a verdict; it may never loosen one. A gate whose model can
argue its way to "pass" is not a gate.

## Consequences

**Good.** The repo runs end to end with no API key, no network, and no account —
which is the difference between a reviewer running it and a reviewer reading
about it. `npm test` exercises both engines against the same fixtures and never
touches a network.

**Good.** Because the shapes are identical, the §4.4 comparison harness is a
straightforward loop: same inputs, both engines, report agreement. There is no
adapter layer where a bug could hide.

**Good.** The blast radius of the model is bounded and stated: it can move a tier
within the feasible set and it can make a verdict stricter. That is a sentence
that fits in a design review.

**Costly.** The rule engine has to produce calibrated-looking distributions it
does not really have. `softmax` over hand-tuned scores is an honest-enough
representation of relative preference, but a reader should not mistake a
rule-engine distribution for a calibrated probability, and the comparison report
says so.

**Costly.** Three implementations plus a wrapper is more surface than a single
function with an `if`. The alternative — a model call inline in the router with a
`try/catch` — is where every "the AI broke prod" incident comes from.

**Unresolved.** The confidence floors are configurable per call site but their
default values are judgement calls, not measurements. Calibrating them would
require a live corpus this project does not have, and inventing one would be
exactly the kind of unearned claim §6 of the brief forbids.

## Alternatives considered

**Model only, no rules.** Rejected: no offline path, no CI, no fallback, and the
comparison harness would have nothing to compare against.

**Rules only.** Rejected because the brief asks for the decision layer, but also
because the tier-routing problem genuinely has the shape — several weak signals,
a bounded option set, and a distribution that is more useful than an argmax.

**Model as a post-hoc reviewer** that annotates but never decides. Safer, and
much less interesting: it would not be an integration, it would be a comment
generator. The guard gets most of the safety while leaving the model a real
decision.

**Let the model decide the path too.** Rejected outright. Camera availability is
a fact about permissions and feature detection. There is nothing to judge.
