# Handoff: Phase 2 — hosted control plane

**Status: local control plane with an opt-in isolated Docker queue executor; hosted execution is disabled.**
`apps/control-plane` contains a Fastify API, same-origin browser UI,
PostgreSQL schema, account/org/project onboarding, DNS TXT target ownership
challenge, versioned target contract storage, tenant-scoped run records,
idempotency, and Postgres metadata retention. Guided setup asks for success and
fallback selectors, critical emulation profiles, screenshot consent (off by
default), redaction selectors, and an authorization attestation. Run records
stay `queued` until a separately started `worker:local` process is explicitly
enabled and claims them. The UI displays a pending DNS TXT record and the API suppresses its token after
verification. Queue requests require an immutable target build ID and snapshot
the current release-policy hash and Atlas rule-engine identity. Legacy unbound
queued rows are cancelled by migration 002.

A per-job CONNECT-only egress proxy now exists at
`apps/control-plane/src/egress-proxy.js`. It permits exact HTTPS origins, checks
all DNS answers with the shared destination classifier, rejects mixed public
and private answers, and dials the checked numeric address without resolving
the hostname again. Six local tests include a TCP tunnel proving the numeric
address is the one dialed. A pinned Chromium image and Docker boundary verifier
now exercise this proxy with the browser on an internal network with DNS
disabled, no direct external interface, dropped capabilities, seccomp,
read-only root filesystem, and CPU/memory/process limits. One synthetic HTTPS
run passed, including blocked direct sockets to the fixture, a public IP, and
metadata, plus an allowlisted browser load through the proxy. This is partial
local evidence, **not** a full adversarial suite or production boundary; hosted
execution remains disabled. See [ADR-0008](../adr/0008-connection-pinned-egress-proxy.md)
and [the worker prototype notes](../../apps/worker/README.md).

The opt-in local worker claims queue rows with PostgreSQL leases, runs the
versioned target contract through the existing CLI matrix and deterministic
gate inside the isolated Chromium image, stores report/trace artifacts in a
private local directory, and commits status plus artifact hashes. It retries a
harness failure once; exhausted/lost-worker runs become `INCONCLUSIVE`. A real
target failure is retained as `HOLD`. Artifacts are downloadable only to an
authenticated member of the owning organization, verified by SHA-256, and
access is audited. Retention uses a retryable deletion queue for local files.
This local directory is not an object store. The worker has not yet completed a
real owned staging journey in Docker and is not safe to expose as a hosted
service. The container verifier now executes the complete Atlas target matrix,
gate, diagnosis, and report against one synthetic HTTPS fixture with one
`high-wifi` profile, then exports its artifacts before the container exits.
That is harness evidence only; it says nothing about an unaffiliated team's app.

Architecture decision: [`../adr/0007-phase2-control-plane-boundary.md`](../adr/0007-phase2-control-plane-boundary.md).
Measured local setup: [`../evidence/phase2-control-plane-2026-09-27.md`](../evidence/phase2-control-plane-2026-09-27.md).
Package instructions: `AGENTS.md` and `apps/control-plane/package.json`.

## Code map

- API/session/target/run routes: `apps/control-plane/src/server.js`.
- SQL pool: `apps/control-plane/src/db.js`.
- Cross-instance visual-review/code-proposal request locks use Postgres
  advisory locks. `src/server.js` creates a separate lock pool in its service
  entrypoint; configure one lock pool per API instance when embedding
  `buildApp`. This serializes duplicate keys across replicas, but model calls
  are still synchronous and have no durable crash recovery.
- Retention maintenance: `apps/control-plane/src/maintenance.js`.
- URL/public-address helpers: `apps/control-plane/src/security.js`.
- Per-job HTTPS CONNECT proxy:
  `apps/control-plane/src/egress-proxy.js`.
- Local queue leases/artifact export: `apps/control-plane/src/local-worker.js`; result/failure transactions: `apps/control-plane/src/worker-runtime.js`; process entry: `apps/control-plane/src/worker.js`.
- Pinned isolated Chromium executor and local Docker boundary check: `apps/worker/`.
- Versioned schema/up migrations: `apps/control-plane/migrations/001` through
  `009`; down migrations are destructive and only for a disposable DB.
