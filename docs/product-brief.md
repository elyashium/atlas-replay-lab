# Atlas product brief

**Status: product direction, not a claim about a shipped hosted service.**
Updated 2026-09-26 to replace earlier speculative customer, pricing, and launch
claims. The repository is currently a local evidence-producing CLI.

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
or guarded decision contracts.

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
- Never describe emulation as a handset, Safari, radio, GPU, camera, or native
  XR test. Browser experiences and native applications are separate scopes.
- Customer demand, pricing, willingness to pay, paid pilots, compliance status,
  and production readiness are unknown until supported by real evidence.
- Pricing, billing, compliance programs, native VR, and automatic remediation
  are out of the current build scope.
