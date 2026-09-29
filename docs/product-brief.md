# Atlas product brief

**Status: product direction, not a claim about a shipped hosted service.**
Updated 2026-09-29 to describe the visual-QA expansion without implying that
hosted execution, model accuracy, or customer demand has been established.

## Product

Atlas is release QA for teams shipping browser-based Web3D, WebAR, and
interactive commerce experiences. A studio engineer or QA lead should be able
to:

1. Verify an owned staging URL or upload a supported `.glb`.
2. Define success, safe fallback, critical journeys, and release policy for
   that experience.
3. Run a sequential device/network matrix and inspect observed, emulated,
   inconclusive, and untested coverage.
4. Review a replayable failure and before/after evidence, then issue a
   policy-backed SHIP, HOLD, or INCONCLUSIVE report.
5. Gate a pull request against the actual target build.

The CLI remains the offline engine. A hosted control plane should wrap the
versioned engine rather than replace its manifest, trace, deterministic gate,
or guarded decision contracts. Visual-model review is a separate, opt-in
advisory channel. It may describe visible pixels and propose design follow-ups;
the deterministic policy remains the only authority for release verdicts.

Atlas should support two related scopes: (1) release QA for a full owned
staging experience, with its user journey and fallback contract; and (2)
component QA for an explicitly authorized component preview or supplied source
artifact. Component QA should compare the rendered result against a user
provided design reference and criteria, then connect findings to component
source only when the user supplies that source. A URL alone cannot prove which
component produced the pixels or whether a proposed source edit is correct.

## Current evidence and limits

Implemented CLI components include the Orbital controlled demonstration,
`matrix --url`, static preflight, `.glb` viewer harness, trace judging, a
release gate, and the first local `matrix --target` contract lane. The target
lane runs declared selector journeys, profile-specific fallback checks, and a
versioned score policy against authorized development/staging URLs. It is not
a hosted experience or an independently verified ownership flow. The generic
URL probe still observes pages without knowing their business outcome or
repairing them. The `.glb` lane measures Atlas's viewer around an asset, not the
experience in its eventual host application. See
[`evidence/phase1-2026-09-27.md`](evidence/phase1-2026-09-27.md) for the
controlled failure/fix run and its limits.

An experimental local `visual-review` CLI command now sends up to three final
profile screenshots from an owned-staging matrix, or one user-provided
component PNG under `artifacts/`, to a configured Groq vision model. Component
mode can include one approved same-size reference PNG and team-written visual
criteria. Matrix screenshots require capture consent in the target contract;
provider egress requires a separate per-command flag. Findings are validated,
source-linked to the image hash, labeled as model suggestions, and shown
separately in the HTML report; they have no gate effect. `visual-compare` adds
deterministic pairwise PNG metrics and a heatmap, also without a gate effect.
No Groq key or live visual-model evaluation has been supplied, so output
quality is unmeasured. A separate `suggest-code-fix` command can send one
explicitly approved source file and the analyzed findings to Groq and save a
validated single-file patch proposal. It does not apply or test the patch.
These commands do not support the hosted control plane, arbitrary server
uploads, persistent design-reference management, sandboxed patch verification,
or PR integration. See
[`visual-qa-platform.md`](visual-qa-platform.md) and the
[`local visual QA evidence`](evidence/local-visual-qa-2026-09-29.md).

Chrome/CDP profiles are emulations. They do not establish performance on actual
Android or iPhone hardware, Safari, real radios, GPU/thermal conditions, or
physical camera behavior. Injected WebXR behavior is synthetic. Reports must
identify the exact run, engine, browser, profile, artifacts, and evidence scope.
Missing or low-confidence evidence cannot be described as a pass.

The latest local Phase 0 evidence is recorded in
[`evidence/phase0-2026-09-27.md`](evidence/phase0-2026-09-27.md). It records a
local Orbital baseline failure, adaptive degraded-but-acceptable result, exact
visual replay, and a SHIP decision over the configured emulated profiles. It
does not establish real-device performance or a hosted customer workflow.

## Ordered build plan

### Phase 0 — trustworthy local proof

Keep `npm test` portable across Node 18/20/22; align CI with the documented
command; keep demo copy consistent with measured Jev evidence; and capture an
Orbital baseline, adaptive run, replay, gate, and report whose numbers can be
verified in the artifacts. Record the actual browser/Node environment and
emulation limits. Phase 0 is not complete until the claimed outcome and replay
are supported by the run.

