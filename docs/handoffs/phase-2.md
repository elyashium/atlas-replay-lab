# Handoff: Phase 2 — hosted control plane

**Status: local control-plane foundation only; hosted execution is disabled.**
`apps/control-plane` contains a Fastify API, same-origin browser UI,
PostgreSQL schema, account/org/project onboarding, DNS TXT target ownership
challenge, versioned target contract storage, tenant-scoped run records,
idempotency, and Postgres metadata retention. Guided setup asks for success and
fallback selectors, critical emulation profiles, screenshot consent (off by
default), redaction selectors, and an authorization attestation. Run records
stay `queued`; there is no consumer, browser run, report, or verdict. The UI
displays a pending DNS TXT record and the API suppresses its token after
verification. Queue requests require an immutable target build ID and snapshot
the current release-policy hash and Atlas rule-engine identity. Legacy unbound
queued rows are cancelled by migration 002.

A per-job CONNECT-only egress proxy now exists at
`apps/control-plane/src/egress-proxy.js`. It permits exact HTTPS origins, checks
all DNS answers with the shared destination classifier, rejects mixed public
and private answers, and dials the checked numeric address without resolving
the hostname again. Five local tests include a TCP tunnel proving the numeric
address is the one dialed. This is a tested component, **not an enforced worker
boundary**: it is not connected to a job consumer, Chrome, or a network
namespace. A browser could bypass it today; hosted execution remains disabled.
See [ADR-0008](../adr/0008-connection-pinned-egress-proxy.md).

Architecture decision: [`../adr/0007-phase2-control-plane-boundary.md`](../adr/0007-phase2-control-plane-boundary.md).
Measured local setup: [`../evidence/phase2-control-plane-2026-09-27.md`](../evidence/phase2-control-plane-2026-09-27.md).
Package instructions: `AGENTS.md` and `apps/control-plane/package.json`.

## Code map

- API/session/target/run routes: `apps/control-plane/src/server.js`.
- SQL pool: `apps/control-plane/src/db.js`.
- Retention maintenance: `apps/control-plane/src/maintenance.js`.
- URL/public-address helpers: `apps/control-plane/src/security.js`.
- Per-job HTTPS CONNECT proxy component (not integrated):
  `apps/control-plane/src/egress-proxy.js`.
- Versioned schema/up migrations: `apps/control-plane/migrations/001_initial.sql`
  and `002_immutable_run_binding.sql`; the second cancels legacy unbound queue
  rows and adds required run binding. Down migrations are destructive and only
  for a disposable DB.
- UI: `apps/control-plane/public/{index.html,app.js,app.css}`.
- Tests: `apps/control-plane/tests/`; Postgres integration requires local
  PostgreSQL and `DATABASE_URL`.
- Local DB: `apps/control-plane/docker-compose.yml` binds loopback. Do not
  expose it or the API publicly. Preview captures use
  `apps/control-plane/scripts/capture-preview.js` and ignored `artifacts/`.

## Verified locally

- Control-plane suite: 17/17 passed with PostgreSQL 17, including account/org/
  project creation, mocked DNS TXT ownership and visibility, unverified-run
  rejection, immutable policy binding, idempotent queue record and key-reuse
  rejection, cross-org read denial, and expired run/artifact metadata deletion.
- Root suite before adding the egress proxy suite: 363/363 passed. Current root
  suite: 369/369; `doctor` passed on Node 20.18.0 and Chrome 154.0.8037.58.
- Egress proxy suite: 6/6 passed with synthetic DNS and a local fake tunnel.
  These tests do not exercise Docker network isolation or a browser.
- DNS verification card and guided target form visually inspected at 1440 px
  desktop and 390 px emulated mobile; no horizontal overflow.
- These tests do not prove full tenant isolation or hosted safety. DNS is
  onboarding validation, not protection against rebinding when a browser later
  connects.

## Recommended next work (keep workers disabled)

1. Implement and adversarially test an isolated ephemeral worker network
   namespace that forces browser traffic through the per-job proxy, including
   direct-socket and alternate-proxy bypass attempts, QUIC, DNS, WebSockets,
   redirects, frames, downloads, and service workers. Add DNS rebinding and
   metadata/private-range tests at the actual network boundary. Proxy tests
   alone do not close bypass paths.
2. Build an ephemeral worker with no ambient credentials, per-run browser
   profile, strict CPU,
   memory, disk and wall-time caps, sequential profiles in one isolated job,
   and cleanup verification. Do not connect it until the network policy is
   enforceable and adversarial tests pass.
3. Choose private object storage only after requirements and region/data flow
   review. Add content-addressed/versioned report, trace, and redacted image
   objects; signed short-lived reads; tenant-scoped metadata; integrity hashes;
   deletion including versions/backups; and restore/deletion exercises.
4. Add uploads only after file magic/type, byte/decompressed size, GLB parser,
   polygon/resource ceilings, timeout, malware/decoder boundary, storage quota,
   and cleanup tests are defined. Never pass arbitrary upload data straight to
   a shared worker.
5. Add queue leases, heartbeat, retry/backoff, cancellation, idempotency,
   harness-failure vs target-failure states, immutable run config/version
   records, quotas/rate limits, and audit events. A lost worker is
   INCONCLUSIVE/HOLD under policy, never SHIP.
6. Add end-to-end onboarding → dry-run → real run → evidence report only after
   1–5 are implemented in a private test environment. Add cross-tenant attacks
   for every record and artifact route. Prove retention end to end.
7. Keep private reports as default. Add expiring/revocable client-share links
   with access logs only after exact content scope, consent and deletion
   semantics are reviewed.

## Do not do yet

- Do not enable Chrome workers or public arbitrary-URL execution under the
  current DNS check.
- Do not report a queued run as a test result or generate SHIP from absent
  evidence.
- Do not use actual customer cookies, credentials, query-string tokens, raw
  camera/audio, or unreviewed screenshots in artifacts.
- Do not open cloud/storage/identity accounts, incur spend, choose a region, or
  promise a retention/SLA/compliance posture without the user's decision.

## Acceptance gate

An authorized user completes onboarding without an operator; a real job runs in
an isolated worker and produces immutable, versioned, private evidence; another
tenant cannot read it; unsafe navigation/uploads fail closed; cancellation,
retry, outage, quota, retention/deletion, and restore paths are tested; and no
inconclusive/harness failure becomes green. Until then this is local scaffolding,
not a hosted MVP.
