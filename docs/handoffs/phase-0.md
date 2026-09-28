# Handoff: Phase 0 — trustworthy local proof

**Status: core demonstration measured; evidence package is not fully closed.**
The Sep 27 local run records a forced-high constrained baseline that fails,
adaptive emulation, replay, a policy-backed gate, and generated report. The
HTML report's own desktop/mobile visual review and the requested short
reproducible screen recording remain open. Do not claim Phase 0 fully complete
until those evidence gaps are resolved or explicitly waived by the user.

## Existing work and entry points

- Root runner: `node bin/atlas.js`; tests: `npm test` via
  `scripts/test-core.js`; browser/environment precheck: `node bin/atlas.js doctor`.
- Orbital matrix/replay/gate/report pipeline: `src/runner/`, `src/replay/`,
  `src/gate/`, `src/report/`, and `bin/atlas.js`.
- Profile policy: `src/runner/profiles.js`; deterministic seed and trace
  contracts: `src/trace/`, `src/replay/`, ADR-0003/0004.
- Demo copy: `docs/demo-script-90s.md`; latest measured run:
  [`../evidence/phase0-2026-09-27.md`](../evidence/phase0-2026-09-27.md).
- Older failed run is preserved at
  [`../evidence/phase0-2026-09-26.md`](../evidence/phase0-2026-09-26.md); do
  not quote its result as the latest successful run.
- CI: `.github/workflows/ci.yml` runs root `npm test` on Node 18/20/22. Local
  evidence was on Node 20.18.0 only; CI is the evidence for other matrix
  versions.

## Recorded result and limits

The Sep 27 evidence is for Orbital only: seven sequential Chromium emulation
profiles; forced-high `low-cpu-3g` baseline failed; adaptive constrained run
was degraded-but-acceptable; configured severe-only policy returned SHIP; two
replays matched four checkpoints pixel-for-pixel. It records one run per
profile. The baseline/adaptive comparison demonstrates Atlas routing behavior,
not an app-code fix or a third-party business outcome. Chrome emulation is not
Android/iPhone, Safari, real radio, physical GPU/thermal, camera, or native XR.

Do not present ignored `artifacts/` outputs from a previous machine/commit as
fresh. The report is generated, but the evidence note explicitly says the
report page itself was not successfully captured/visually reviewed. There is no
recording artifact.

## Next actions

1. Inspect HEAD/worktree, run `node bin/atlas.js doctor`, `npm test`, and a
   fresh `node bin/atlas.js all` in the documented environment. Preserve exact
   outputs and hashes; never tune the demo by changing spoken numbers.
2. Visually inspect the resulting `artifacts/report.html` at desktop and mobile
   sizes using the current browser/CDP method. Record the exact browser,
   viewport, screenshots and any layout defects. Do not use the control-plane
   wizard screenshots as report UI evidence.
3. Produce a 60–90 second reproducible screen recording only if capture is
   available. If it is unavailable, document the blocker; do not fabricate or
   stage a video. Tie every narrated number to run artifacts.
4. Reconcile demo script statements with the actual Jev setup/run. The rule
   engine is the default; no live Jev call is evidence unless a fresh
   explicitly configured smoke run was performed. Fixtures remain
   illustrative.
5. Update the phase evidence and product/roadmap status after verification.

## Acceptance gate

- Fresh root `npm test` and `doctor` pass; CI matrix is green.
- Full baseline → adaptive → replay → gate → report run completes and numbers
  resolve to artifacts; baseline meaningfully fails and the adaptive case
  meets the chosen severe-only policy.
- Report UI visually checked at desktop and mobile. Short video is reproducible
  or its unavailability is honestly recorded.
- State sample count and environment; make no device or customer claims from
  the emulation.

There is no new account, service, spend, or user decision required for this
local evidence work.