### Phase 1 — owned staging experience contract

**Status: local contract runner and policy gate implemented; real outside-team
acceptance is still unverified.** Controlled failure/fix evidence is recorded
in [`evidence/phase1-2026-09-27.md`](evidence/phase1-2026-09-27.md).

Make a versioned target contract configurable without editing Atlas source:
verified or explicitly authorized origin, allowed redirects/origins, journey
steps, success and fallback evidence, critical profiles, budgets, and gate
policy. Missing selectors, blocked auth, unsatisfied steps, and harness errors
must remain visible and fail safely. Same-contract comparisons must distinguish
customer application changes from Atlas runner changes. Only label a journey
replayable when the recorded input fidelity supports it.

### Phase 2 — hosted control plane

**Status: local control-plane foundation implemented; hosted execution is not
enabled.** The separate `apps/control-plane` package has a same-origin web UI
and JSON API for account/organization creation, project records, DNS TXT
ownership challenges for HTTPS targets, and tenant-scoped run records in
Postgres. Target contracts are validated by the existing CLI contract module
and snapshotted into run records. The UI exposes pending DNS TXT instructions,
requires an immutable target build ID for queued release evidence, and shows
the critical emulation profiles and screenshot consent. Each queued record
stores a versioned binding with the exact release-policy hash and Atlas engine
identity. A requested run remains `queued`; the API states that no browser
execution has happened and does not produce a verdict. API retries use
organization-scoped idempotency and reject key reuse across targets; the server purges expired Postgres run and
session metadata; blob/backups deletion is not connected. Local Postgres tests
exercise DNS challenge visibility, immutable binding, one cross-organization
access path, and metadata purge, not a full security audit.
See [`evidence/phase2-control-plane-2026-09-27.md`](evidence/phase2-control-plane-2026-09-27.md).

Still required before hosted execution or launch: isolated ephemeral Chrome
workers with sequential profiles, DNS-rebinding-resistant egress enforcement
for navigation/redirects/subresources, upload validation and limits, immutable
object storage, worker retries/cancellation, quotas/timeouts, private and
revocable client report sharing, end-to-end tenant isolation tests, enforced
retention of object data/backups and audit review, backups/deletion tests, and a
Postgres-backed onboarding-to-report test. The current DNS lookup is only an onboarding check;
it is not an SSRF defense for a browser worker. Do not deploy this slice as a
public arbitrary-URL service.

### Phase 3 — release integration

Add a GitHub status check for the target build. Preserve the target commit,
contract and policy versions, and report link. An unavailable worker or
inconclusive run must not turn green. Support advisory and blocking policies.

### Later — real devices and production monitoring

Only after the browser product is working, add a separately labeled physical
device lane and opt-in production probes. Identify concrete devices, OS/browser
versions, hardware provenance, repeat counts, privacy bounds, retention, and
regional requirements. Do not present these as shipped until measured.

## Safety and product boundaries

- Keep local CLI use available offline without signup or billing.
- Do not store raw camera or microphone media by default. Treat screenshots as
  potentially sensitive; hosted capture/share needs consent, scrubbing, review,
  access logging, and enforced retention.
- Keep Jev optional semantic triage behind the fail-closed guard. Rules own
  hard invariants. Synthetic Jev fixtures are illustrative, not a benchmark.
- Keep image-capable design critique separate from Jev's typed classifier.
  Treat screenshot text as untrusted, send images to a provider only after
  explicit consent, and label confidence as uncalibrated until evaluated.
  Design-reference comparison, accessibility checks, and code-quality checks
  require their own evidence and must not be inferred from a screenshot.
- Never describe emulation as a handset, Safari, radio, GPU, camera, or native
  XR test. Browser experiences and native applications are separate scopes.
- Customer demand, pricing, willingness to pay, paid pilots, compliance status,
  and production readiness are unknown until supported by real evidence.
- Pricing, billing, compliance programs, native VR, automatic source edits,
  and hosted model review are not currently shipped. Source corrections may be
  proposed later in a sandbox, tested against the same target contract, and
  presented as a human-reviewed patch; they must never be applied or deployed
  silently.
