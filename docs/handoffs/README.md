# Atlas agent handoffs

These notes let a new coding agent pick up Atlas's release-QA roadmap without mistaking a local fixture or a design for a shipped customer workflow. Read [`../../AGENTS.md`](../../AGENTS.md) first; its safety and repository rules override any implementation suggestion here.

## Current state at handoff

At the prior handoff commit `6f0fc48` (`Harden queued run provenance and onboarding`), the local CLI engine remained zero-dependency and the separate `apps/control-plane` was a local Fastify/PostgreSQL foundation. Hosted execution and browser workers remain disabled. The preceding verified slice had root tests passing 363/363, `doctor` passing on Node 20.18.0 / Chrome 154.0.8037.58, and control-plane tests passing 17/17 against PostgreSQL 17. This continuation adds a locally tested egress-proxy component; see Phase 2 and ADR-0008 for current status. None of these checks establish customer acceptance or hosted safety.

The current working slice also uses the shared destination classifier for control-plane onboarding, requires immutable build and policy binding on queued requests, cancels legacy unbound rows in migration 002, and rejects idempotency key reuse across targets. It does not enable browser execution.

## Handoffs

- [Phase 0: trustworthy local proof](phase-0.md)
- [Phase 1: owned staging experience](phase-1.md)
- [Phase 2: hosted control plane](phase-2.md)
- [Phase 3: release integration and pilot readiness](phase-3.md)
- [Phase 4: real devices and production monitoring](phase-4.md)
- [Phase 5: guarded remediation](phase-5.md)
- [Commercial design and billing](commercial.md)
- [Security, privacy, and operations](security-operations.md)

## Rules for the next agent

1. Start with `node bin/atlas.js doctor`, inspect the current commit and worktree, then run the test command appropriate to the package before editing. Do not trust stale generated artifacts as current evidence.
2. Keep implemented, tested, measured, illustrative, hypothesized, and planned claims distinct. Record exact command, environment, sample size, pass/fail, and artifact location.
3. Preserve the offline CLI and zero-dependency root package, versioned contracts, trace/hash rules, deterministic gate, fail-closed Jev boundary, and privacy rules in `AGENTS.md` / `PRIVACY.md`.
4. Do not enable browser workers or expose the local control plane publicly until Phase 2's egress, isolation, upload, quota, retention, and tenant isolation gates have test evidence. A `queued` row is not a test run.
5. Do not open external accounts, spend money, start subscriptions, contact design partners, or bill real customers without the user's explicit authorization required by the product brief.
6. At each phase boundary report shipped files/commit, exact verification, failures and limitations, privacy/security decisions, evidence sample sizes, remaining proposed work, and decisions needed from the user.

## Roadmap sequence

Finish Phase 0 evidence gaps, then close Phase 1 with an authorized outside-team staging target. Continue Phase 2 locally and behind disabled execution until its safety gates are real. Only then start Phase 3. Phase 4 and Phase 5 are later lanes; commercial and compliance work must remain evidence-based and cannot be inferred from product intent.
