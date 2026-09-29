# Atlas agent handoffs

These notes let a new coding agent pick up Atlas's release-QA roadmap without
mistaking a local fixture or a design for a shipped customer workflow. Read
[`../../AGENTS.md`](../../AGENTS.md) first; its safety and repository rules
override any implementation suggestion here.

## Current state at handoff

Repository HEAD: `d38b252` (`Add deterministic diagnosis findings`). The local CLI
engine remains zero-dependency. The separate `apps/control-plane` is a local
Fastify/PostgreSQL foundation; no hosted service or browser worker is enabled.
The latest recorded root suite run passed 264/264, `doctor` passed on Node
20.18.0 / Chrome 154.0.8037.57, and the local control-plane suite passed 13/13
with PostgreSQL. The guided setup UI was captured and visually inspected at
desktop 1440 px and emulated mobile 390 px with no horizontal overflow. These
checks do not establish customer acceptance or hosted safety.

**Uncommitted and unverified in the worktree** (Phase 5 item 1 reachability): the
`findings` command wired into `bin/atlas.js` and into the `all` pipeline,
IO-shell tests for `runFindings` in `tests/diagnose-findings.test.js`, a
`Diagnosis` section in the HTML report with its own tests, and the README /
AGENTS updates that describe them. The recorded 264/264 figure predates all of
it. Re-run `npm test` and `node bin/atlas.js doctor` and record the result
before treating any of it as verified — per rule 1, the number above is evidence
about `d38b252`, not about the worktree.

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

1. Start with `node bin/atlas.js doctor`, inspect the current commit and
   worktree, then run the test command appropriate to the package before
   editing. Do not trust stale generated artifacts as current evidence.
2. Keep implemented, tested, measured, illustrative, hypothesized, and planned
   claims distinct. Record exact command, environment, sample size, pass/fail,
   and artifact location.
3. Preserve the offline CLI and zero-dependency root package, versioned
   contracts, trace/hash rules, deterministic gate, fail-closed Jev boundary,
   and privacy rules in `AGENTS.md` / `PRIVACY.md`.
4. Do not enable browser workers or expose the local control plane publicly
   until Phase 2's egress, isolation, upload, quota, retention, and tenant
   isolation gates have test evidence. A `queued` row is not a test run.
5. Do not open external accounts, spend money, start subscriptions, contact
   design partners, or bill real customers without the user's explicit
   authorization required by the product brief.
6. At each phase boundary report shipped files/commit, exact verification,
   failures and limitations, privacy/security decisions, evidence sample sizes,
   remaining proposed work, and decisions needed from the user.

## Roadmap sequence

Finish Phase 0 evidence gaps, then close Phase 1 with an authorized outside-team
staging target. Continue Phase 2 locally and behind disabled execution until
its safety gates are real. Only then start Phase 3. Phase 4 and Phase 5 are
later lanes; commercial and compliance work must remain evidence-based and
cannot be inferred from product intent.
