# The trace schema

A trace is the whole record of one session: what the device looked like, what was
decided, what happened, in what order, and how long each part took. It is the
only evidence the release gate and the trace judge ever see, and it is the thing
replay compares.

The authoritative definition is the `Trace` interface in
[`types/atlas.d.ts`](../types/atlas.d.ts). This document explains the shape and,
more usefully, why each part is shaped that way.

Working examples live in [`examples/traces/`](../examples/traces/) — read one
alongside this page. Generate them with:

```bash
node bin/atlas.js fixtures
```

## Two rules that shape everything else

**No wall-clock timestamps inside the trace.** Every event and checkpoint carries
`tOffsetMs`, an offset from the session's own start. The single absolute timestamp
is `startedAtIso` on the envelope, and it is excluded from every comparison. This
is a determinism requirement and a privacy requirement at once
([ADR-0004](adr/0004-determinism-model.md), [PRIVACY.md](../PRIVACY.md)).

**No free text.** No field in this schema accepts user-authored content. There is
no `label`, no `message`, no `note` a page can write into. `notes[]` exists but is
written by the harness, not by the experience. This closes the most common
accidental-leak path: a debug field that ends up carrying a form value.

## OTel-shaped, without OpenTelemetry

The layout is deliberately familiar: `resource` attributes describe what produced
the trace, events carry a name, a kind and a flat attribute bag.
`toOtlpSpans()` in [`src/trace/schema.js`](../src/trace/schema.js) emits a
structure an OTLP/JSON collector would accept.

That function is not used by the pipeline. It exists so the claim "this schema
would not look out of place next to a real tracing pipeline" is demonstrable
rather than asserted, and it is exercised by `tests/trace.test.js`.

## The envelope

```jsonc
{
  "schemaVersion": 1,
  "traceId": "…",
  "resource": {
    "service.name": "atlas-replay-lab",
    "service.version": "0.1.0",
    "atlas.manifest.id": "orbital",
    "atlas.manifest.version": "1.4.0",
    "atlas.manifest.hash": "…",      // content hash — see below
    "atlas.profile.id": "low-cpu-3g",
    "atlas.run.kind": "baseline",     // baseline | adaptive | replay | production
    "atlas.emulated": true,           // false only on real hardware
    "atlas.seed": 726945                // 0x0b17a1, the default capture seed
  },
  …
}
```

Three of these carry more weight than they look like they do.

**`atlas.manifest.hash`** is the manifest's content hash
([ADR-0003](adr/0003-manifest-as-contract.md)). Because it is in the trace, a
trace cannot be replayed against a manifest it was not recorded against, and a
report cannot silently mix results from two different quality ladders.

**`atlas.emulated`** is `true` under the matrix and `false` only when a session
ran on real hardware. Every report reads this field rather than assuming, because
the difference between "we emulated a low-end Android" and "we tested on a low-end
Android" is the single most over-claimed thing in this category of tooling.

**`atlas.seed`** is the RNG seed the session ran under. Replay determinism is
*conditional* on it matching, which is why it is deliberately **not** part of the
determinism hash — it is a precondition of the comparison, not a result of it.

## Capability

```jsonc
"capability": {
  "deviceMemoryGB": 2, "hardwareConcurrency": 4,
  "gpuTier": "low", "webglVersion": 1,
  "webgpuAvailable": false, "webcodecsAvailable": false,
  "cameraPermission": "granted",
  "effectiveConnectionType": "3g", "downlinkMbps": 1.1, "rttMs": 380,
  "reducedMotionPreferred": false,
  "viewport": { "width": 360, "height": 780 },
  "recentFrameTimeMsP95": null
},
"capabilityBucket": {
  "compute": "weak", "network": "poor",
  "graphics": "basic", "camera": "usable",
  "id": "weak/poor/basic/usable"
}
```

The snapshot is what the probe read, after `normalizeSnapshot`
([`src/capability/buckets.js`](../src/capability/buckets.js)) has bucketed it and
stripped the identifying fields. There is no user agent, no IP, no storage id, no
fingerprint. The list of what is never collected is in
[PRIVACY.md](../PRIVACY.md) and is enforced by the manifest validator.

`capabilityBucket` is the coarse label every report and aggregation groups by.
Aggregating on the snapshot instead is how a privacy-safe telemetry system stops
being one, so the bucket exists to make the safe path the convenient one.

## The decision

```jsonc
"decision": { "tier": "low", "path": "interactive-2d", "confidence": 0.81,
              "engine": "rule-based", "distribution": { … },
              "rationale": [ … ], "guard": null },
"servedTier": "low",
"servedPath": "interactive-2d"
```

`decision` is the full `TierDecision` the engine returned, including the
probability distribution and — when a model was configured — the `guard` report
saying whether the guard overrode it and why
([ADR-0005](adr/0005-decision-engine-interface.md)).

`servedTier` and `servedPath` are what the session *actually ran*. They are
recorded separately from the decision on purpose: a baseline run has the router
bypassed, so the decision and the served tier disagree, and that disagreement is
the "before" half of the failure story.

`rationale` is populated by the rule engine and is always `[]` for the Jev engine,
because Jev has no string channel. See
[ADR-0006](adr/0006-jev-typed-answers-only.md).

## States and events