- UI: `apps/control-plane/public/{index.html,app.js,app.css}`.
- Local screenshot comparison worker: `apps/control-plane/public/pixel-diff-worker.js`;
  it imports `/image-diff.js`, a server route exposing the dependency-free core
  PNG comparison module. The browser-local path has no API/provider egress or
  persistence. The separate consented visual-review API can attach the same
  deterministic metrics to its advisory report; neither path changes release
  verdicts.
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
- `npm run verify:worker-boundary --prefix apps/control-plane`: **passed** on
  Docker Desktop 29.6.2. Chromium reached one synthetic HTTPS origin through
  the proxy; worker DNS and direct connections to sampled fixture, public, and
  metadata addresses failed; unlisted CONNECT was denied. This test is local,
  single-fixture evidence and is not in CI.
- Queue and artifact access suites pass. Postgres integration exercises tenant-
  denied artifact reads, SHA-256 verification, and retryable local retention
  deletion. The worker itself has not run against a real authorized staging host.
- The expanded `verify:worker-boundary` also ran a complete Atlas job in the
  Docker image against a controlled synthetic HTTPS origin: **1/1 profile**,
  explicit `SHIP` from the customer target gate (score floor set to zero only in
  this harness fixture), report/findings/matrix artifacts created and transferred
  from the still-running bounded output mount. This is a plumbing test, not a
  visual or business-quality benchmark and not real staging evidence.
- DNS verification card and guided target form visually inspected at 1440 px
  desktop and 390 px emulated mobile; no horizontal overflow.
- These tests do not prove full tenant isolation or hosted safety. DNS is
  onboarding validation, not protection against rebinding when a browser later
  connects.
- Current visual-review extension: local browser comparison and consented
  provider-review wiring were previewed at 1440px desktop and 390px mobile.
  The previews use synthetic screenshots; the model result is mocked. Local
  comparison is deterministic pixel-change evidence, not design/accessibility
  quality. See the dated continuation in the evidence log for exact current
  suite results.
- For an active visual review, the selected screenshot can be shown with
  numbered model-supplied regions matched to numbered findings. The screenshot
  stays in the current page's memory only, has a clear control, and is not
  restored from stored review history after reload. Coordinates are uncalibrated
  model suggestions, not pixel segmentation. Desktop/mobile preview verifies
  synthetic wiring only.

## Recommended next work (keep hosted workers disabled)

1. Expand and adversarially test the isolated ephemeral worker network
   namespace that forces browser traffic through the per-job proxy, including
   direct-socket and alternate-proxy bypass attempts, QUIC, DNS, WebSockets,
   redirects, frames, downloads, and service workers. Add DNS rebinding and
   metadata/private-range tests at the actual network boundary. Proxy tests
   alone do not close bypass paths.
2. Exercise the local queue worker end to end against an owned HTTPS staging
   target with success and fallback journeys. Test timeout, stale lease,
   retries, concurrent workers, artifact retrieval and cleanup. Prove the
   cancellation endpoint and add distributed quotas before broader use.
3. Choose private object storage only after requirements and region/data flow
   review. Add content-addressed/versioned report, trace, and redacted image
   objects; signed short-lived reads; tenant-scoped metadata; integrity hashes;
   deletion including versions/backups; and restore/deletion exercises.
4. Add uploads only after file magic/type, byte/decompressed size, GLB parser,
   polygon/resource ceilings, timeout, malware/decoder boundary, storage quota,
   and cleanup tests are defined. Never pass arbitrary upload data straight to
   a shared worker.
5. Add distributed run/worker quotas and prove queue cancellation, artifact
   retention/deletion, and restore paths end to end. Share endpoints have a
   separate Postgres-backed per-link request bucket; it is not a general edge
   or invalid-token abuse control.
6. Add end-to-end onboarding → dry-run → real run → evidence report only after
   1–5 are implemented in a private test environment. Add cross-tenant attacks
   for every record and artifact route. Prove retention end to end.
