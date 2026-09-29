# Handoff: Phase 3 — release integration and pilot readiness

**Status: local GitHub Action preview implemented; production acceptance not
met.** `.github/actions/atlas-target-qa` runs the actual CLI target matrix and
gate on a GitHub runner, then creates a commit-scoped GitHub Check Run. It
defaults to advisory mode; INCONCLUSIVE/harness errors fail even there. The
workflow path and verdict mapping have mocked API/unit coverage, but no real
GitHub repository, controlled PR, or external staging app has been exercised.
The runner is not the isolated Phase 2 worker and cannot safely serve as a
hosted arbitrary-URL service. There are no observed design-partner interviews,
pilots, paid customers, or willingness-to-pay evidence.

## Prerequisites

Do not enable blocking checks for a team's release until Phase 2 can execute
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
3. **Local preview exists:** `.github/actions/atlas-target-qa` runs the actual
   target matrix/gate, creates a commit-scoped Check Run, and links to the
   workflow run. See [`../github-target-check.md`](../github-target-check.md).
   It runs the CLI on the workflow runner instead of submitting to the hosted
   control plane; a report artifact is uploaded only if the consumer workflow
   explicitly opts in.
4. The action defaults to advisory (`HOLD` is `neutral`), supports explicit
   blocking (`HOLD` is `failure`), and fails both modes on `INCONCLUSIVE` or
   harness error. GitHub treats `neutral` as satisfactory for required checks,
   so advisory checks must not be configured as required. Live Check Run API,
   rerun history, worker outage and controlled PR behavior remain to validate.
5. The direct Check Runs API path uses the workflow's narrowly scoped
   `checks:write` token; it does not accept webhooks. There is no organization
   installation, persistent API token or hosted service connection. Before a
   hosted integration, scope tokens per project/repo, secure event signatures
   and replay handling, and audit gate-policy changes.
6. Add notifications only for destinations selected by the project owner and
   after explicit user approval.

## Validation plan and acceptance

Still required: use a controlled PR against an owned staging app. Introduce a real regression
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
- Local GitHub Action: `.github/actions/atlas-target-qa/action.yml` and `run.js`.
- Action workflow guide: [`../github-target-check.md`](../github-target-check.md).
- Mocked Check Run/action verification:
  [`../evidence/phase3-github-target-check-2026-09-30.md`](../evidence/phase3-github-target-check-2026-09-30.md).
- Gate and policy foundation: `src/gate/`, `src/targets/`,
  `src/report/`, `tests/gate.test.js`, `tests/target-contract.test.js`.
- Control-plane API and queued records: `apps/control-plane/src/server.js`.
  The opt-in local Docker worker can execute these queue entries; hosted worker
  scheduling remains unavailable.
- Prior phase handoffs: [`phase-1.md`](phase-1.md),
  [`phase-2.md`](phase-2.md).

## User decisions before external integration

The user must decide whether checks may block merges, which project/repositories
are in scope, what evidence a private client can see, notification destinations,
and whether to open/use any GitHub app, hosted service, or billable worker
infrastructure. Do not make those account, spend, access, or policy decisions
on their behalf.
