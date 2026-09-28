# Handoff: Phase 1 — owned staging experience QA

**Status: engine slice implemented and measured on a controlled fixture;
Phase 1 acceptance remains open.** A local `matrix --target` path supports a
versioned target contract, selector journey, emulation profiles, fallback
checks, score/policy gate, evidence report, and a controlled failing/passing
demonstration. No outside team's staging target has been tested.

Full current handoff: [`../handoff-phase1.md`](../handoff-phase1.md). Detailed
run metrics: [`../evidence/phase1-2026-09-27.md`](../evidence/phase1-2026-09-27.md).
Contract usage: [`../target-contract.md`](../target-contract.md).

## Code entry points

- Contract validation and score: `src/targets/contract.js`,
  `src/targets/score.js`.
- Contract selection, target matrix orchestration, browser driving and
  redirects: search `src/` for `--target`, `targetContract`,
  `waitForVisible`, and `runTarget`.
- Generic URL path is distinct: `matrix --url` uses generic observation and
  does not prove declared business success.
- Controlled scene and sample contract:
  `examples/start-staging-scene.js`, `examples/target-contract.json`.
- Tests: `tests/target-contract.test.js`, target/driver tests in `tests/`.
- Gate/report behavior: `src/gate/`, `src/report/`, `tests/gate.test.js`,
  `tests/report.test.js`.

## What remains for acceptance

Find a willing team and obtain explicit authorization and a safe non-secret
staging route. Do not contact them without authorization. Configure a contract
without editing Atlas source; identify stable success/fallback selectors,
critical profiles, budgets, allowed app/API/CDN origins, and the target build.
Run a fast and constrained profile. Capture a genuine actionable failure,
have the app owner change their application, then rerun with the same contract.
Report actual observed/emulated/inconclusive/untested states and whether the
application build or Atlas runner changed.

Still absent or unverified:

- independent ownership/domain verification (the contract attestation is
  operator-supplied);
- authenticated customer journey against an outside team's app and a safe
  credential strategy beyond local `ATLAS_*` environment variables;
- browser subresource egress isolation, redirect/DNS rebinding protection, and
  safety for arbitrary targets;
- automatic cross-report diff and customer-input replay. Selector steps are
  reproducible but are not captured customer interactions;
- representative Web3D/WebAR acceptance. The local fixture is a simple
  controlled selector/fallback scene.

## Execution boundaries

Run only targets for which the operator has permission. Current origin checks
are not a public SSRF boundary. Do not run untrusted pages, and do not claim a
generic `session-complete` means checkout/conversion. Synthetic WebXR and CDP
profiles must be labeled emulation; no physical device result is implied.
Screenshots need explicit consent, redaction, and human review. No raw camera
or audio artifacts.

## Acceptance gate

An unaffiliated developer must configure, run, diagnose, change their own app,
and rerun a real owned staging target without editing Atlas source. Same
contract/profile comparisons need reportable build and engine identities. A
failed/inconclusive/harness-lost run cannot ship. Phase 1 does not close on the
fixture alone.
