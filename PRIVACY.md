# Privacy note

The flight recorder is the part of this project most able to do harm, so it is
the part with the tightest declared limits. This note describes what a trace
contains, what it can never contain, and where the boundary is enforced in code.

It is not a policy document written alongside the system. It is a description of
[`src/manifest/atlas-orbital.manifest.js`](src/manifest/atlas-orbital.manifest.js)'s
`privacy` block, which the manifest validator enforces and which is
content-hashed into every trace the recorder writes.

## The shape of the problem

A WebAR session is an unusually sensitive thing to instrument. The camera is
pointed at a room, often with people in it. The interactions are taps at
coordinates on a body-adjacent surface. The device reports a dozen values that
are individually harmless and jointly a fingerprint. And the reason to record any
of it — "the first frame was blank on some devices and we don't know which" — is
a real engineering need that does not go away if you refuse to look.

So the design question is not whether to record. It is what the *minimum*
evidence is that answers the engineering question, and how to make the boundary
checkable rather than aspirational.

## What is collected

Nine classes of data, and nothing else:

| | |
|---|---|
| Manifest id / version / content hash | Which ladder this session ran against |
| Capability snapshot | Coarse and non-identifying — see bucketing below |
| Capability bucket | The single label the tier decision is made from |
| Asset load timings and byte counts | Why the first frame was late |
| State transitions | The session's causal spine |
| Interaction latency | **Timing only** — not coordinates, not content |
| Frame counts and dropped-frame counts | Whether it was smooth |
| Error codes and asset failure counts | What broke |
| Redacted input classes | e.g. `tap:product` — the class, never the value |

## What is never collected

Eight classes, refused by construction:

- **Raw camera frames**
- **Raw audio**
- Raw input text
- User agent string
- IP address
- Cookies, storage identifiers, or any stable device id
- Canvas / font / audio fingerprints
- Precise geolocation

The first two are the ones that matter most, and they hold **unconditionally** —
with or without a decision engine configured, on the live server and under the
matrix, in every code path. There is no flag that turns them on. A camera frame
never enters the trace schema, so there is no field for one to be written to.

The manifest validator refuses any manifest whose `neverCollect` list does not
contain raw camera frames and raw audio, and refuses any manifest where a field
appears in both `collect` and `neverCollect`. That check is in
[`src/manifest/validate.js`](src/manifest/validate.js) and is asserted by
`tests/manifest.test.js`, so the guarantee is a failing test rather than a
paragraph.

## The four redaction techniques

The declared techniques, each of which corresponds to a mechanism rather than an
intention:

**`input-class-only`** — an interaction is recorded as a class label plus a
latency. The coordinates are used to dispatch the event and then discarded; they
are never written to the trace. This is why the interaction invariant is stated
as a p95 latency rather than as a heatmap.

**`coarse-bucketing`** — capability values are bucketed *before* any aggregation,
in `normalizeSnapshot`. Memory becomes a bucket, not `3.87`. Core count becomes a
bucket. The downstream consumer — including a decision engine — receives the
bucket. A precise value never leaves the probe, so the join that would turn a
dozen harmless numbers into a fingerprint has nothing precise to join on.

**`clock-offsets-only`** — no wall-clock timestamp appears anywhere inside the
event stream. Every event carries `tOffsetMs`, an offset from the session's own
start. The single absolute timestamp in a trace is `startedAtIso` on the
envelope. This is simultaneously a privacy property and the determinism property
that makes replay possible; see
[ADR-0004](docs/adr/0004-determinism-model.md).

**`no-free-text`** — no string field in the trace schema accepts user-authored
content. There is no `notes`, no `label`, no `message` that a page could write
into. The failure mode this closes is the common one: a well-meaning debug field
that ends up carrying a form value into a log.

## Retention

`retentionDays: 30`, declared in the manifest.

Honest scope: this repository writes traces to `artifacts/` on the machine that
ran it and has no retention mechanism, because it has no server, no database and
no deployment. The number is the declared contract that a real deployment would
have to implement and that the manifest would be checked against. It is stated
here rather than omitted so that the gap is visible — a declared retention with
no enforcement is a spec, and calling it anything else would be a claim this repo
cannot support.

## Third-party egress

`thirdPartyTraceEgress: "off-by-default"`.

With no configuration, nothing leaves the machine. Every engine call is local,
because the default engine is `RuleBasedDecisionEngine` and it makes no network
calls of any kind.

When a model **is** configured (`TYPESAFE_API_KEY`), what crosses the boundary is
deliberately not the trace:

- The tier router sends the **already-normalised, already-bucketed** capability
  snapshot — the same coarse object the rest of the system uses, after user
  agent, IP and fingerprint-shaped fields have been stripped by
  `normalizeSnapshot`.
- The trace judge sends `summariseTraceForJev(trace)`, a summary built for the
  three questions being asked. It carries counts, timings and outcomes. It does
  not carry the event stream.
- The summary deliberately omits `ctx.origin`, so it cannot reveal whether the
  session came from a live server or a CI matrix run.
- Jev has no free-text channel in either direction, which removes the largest
  category of accidental leak: there is no prompt string for a stray value to be
  interpolated into.

Turning that egress on is a deliberate act — setting an API key — and the
comparison report and `doctor` both state which engine is active and why.

## Where the boundary lives in code

| | |
|---|---|
| [`experience/capability-probe.js`](experience/capability-probe.js) | Runs in the page. Reads only the declared signals. |
| [`src/capability/buckets.js`](src/capability/buckets.js) | The boundary — `normalizeSnapshot`. Buckets everything; strips identifying fields. Nothing downstream sees a raw snapshot. |
| [`src/trace/schema.js`](src/trace/schema.js) | The schema. A field that does not exist cannot be populated. |
| [`src/manifest/validate.js`](src/manifest/validate.js) | Refuses a manifest that weakens the rule. |
| [`tests/manifest.test.js`](tests/manifest.test.js) | Asserts the refusals. |

## What this note does not claim

This is a demo repository with no users and no production deployment, so nothing
here has been audited, and no real person's data has ever passed through it. The
value of the privacy block is that it is **declared, validated and hashed into
the artifact** — which is a property a reviewer can check in about ten minutes,
not a guarantee about a system that does not exist.
