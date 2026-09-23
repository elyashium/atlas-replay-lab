# Atlas Product Brief & Implementation Plan

Version 0.1 — 2026-09-22. Plan, not code. Supersedes nothing; sits beside
`docs/showcase-roadmap.md` (which covers the demo path — this covers the
business).

## 1. Thesis

Every visual experience ships with a testable contract, and Atlas is where the
contract gets enforced — before launch and in the field. The product is not a
report. It is a **release system**: submit a build or URL, get a verdict per
device class with replayable proof, ship or hold, keep watching in production.

## 2. Who pays

| Segment | Example | Pain (their words) | Willingness signal |
|---|---|---|---|
| A. WebAR campaign agencies/studios | 8th Wall shops, brand-experience builders | "The campaign worked on our phones and broke on the client's customer's phones." Launch-day brand damage, unbillable firefighting. | Per-campaign QA budgets already exist (manual device testing); we replace a cost, not create one. |
| B. E-commerce 3D/AR teams | Furniture, eyewear, cosmetics try-on | "Our 3D viewer converts on iPhone and we have no idea what it does on mid Androids." Attribution gap, not a bug queue. | Conversion teams pay for measurement that moves a number. |
| C. Instant-delivery experience platforms | Flam-shaped companies | "Ordinary smartphones" is the promise and the untested surface. Every campaign is a new untested build at scale. | Scale makes manual QA impossible — automation is the only offer. |

Entry order: A → B → C. Agencies have the shortest sales cycle, the clearest
per-project budget, and their public scores become our marketing. E-commerce
needs the production loop (retainer). Platforms come when the score is a
standard they must clear, not a tool they evaluate.

## 3. Jobs to be done (what "helpful" means, concretely)

1. **Before I launch, tell me which device classes will break** — with proof,
   not a score. (Certification.)
2. **Block my release when proof says hold** — inside the CI I already use.
   (Gate.)
3. **When it breaks, show me the exact divergence and the tier that fixes
   it** — so my engineer fixes in hours, not sprints. (Replay.)
4. **Watch my real users and catch what the lab missed** — every session, not
   a sample, because sampling misses the long tail of Android. (Observability.)
5. **Give me a number I can put in a client contract.** (Atlas score.)

## 4. Product: three loops

### Loop 1 — Certification (entry wedge, first revenue)

Input: URL or uploaded build (`.glb` viewer harness per showcase roadmap;
third-party URLs per Slice 1). Pipeline: pre-flight risk → adversarial matrix
(emulated, 8 profiles incl. XR grant/deny) → traces → replay of failures →
per-profile verdicts + Atlas score → SHIP/HOLD. Output: a certification page
per build (shareable with the *client*, not just the dev team) with replayable
proof attached to every HOLD.

### Loop 2 — Gate (stickiness)

GitHub Action + webhook: matrix runs per PR/build, HOLD blocks merge. The
gate rule is customer-editable (which profiles are critical, score floor,
comfort floor) but versioned and hashed into every report — a customer can
move their own goalposts, and the audit trail shows when. This is what turns
a tool into infrastructure: removing Atlas breaks their pipeline.

### Loop 3 — Production observability (retainer, moat)

RUM probe (grown from `capability-probe.js`): frame-time series, XR session
events, fallback hits, console errors. Still no camera frames, no audio, no
coordinates — the probe is the enterprise sales argument as much as the data
is. Traces stream into the same judge; failure memory auto-files repeat field
failures as regressions;PLAY: weekly "lab-missed" digest per customer (device
classes failing in the field that passed in the matrix → matrix expands).

### The score as standard (compounding moat)

