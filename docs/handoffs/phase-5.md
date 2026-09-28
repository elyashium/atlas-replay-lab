# Handoff: Phase 5 — guarded remediation

**Status: not implemented and intentionally last.** Atlas does not patch a
customer repository or automatically fix an arbitrary staging site. Diagnosis
and developer-readable advice can be explored after real target QA works, but a
coding-agent integration is not a substitute for evidence.

## Recommended sequence

1. Improve deterministic diagnosis first: attach the failing contract step,
   profile, trace slice, console/network category (scrubbed), artifact, and
   policy rule to a concise finding. Keep observations separate from inferred
   causes and suggested changes.
2. Add optional fix suggestions that name expected trade-offs and cite the
   evidence. Validate suggestions against representative controlled targets
   before making broad claims.
3. If integrating a coding agent, require a user-authorized, narrowly scoped
   repository permission; operate on an isolated branch/worktree; show the full
   patch, touched files, tests, target contract and security impact; and let a
   human create/review the PR.
4. Run the candidate patch against the exact original target/profile/policy
   matrix and compare immutable commit/run IDs. Reject improvements that break
   business invariants, safe fallback, security, accessibility, or other
   critical profiles.
5. Keep human merge/deploy approval mandatory. Never auto-merge or silently
   deploy. For sites without source access, provide reproduction and advice,
   not a fake patch.

## Acceptance

A reviewed patch reproduces and improves a real failure without regressions;
the report links exact before/after commits, contracts, policies, tests, runs,
and artifacts. The customer or authorized engineer accepts the patch. Until
then, remediation is planned, not shipped.

## Current repo entry points and guardrails

- The deterministic rule engine and release gate remain authoritative for hard
  invariants: `src/decision/`, `src/gate/`.
- Jev is optional semantic triage inside a fail-closed guard. It cannot drive
  the browser or loosen hard gate results. Follow `AGENTS.md`, ADR-0005/0006,
  pin live model versions, and label fixtures illustrative.
- Do not transmit raw media, secrets, personal data, unreviewed screenshots,
  or whole customer traces to a model/coding provider by default. Obtain
  separate consent and document third-party egress if a future design requires
  it.
- No repository write token, coding-agent account, auto-fix flow, or patch
  success evidence exists now.