7. Keep private reports as default. The local prototype now has explicitly
   scoped, expiring/revocable client-share links with access audit entries.
   Before hosting, review the bearer-link threat model and add anonymous
   invalid-token/edge rate limits, deployed-proxy/log review, storage/backup
   deletion, and abuse monitoring. See the continuations below.

## Do not do yet

- Do not enable the local worker implicitly, deploy it publicly, or expose
  arbitrary-URL execution.
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

## 2026-09-30 continuation: scoped client report sharing

The local control plane now supports an organization editor creating a client
share from a completed run. The editor must explicitly include the report
summary and select artifacts individually (all default unchecked); allowed
lifetimes are 1, 7, or 30 days and are capped by the source run's retention
deadline. The random bearer token is returned once in a fragment URL and only
its hash is stored. Recipients open the report without an Atlas account; the
page strips the fragment from history, requests the selected summary, and may
download only selected artifacts. PNG artifacts have an explicit preview.
Editors can revoke links. Owner run details show link state, access count and
recent report-open/download actions. The recipient access audit records action
and server timestamp, not recipient identity or IP.

Schema migration `008_share_scope.sql` adds summary consent, selected artifact
IDs, access counter and last-access timestamp. Its down migration is
`008_share_scope.down.sql`. API routes live in `src/server.js`; browser flows
are in `public/app.js`; share tests are part of `tests/integration.test.js`.
The migration is applied in the local PostgreSQL dev database. Links are
bearer secrets: anyone possessing a current URL may read the selected content.
This feature is tested locally, but anonymous rate limiting, deployed proxy
logging, object storage, and backup-aware deletion remain incomplete. A
per-link request limit was added in the 2026-09-30 continuation below.

Verification on 2026-09-30, local environment:

- `node --test apps/control-plane/tests/integration.test.js` with local
  PostgreSQL: **2/2 passed**. The Postgres-backed scenario covers hashed token
  storage, selected summary/artifact access, download integrity, refusal of an
  unselected artifact, expiry, revocation, access audit/counter, and cross-org
  share creation denial.
- `npm test --prefix apps/control-plane` with local PostgreSQL: **35/35 passed**.
- Root `npm test`: **390/390 passed**.
- Browser preview via `npm run preview:screenshots --prefix apps/control-plane`
  uses synthetic fixture rows and mocked provider results. Desktop 1440 px and
  emulated mobile 390 px recipient views strip the URL fragment, expose one
  selected synthetic PNG, render its preview, and report no horizontal
  overflow. Captures are ignored under `artifacts/`; they are not customer
  evidence.

This does not complete Phase 2 or establish hosted readiness. The execution
path is still opt-in local Docker; artifacts use local disk rather than object
storage. The app has not been run against an owned external staging target.
Continue hosted safety work before exposing anonymous shares or browser
execution publicly.

## 2026-09-30 continuation: cross-instance client-share throttling

Migration `009_share_request_limit.sql` adds PostgreSQL per-link fixed-minute
request buckets. The API atomically counts valid report opens and selected
artifact requests, defaulting to 120 per share link/minute; configure a
consistent `ATLAS_SHARED_REPORT_RATE_LIMIT_PER_MINUTE` value on every API
instance. A request beyond the cap returns 429 with `Retry-After: 60`. The
counter is keyed by the share ID, not recipient IP, and hourly retention
maintenance deletes old buckets. Revoking/deleting a share cascades its buckets.

The integration test sets a limit of two, performs an open and download through
one app instance, then verifies a separate Fastify instance with its own pool
gets 429 on the next open. Postgres shows three attempted requests and two
successful accesses. This proves a local multi-instance database path, not a
production load test. Unknown/invalid tokens are not throttled here; add an
edge/WAF or other network-level abuse control before public exposure.

Applied migration 009 locally. `node --test
apps/control-plane/tests/integration.test.js` passed **2/2**, including the
multi-instance throttling case. Full control-plane tests passed **35/35**;
root tests passed **390/390**. Browser preview passed at desktop 1440 px and
mobile 390 px with synthetic data and no horizontal overflow. These are local
test results, not public load or abuse testing.
