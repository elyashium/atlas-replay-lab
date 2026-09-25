# Atlas release QA roadmap

This roadmap replaces the old visitor showcase plan. Atlas is for Web3D, WebAR,
and interactive commerce teams that need evidence for a release decision. It is
not a generic XR builder. See [`product-brief.md`](product-brief.md) for the
product direction and [Phase 0 evidence](evidence/phase0-2026-09-26.md) for the
latest measured local run.

## Existing CLI foundation

The repository contains an offline CLI and controlled Orbital experience,
profile matrix, trace capture, replay, static URL preflight, generic URL probe,
`.glb` viewer path, trace judge, and release gate. They are starting components
for the product, not a complete customer workflow.

- `matrix --url` observes a supplied third-party page with generic behavior. It
  does not verify ownership, understand the site's success condition, perform
  an authenticated customer journey, or adaptively repair that site.
- `matrix --glb` evaluates the Atlas viewer around the uploaded asset. It does
  not measure the asset inside a customer's eventual host application.
- Injected WebXR behavior is synthetic. CDP network/CPU and viewport profiles
  are emulations, not physical device, Safari, radio, GPU, thermal, or camera
  tests.
- The controlled Orbital experience is a separate demonstration. A successful
  Orbital run says nothing about another team's app.

## Phase 0 — trustworthy local proof

**Current status: incomplete.** Portable test discovery and local fixes are in
place, and the latest environment passed the unit suite and `doctor`. The full
Orbital run produced HOLD: its adaptive profile missed declared timing budgets,
the WebGL-unavailable lane failed its visual invariant, and replay screenshots
did not reproduce within tolerance. See the evidence note for metrics and exact
limits. No clean before/after recording is claimed.

Exit only when a fresh baseline exposes a meaningful declared-budget failure,
the adaptive result meets the stated policy, captured journeys replay within
the defined evidence tolerance, and the generated report has been visually
checked at desktop and mobile sizes. Show only numbers from those artifacts.

## Phase 1 — owned staging contract

Make owned staging URLs the primary customer mode. Add a versioned contract
that can be configured without editing Atlas source:

- verified domain or explicitly authorized private target;
- allowed origins and redirect policy;
- environment and scoped test credential strategy;
- journey steps for load, interaction, optional XR, and declared completion;
- stable success/fallback selectors or events;
- interaction budgets, critical profiles, and per-target gate policy.

Surface missing selectors, blocked authentication, unsatisfied steps, and
harness failures as distinct evidence states. A generic gesture must not claim
business success. Compare versions under the same target contract and profile,
and state whether customer code or Atlas's runner changed. Mark a captured
journey replayable only when input and instrumentation fidelity support it.

## Phase 2 — hosted application

Wrap the versioned CLI engine with a web UI and API. Provide organization and
project access, target verification, contract setup, explicit screenshot/egress
consent, dry run, queued isolated Chrome workers, run status, cancellation,
retry/idempotency, and reports with metrics, screenshots, traces, and policy
versions. Keep profiles sequential within each worker and isolate browser state
between jobs and tenants.

Do not expose arbitrary public URL runs until SSRF/DNS rebinding protections
cover redirects and browser subresources, with network isolation and allowlists.
Bound upload types/sizes/resources, execution time, CPU, memory, disk, and
quotas. Demonstrate per-tenant access controls, audit logs, secrets scrubbing,
and retention deletion including shared links and backups before hosted launch.

## Phase 3 — target build release status

Submit the actual target commit/build to a GitHub status check. Return
SHIP/HOLD/INCONCLUSIVE with the policy version and report link. Unavailable
workers and missing evidence cannot become green. Verify a controlled PR fails
on a reproduced regression and passes after the target fix.

## Later work

Physical Android/iPhone coverage and consent-based production monitoring are
separate later lanes. Record specific device and browser versions, run counts,
provenance, and privacy limits. Native applications, pricing/billing,
compliance claims, and auto-remediation are outside the current scope.
