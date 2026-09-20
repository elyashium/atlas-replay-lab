# ADR-0003 — The quality ladder is declarative data, validated and content-hashed

**Status:** Accepted
**Date:** 2026-01

## Context

A capability-aware experience has, somewhere in it, a set of rules of the form
"on a device like *this*, serve *that*". The default place those rules end up is
scattered across the code that uses them: a `if (!gl2) particleCount = 900` here,
a texture-size switch in the loader there, a `maxTransferBytes` constant in a
build script, and a budget in a dashboard that nobody has reconciled with any of
them.

The consequences are familiar. Nobody can answer "what exactly do we serve on a
2GB Android on 3G?" without reading four files. The tiers drift out of order, so
the "mid" tier quietly becomes more expensive than "high" on some axis. The
budgets in the alerting system and the budgets in the code diverge. And — most
relevant to this project — there is no artifact to hand a decision engine when
you want it to reason about the ladder, because the ladder is not a thing, it is
a scatter of conditionals.

## Decision

The experience declares a single **manifest**
([`src/manifest/atlas-orbital.manifest.js`](../../src/manifest/atlas-orbital.manifest.js))
that is the only source of truth for:

- **Three quality tiers** (`high`, `mid`, `low`) with explicit cost parameters —
  particle count, texture size, shader passes, target FPS, per-frame work budget —
  and the assets each tier loads, with declared byte counts and capability
  requirements.
- **Three delivery paths**, of which two are fallbacks from the camera path:
  `camera-xr` → `interactive-2d` → `static-safe`, each with its own requirements
  and an explicit priority.
- **Three invariants** — visual, interaction, business — stated as checkable
  properties rather than prose, including the legal state-transition graph.
- **Budgets**, which are the *high-tier* targets and are treated as such
  everywhere downstream.
- **Checkpoints**, the states at which a screenshot is captured.
- **The privacy rule**: what may be collected, what may never be, retention, the
  redaction techniques, and whether trace egress to a third party is on.

Two properties make this more than a config file.

**It is validated.** [`src/manifest/validate.js`](../../src/manifest/validate.js)
enforces the properties that make the ladder mean something, and refuses the
manifest when they do not hold:

- the ladder must **strictly decrease** in cost at every step, on every cost axis;
- the lowest tier must require **nothing**, so there is always something servable;
- the lowest-priority fallback path must require nothing, for the same reason;
- no tier may declare more bytes than the transfer budget;
- capability requirements must come from the declared vocabulary — a typo is an
  error, not a requirement that is silently never satisfied;
- the business end state must be **reachable** from `boot` through the declared
  transition graph, in no more than the declared number of steps;
- a blank first frame can never be declared acceptable;
- a checkpoint must sit on a reachable state, and a first-frame checkpoint is
  mandatory, because it is the evidence for the visual invariant;
- the privacy rule must explicitly forbid raw camera frames and raw audio, and no
  field may appear in both `collect` and `neverCollect`.

Disagreements that are judgement calls rather than contradictions — an
interaction budget that differs from the invariant's own threshold — are
**warnings**, not errors. A validator that refuses to run over a debatable number
gets disabled.

**It is content-hashed.** `hashManifest()` content-addresses the whole document,
and the hash is embedded in every trace. A trace therefore cannot be replayed
against a manifest it was not recorded against, and a report cannot silently mix
results from two different ladders.

## Consequences

**Good.** The question "what do we serve on X?" has one answer in one file, and
`node bin/atlas.js doctor` will tell you if that file is internally inconsistent
before any browser starts. The tier ladder is testable as data
([`tests/manifest.test.js`](../../tests/manifest.test.js) mutates it seventeen
different ways and asserts the validator catches each one).

**Good, and this is the reason it was done.** Because the ladder is a document,
it can be handed to a decision engine as *state* — which is exactly what
[`src/decision/questions.js`](../../src/decision/questions.js) does when it
builds the criteria for the tier router. The budgets quoted in a question's
criteria are read from the manifest, so the question a model is asked cannot
drift from the contract the code enforces. A scattered ladder could not be
described to a model at all without a hand-maintained parallel description, which
would be the first thing to rot.

**Costly.** Adding a tier means editing a manifest, re-hashing it, and
potentially updating the validator's expectations — more ceremony than editing a
constant. Content-hashing means any change invalidates previously captured traces
for replay purposes, which is correct but occasionally annoying during
development.

**Unresolved.** The manifest is a JS module rather than JSON, so it can use
numeric separators and carry comments explaining each number. That makes it
un-loadable from a non-JS runtime. A JSON export exists in every report, which
covers the reader's case but not a polyglot consumer's.

## Alternatives considered

**Rules in code, documented in a README.** The status quo everywhere. Rejected
because the documentation and the code diverge within one sprint, and because
there is no object to hand a decision layer.

**JSON or YAML.** Rejected for the comments and the numeric separators — the
manifest is read by humans far more often than by machines, and
`maxTransferBytes: 2_200_000` with a note about why is worth more than a parser
that any language can load. The validator would be identical either way.

**A schema language (JSON Schema, Zod).** Zod is a dependency (ADR-0002). JSON
Schema expresses the *shape* well but none of the interesting constraints: "the
ladder strictly decreases" and "the end state is reachable" are graph and
ordering properties, not type properties, and those are the constraints that
actually catch bugs here.
