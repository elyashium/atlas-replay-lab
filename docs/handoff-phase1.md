# Phase 1 handoff: owned staging target QA

> Maintainer note: the complete multi-phase handoff set is now indexed at
> [`handoffs/README.md`](handoffs/README.md). The canonical Phase 1 agent
> handoff is [`handoffs/phase-1.md`](handoffs/phase-1.md); this file preserves
> the original Phase 1 summary and evidence-oriented overview.

**Status: partially built. Phase 1 is not complete against its acceptance
criteria.** The local CLI has a versioned target contract, selector-driven
journey runner, profile matrix, target gate, and controlled failure/pass
evidence. No unaffiliated team's staging experience has been configured or
tested. The next owner should treat the existing run as an engine demonstration,
not customer validation.

## What is implemented

- `matrix --target <contract>` runs a declared selector journey against a
  development or staging URL using the existing Chromium/CDP matrix.
- The versioned contract describes allowed top-level origins, build ID,
  journey steps, success and fallback selectors, profile set, time budgets,
  media consent, screenshot consent/redaction selectors, and a release policy.
- Supported steps are `waitForVisible`, `waitForHidden`, `click`, and `fill`.
  Fill values can come from `ATLAS_*` environment variables and are not written
  to reports or traces.
- Missing selectors, unsatisfied steps, missing credentials, out-of-policy
  top-level redirects, and missing evidence fail or remain inconclusive; a
  high score cannot override a failed declared journey.
- Each run records the contract/build identifiers, profile evidence, policy
  verdict, metrics, traces, and consented screenshots. The target report shows
  the scope and emulation limits.
- A configured fallback is checked on its declared profiles. Those profiles
  must be critical to the policy, so absent fallback evidence cannot ship.

## What the evidence proves

The controlled local staging fixture was run with the same journey and policy
in both cases:

1. Removing the fixture's start handler made the success selector time out on
   all three critical profiles. The gate returned **HOLD** (exit 1).
2. Restoring the handler and changing the fixture build ID produced **SHIP**
   (exit 0).

The successful run used one sample per profile, Node 20.18.0, Chrome
154.0.8037.57, Windows x64, and seed `0x0b17a1`. These are reproducible local
fixture observations, not a performance benchmark and not evidence about a
third-party app. The local reports were visually inspected at desktop and
mobile sizes. Full metrics and artifact locations are in
[`evidence/phase1-2026-09-27.md`](evidence/phase1-2026-09-27.md).

## Acceptance still required

Phase 1 closes only after an unaffiliated developer configures an authorized
staging experience without changing Atlas source, runs at least a fast and a
constrained profile, sees a genuine actionable failure, changes their own app,
and reruns it successfully with the same contract. The report must distinguish
observed, emulated, inconclusive, and untested evidence.

That acceptance has **not** been performed. Specifically, there is no evidence
yet for:

- a real outside-team Web3D/WebAR or interactive-commerce experience;
- a customer-authenticated journey or safely provisioned customer credentials;
- an independently verified domain/ownership workflow;
- safe browser egress across redirects, subresources, DNS rebinding, or private
  addresses;
- automatic cross-report comparison or customer-input replay;
- a general claim that the runner can repair or prove arbitrary-site behavior.

The fixture is a small local selector/fallback demonstration. It is not a
representative customer scene. `matrix --url` remains a generic observer, and
`matrix --glb` measures Atlas's viewer around the asset rather than the asset in
its eventual host app.

## Safety and interpretation limits

- Target authorization is an operator attestation; Atlas does not verify legal
  ownership or permission.
- Origin checks cover top-level document navigation. The local runner does not
  constrain all browser subresource egress and is not safe to expose as a public
  arbitrary-URL service.
- Environment-backed test values are local CLI inputs, not a hosted secret
  store. Do not put credentials in URLs, contracts, screenshots, or reports.
- Screenshot selector blur is best effort. Review screenshots before sharing.
- CPU, network, viewport, permission, and WebXR profiles are browser
  emulations. They do not establish physical Android/iPhone, Safari, real-radio,
  GPU/thermal, or camera performance. Synthetic WebXR remains synthetic.
- Do not treat an observed generic-page event as a customer's checkout,
  conversion, or business completion.

See [`target-contract.md`](target-contract.md),
[`product-brief.md`](product-brief.md), and
[`showcase-roadmap.md`](showcase-roadmap.md) for the contract and product
boundaries. Phase 2's local web/API foundation is documented separately in
[`evidence/phase2-control-plane-2026-09-27.md`](evidence/phase2-control-plane-2026-09-27.md).

## Reproduction commands

From the repository root in PowerShell, start the controlled fixture in one
terminal:

```powershell
node examples/start-staging-scene.js
```

In another terminal, run the checked-in contract and gate:

```powershell
node bin/atlas.js matrix --target examples/target-contract.json --retry 0
node bin/atlas.js gate
node bin/atlas.js report --matrix artifacts/matrix/report.json --gate artifacts/gate/report.json --out artifacts/report.html
```

For the regression demonstration, the fixture handler and contract build ID
were changed locally; see the exact commands and outcomes in the Phase 1
evidence note. Do not describe a rerun of the healthy fixture as a customer
regression test.

For a real team, obtain explicit authorization and a non-secret staging route,
copy `examples/target-contract.json`, set its target URL/build ID/selectors and
allowed origins, then run `matrix --target` on that contract. Stop before
running an untrusted target because subresource egress is not isolated. Capture
the resulting reports and actual target change before claiming the acceptance
criteria passed.

## Current repository reference

The Phase 1 implementation landed in commit `9662ee1` (`Complete local Phase 1
staging target QA`). Later commits add Phase 2 control-plane scaffolding; they
do not close Phase 1's outside-team acceptance gap. The root test suite most
recently passed **264/264** tests on Node 20.18.0. The repository has no separate
lint, typecheck, or build script; see `AGENTS.md` for the current test and CLI
commands.