```jsonc
"states": ["boot","probing","routing","loading","first-frame","interactive",
           "product-detail","cart","checkout-complete"],
"events": [
  { "tOffsetMs": 0,    "name": "boot",                 "kind": "lifecycle",   "attributes": { … } },
  { "tOffsetMs": 18,   "name": "tier-selected",        "kind": "decision",    "attributes": { … } },
  { "tOffsetMs": 742,  "name": "asset:tex-low",        "kind": "asset",       "attributes": { "bytes": 62000, "ok": true, … } },
  { "tOffsetMs": 1042, "name": "first-frame",          "kind": "lifecycle",   "attributes": { "nonBlank": true, … } },
  { "tOffsetMs": 2100, "name": "interaction:tap:product", "kind": "interaction", "attributes": { "class": "tap:product", "latencyMs": 148 } },
  { "tOffsetMs": 2000, "name": "frame-sample",         "kind": "frame",       "attributes": { "rendered": 27, "dropped": 3, … } }
]
```

`states` is the ordered state sequence — the session's causal spine. Its **order
is load-bearing**: reordering two states makes it a different session, and the
determinism hash treats it that way.

Seven event kinds: `lifecycle`, `asset`, `state`, `interaction`, `frame`,
`decision`, `error`.

The `interaction` events are where the privacy boundary is most visible. An
interaction is recorded as a **class label plus a latency**, and nothing else. The
coordinates were used to dispatch the event and then discarded. This is why the
interaction invariant is expressed as a p95 latency rather than as a heatmap — the
data for a heatmap was never kept.

`frame` events are sampled counters, and they are the one kind the determinism
hash ignores (see below).

## Checkpoints

```jsonc
"checkpoints": [
  { "id": "cp-first-frame", "state": "first-frame", "tOffsetMs": 1042,
    "screenshotPath": "artifacts/matrix/low-cpu-3g/cp-first-frame.png",
    "focalCoverage": 0.121, "alphaEdgeDrift": null }
]
```

The manifest declares which states are checkpoints, and the runner captures a
screenshot at each. `focalCoverage` and `alphaEdgeDrift` are measured **on the
Node side from the decoded PNG**, never in the page — a page that is failing to
render is not a trustworthy reporter of whether it rendered.

`focalCoverage` is the fraction of the viewport the focal product layer occupies.
It answers the question no timing number can: *was anything actually drawn?* A
first frame that arrives in 400ms and is blank is worse than one that arrives in
1200ms and is not, and the visual invariant is written to catch exactly that.

`alphaEdgeDrift` is instability against the previous checkpoint, and is `null` at
the first one because there is nothing to compare against.

## Metrics are derived, never declared

```jsonc
"metrics": {
  "firstFrameMs": 1042, "timeToInteractiveMs": 1380,
  "p50InteractionMs": 148, "p95InteractionMs": 159.7, "interactionCount": 3,
  "framesRendered": 81, "framesDropped": 9, "droppedFrameRatio": 0.1,
  "transferBytes": 62000, "assetFailures": 0, "jsHeapUsedMB": 66,
  "reachedEndState": true, "stepsToEndState": 3, "firstFrameNonBlank": true
}
```

Every one of these is computed by `deriveMetrics()` from the event stream. None is
written directly, by the page or by anything else.

This matters for a specific reason: it means a trace captured by the browser and a
trace reconstructed from disk go through **the same derivation**. A metric written
at capture time could disagree with its own events, and the report would have no
way to know which was right.

It also means a synthetic fixture cannot cheat. A fixture claiming a 4310ms first
frame has to contain an event at 4310ms, and the number reaches
`metrics.firstFrameMs` by the same path a real capture takes.

## The determinism hash

```jsonc
"determinismHash": "…",
"startedAtIso": "2026-01-01T00:00:00.000Z",
"durationMs": 8200,
"notes": ["…"]
```

`determinismHash` is sha256 over the *normalised* trace. Normalisation
([`src/trace/normalize.js`](../src/trace/normalize.js)) is where the tolerance
lives, and it is explicit:

| Ignored | Never ignored |
|---|---|
| `traceId` | the state sequence **and its order** |
| `startedAtIso` | `lifecycle`, `interaction`, `asset` and `error` events |
| `durationMs` | checkpoints |
| JS heap figures | `servedTier`, `servedPath` |
| `frame`-kind events | the capability bucket |
| any attribute not on the allow-list | the manifest hash |

The dividing line is causality. A frame counter is a *performance* observation; a
reordered state is a *different session*.

Event offsets are quantised to `TIME_QUANTUM_MS = 8` before hashing. Two runs
whose events land in the same 8ms bucket are timing-identical for comparison
purposes; a run that shifts by 400ms is not.

Replay computes a second hash, `causalHash()`, which drops `t` from every event
and checkpoint — *"the same things happened, whenever they happened."* Neither is
stored on the trace; both are computed at comparison time. Two hashes rather than
one tolerance parameter means the replay report can say **which kind of sameness**
held instead of collapsing both into a boolean whose meaning depends on a
threshold the reader cannot see.

## Reading the examples

Ten example traces ship in [`examples/traces/`](../examples/traces/), one per
scenario in [`src/decision/fixtures/traces.js`](../src/decision/fixtures/traces.js).

**They are hand-authored, not captured.** Every one carries this as `notes[0]`:

> `SYNTHETIC: hand-authored fixture, not a captured session. Timings are invented.`

They are structurally real — built through the same `newTrace` → `finalizeTrace`
path the live runner uses, with correctly derived metrics and a real determinism
hash — which makes them legitimate as fixtures and as documentation of the schema.

They are **not** legitimate as evidence, and nothing in the failure story quotes
them. The before/after numbers come from `artifacts/matrix/`, captured by a real
throttled Chrome. The pairing worth reading first:

| | |
|---|---|
| `fail-baseline-low-cpu-3g.json` | high tier forced onto a device that cannot carry it |
| `pass-adaptive-low-cpu-3g.json` | same device, same network, engine chose the tier |

Same profile, same seed, one difference. That is the whole argument of the
project, in two files.