Atlas score 0–100, versioned weights, raw dimensions always published. Sold
into agency→brand contracts ("campaign must hold ≥80 across contracted device
classes"). Once quoted publicly, switching costs accrue to the score itself.
Guardrails: weights change only in minor versions, old scores stay verifiable
against pinned weight versions, methodology page is public.

## 5. Packaging & pricing (grounded in measured cost)

Measured 2026-09-22 (jev-1.13.0): judge ≈ $0.00015/trace, full 22-call compare
≈ $0.0023, preflight ≈ $0.00001. Emulated matrix compute ≈ cents per run on
commodity CI runners. Pricing floors sit 50–300× above unit cost at every tier.

| SKU | Includes | Price anchor | Margin logic |
|---|---|---|---|
| Certification run | 1 URL/build, full matrix + replays + score page | $49–199/run (vs. $500+ half-day manual QA) | Compute + ~30 Jev calls ≈ $0.05 |
| Campaign pack (agencies) | 20 runs, 3 seats, client-shareable pages | $499/campaign | Prepay, expire per campaign |
| CI gate (team) | Unlimited gate runs, 1 project, GitHub Action | $299/mo | Runs are cheap; the block is the value |
| Production watch (retainer) | RUM probe + full-trace triage to 1M sessions/mo + weekly digest | $999/mo + $0.01/1k sessions overage | $0.00015/trace cost → 60×+ headroom |
| Enterprise | SSO, custom retention, curated real-device confirmation, SLA, DPA/SOC 2 | Custom, $25k+/yr | Device rig + compliance amortized |

Free tier: public-URL certification with watermarked report (lead gen; every
free report markets the score).

## 6. Architecture (from this repo, not instead of it)

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────────┐
│ probe.js    │────▶│ control plane    │────▶│ matrix workers    │
│ (<5KB, zero │trace│ (API, auth, orgs,│ jobs│ (this repo's      │
│  deps, MIT-  │     │  trace store,   │     │  runner + CDP,     │
│  licensed)   │     │  gate eval,     │     │  containerized)   │
└─────────────┘     │  judge fan-out,  │     └───────────────────┘
                    │  report pages)   │     ┌───────────────────┐
┌─────────────┐     └──────────────────┘────▶│ real-device rig   │
│ CI action   │ gate│  Postgres (traces│     │ (Stage 4: curated │
│ (thin: POST │◀───▶│  metadata+index; │     │  10 devices, farm │
│  build, poll│     │  blob store for  │     │  API for long tail)│
│  verdict)   │     │  artifacts)      │     └───────────────────┘
└─────────────┘     └──────────────────┘
```

- **This repo becomes `atlas-core`** (the engine): manifest, runner, trace,
  replay, gate, judge, score — stays zero-dependency, stays the open,
  auditable heart. Commercial service wraps it; never forks it.
- **Control plane is a new service** (deps allowed — it's a service, not the
  engine): job queue, orgs/auth (OAuth + API keys), trace store with
  retention *enforced* (the manifest's 30 days becomes a cron job, not a
  paragraph), artifact blob storage, report rendering, billing hooks.
- **Data model**: org → project (build/URL + manifest + gate policy version)
  → certification run (matrix report + replays + score) → verdicts; production
  sessions → traces → judgements → incidents (failure-memory clusters).
- **API surface (v1)**: `POST /runs` (submit URL/build), `GET /runs/:id`
  (verdicts+score), `POST /sessions/traces` (RUM ingest), `GET /score/:build`
  (contract badge), webhooks for HOLD/SHIP. CI action is a 100-line wrapper.
- **Determinism boundary**: emulated runs reproducible by seed (as today);
  real-device runs labeled `emulated:false`, never compared pixel-to-pixel
  against emulated — only verdict-to-verdict.

## 7. Build plan (phases, milestones, acceptance)

**Phase 0 — Foundations (2–3 weeks, solo-dev feasible)** — engine side DONE (2026-09-23)
Slice 1 of the showcase roadmap (generic URL target) is built and tested
(`matrix --url`, generic probe/driver/manifest, `tests/generic.test.js`), as
are the building blocks Phase 1 assumes: Atlas score v1 (`src/gate/atlas-score.js`),
score floor in the gate (rule 8), batch triage (`atlas judge`), failure memory
(`src/gate/incidents.js`), and static preflight (`atlas preflight`). Remaining
for the phase: multi-run isolation + hosted report pages behind auth (the
control-plane half — new service, not this repo). Done when: a stranger's URL
can be submitted and certified with zero operator involvement.

**Phase 1 — Sellable certification (4–6 weeks)**
Control plane MVP: orgs, API keys, Stripe (run packs), shareable
certification pages, `.glb` upload harness, Atlas score v1 with published
methodology. 5 pilot agencies free in exchange for public numbers.
Done when: first paid campaign pack + one public "Atlas 84" case study.

**Phase 2 — CI gate + stickiness (4 weeks)**
GitHub Action, customer-editable versioned gate policies, HOLD-blocks-merge
reference customer. Done when: a customer says removing Atlas breaks their
pipeline (that sentence is the milestone).

**Phase 3 — Production watch (6–8 weeks)**
RUM probe v1 (framework-agnostic snippet), ingest at volume (queue +
sampling policy: judge everything under the unit-cost ceiling, degrade
gracefully above it), failure memory, weekly digest. Done when: first
"lab-missed" catch — a field failure the matrix missed, auto-filed with
replay — at a paying customer.

**Phase 4 — Real-device confirmation (after revenue)**
Curated 10-device rig for the failure classes the data says emulation misses
(thermal, real GPUs, radios); farm API for long-tail coverage. Buy hardware
the Phase 3 data justifies, not before. Done when: enterprise deal requires
it and the rig exists because revenue paid for it.

## 8. Risks & answers

- **Emulation fidelity ceiling.** Real GPUs/thermals/radios differ. Answer:
  label honestly, confirm on rig for enterprise, expand matrix from field
  data (Loop 3 feeds Loop 1 — the system gets truer with scale).
- **Jev dependency.** Early-access vendor, price/API drift. Answer: already
  architected — rule-based default, Guarded wrapper, fixture path, versioned
  model pinning; cost ceiling enforced in code (sampling policy, per-org caps).
- **Privacy/compliance as blocker.** Camera-adjacent product + third-party
  model calls. Answer: the architecture IS the argument — no raw media by
  schema, summaries-only egress, opt-in key, retention enforced; SOC 2 Type I
  before enterprise.
- **Score gaming.** Vendors optimizing for the metric. Answer: versioned
  weights, pinned verifiability, methodology public, weights reward real
  robustness (comfort floors, fallback proof) not单一 metrics.
- **Single-dev bandwidth.** Answer: phases are ordered so each funds the
  next; Phase 0–1 need no hardware, no compliance, no sales team — just the
  engine (built), a control plane, and five friendly studios.

## 9. Metrics that matter (instrument from day one)

Per-customer: HOLD→fix→SHIP cycle time, lab-missed rate (field failures per
certified build), score trend per project, cost per certified build (target:
<$1 all-in). Business: paid campaign packs, gate-blocked merges/wk (stickiness
proxy), traced sessions/mo, gross margin per SKU (target: >85%).

## 10. What this repo already proves (the unfair start)

Deterministic matrix + privacy-safe traces + replay with first-divergence +
fail-closed guarded decisions + measured $0.00015/trace triage + a live Jev
run with honest numbers. Most competitors start from a dashboard. This starts
from evidence.
