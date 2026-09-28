# Handoff: Phase 3 — release integration and pilot readiness

**Status: not implemented.** The repository has CI for Atlas's unit suites and
control-plane tests; it does not have a GitHub status check that submits a
customer target build, waits for the real browser matrix, and gates a PR. There
are no observed design-partner interviews, pilots, paid customers, or willingness-
to-pay evidence.

## Prerequisites

Do not start the blocking status-check implementation until Phase 2 can execute
real isolated jobs, retain report artifacts safely, and enforce quotas and
tenant access. Do not represent current `npm test` or current CI as target-app
release QA. Unit tests validate Atlas; they do not validate the app being
released.

## Work plan

1. Define a versioned release-gate policy with critical-profile coverage,
   declared hard business/fallback invariants, comfort/visual thresholds,
   score floor, and raw component evidence. Persist the exact policy version
   and target contract into every submitted run.
2. Define a target-build binding: repository/commit or immutable build URL,
   allowed staging target, contract version, profiles, policy version, and
   Atlas engine/browser build versions. Reject ambiguous/mutable build labels
   where they cannot identify the tested bits.
3. Implement an advisory GitHub Action/status check that submits the target
   build, polls an idempotent run, and reports SHIP/HOLD/INCONCLUSIVE plus a
   private report link. Never let unit-test success stand in for a target run.
4. Make blocking behavior an explicit repository/project policy. Worker
   unavailable, timeout, incomplete evidence, webhook/API failure, or
   inconclusive result must never turn green. Preserve reruns and the prior
   verdict/policy history.
5. Authenticate webhooks with signatures and replay protection; scope tokens
   to one project/repo and limited operations; redact secrets; audit all gate
   changes. Security-test duplicate, delayed, forged, and out-of-order events.
6. Add notifications only for destinations selected by the project owner and
   after explicit user approval.

## Validation plan and acceptance

Use a controlled PR against an owned staging app. Introduce a real regression
that breaks a declared journey or fallback and confirm the status returns
HOLD. Fix the target app and confirm SHIP under the same contract/profile. Save
the run IDs, commits, policy version, screenshots/traces, status event history,
and PR link. Force a worker outage and prove it cannot become green. Test
advisory mode separately from blocking mode and reruns after a policy change.

Recruit design partners only after the user authorizes outreach. Record actual
interviews and observed trial outcomes verbatim with consent/context; do not
invent customer quotes or infer demand from the product thesis. Measure support
burden, end-to-end failure rate, time-to-diagnosis/fix, and full per-run cost
(compute, storage, device minutes, optional Jev). Report sample sizes and
selection bias. No paid-pilot readiness claim without those measurements.

## Current repo entry points

- Current CI: `.github/workflows/ci.yml` (unit suites only; no target worker).
- Gate and policy foundation: `src/gate/`, `src/targets/`,
  `src/report/`, `tests/gate.test.js`, `tests/target-contract.test.js`.
- Control-plane API and queued records: `apps/control-plane/src/server.js`.
  These records are not executable runs yet.
- Prior phase handoffs: [`phase-1.md`](phase-1.md),
  [`phase-2.md`](phase-2.md).

## User decisions before external integration

The user must decide whether checks may block merges, which project/repositories
are in scope, what evidence a private client can see, notification destinations,
and whether to open/use any GitHub app, hosted service, or billable worker
infrastructure. Do not make those account, spend, access, or policy decisions
on their behalf.
