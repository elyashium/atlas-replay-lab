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
- Artifact storage adapter: `apps/control-plane/src/artifact-store.js`; local
  filesystem remains the dev default, while an optional S3-compatible bucket
  is required by the production server path. The isolated worker verifies staged
  bytes before upload; authenticated/private-share API reads verify size/hash;
  `src/artifact-upload.js` verifies local worker files before upload; retention
  deletes the run prefix through the retryable purge queue.
- URL/public-address helpers: `apps/control-plane/src/security.js`.
- Per-job HTTPS CONNECT proxy:
  `apps/control-plane/src/egress-proxy.js`.
- Local queue leases/artifact export: `apps/control-plane/src/local-worker.js`; result/failure transactions: `apps/control-plane/src/worker-runtime.js`; process entry: `apps/control-plane/src/worker.js`.
- Pinned isolated Chromium executor and local Docker boundary check: `apps/worker/`.
- Versioned schema/up migrations: `apps/control-plane/migrations/001` through
  `015`; down migrations are destructive and only for a disposable DB.
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
- Component visual reviews created from a run screenshot now preserve the
  source run/artifact ID and artifact filename. Before provider egress, the API
  checks the artifact belongs to the same project, is a completed-run PNG, and
  its database SHA-256 matches the exact submitted bytes. Uploaded PNGs are
  stored as unlinked. Migration `010_visual_review_provenance.sql` adds these
  optional fields; image bytes remain unpersisted. This is provenance for the
  synchronous local review feature, not a durable visual evaluation job.
- Reviewers can set/replace/clear one of four bounded finding dispositions via
  `PUT /v1/projects/{projectId}/visual-reviews/{reviewId}/findings/{index}/disposition`.
  Only editor roles can write. Each actual change is audited; repeated identical
  PUTs are idempotent. The project detail endpoint returns current labels, and
  the UI states they do not affect the release verdict. Migration
  `011_visual_finding_dispositions.sql` is reversible; labels cascade-delete
  with their 30-day visual review record. No free-text reviewer comment is
  collected. This does not yet make the labels a calibrated benchmark.
- API reads now enforce visual-review and code-proposal expiry directly, even
  before the retention worker physically purges their rows. Expired findings
  and labels are omitted from project detail; expired review records cannot
  trigger a code-proposal provider call; replaying an expired idempotency key
  returns `410 Gone`. The PostgreSQL integration suite exercises those paths.
  This enforces the row-level 30-day access cutoff; it does not provide backup,
  object-store, or third-party provider deletion guarantees.
- Supabase Auth is now a selectable/configured provider. A server-side verifier
  validates confirmed users, maps provider subject IDs to Atlas users, and
  creates the first organization transactionally. Migration 012 is reversible.
  Supabase Auth does not replace the Atlas PostgreSQL database; local Atlas
  records still use `DATABASE_URL`. Real Supabase sign-up is not yet verified:
  the current project's redirect allow list is empty, so configure a local or
  deployed redirect in Supabase Auth URL settings before account onboarding.
- `npm start --prefix apps/control-plane` builds and launches Fastify through
  its env-loading wrapper. CI now builds the Vite frontend after the complete
  PostgreSQL-backed control-plane suite.
- New run submissions now have configurable per-organization quotas:
  `ATLAS_RUN_DAILY_LIMIT` (100 by default, UTC day) and
  `ATLAS_RUN_CONCURRENT_LIMIT` (5 queued/running). A PostgreSQL advisory
  transaction lock serializes each organization's existing-idempotency check,
  usage count, and insert across API replicas. Retries return the prior row
  before quota checks; cancelled/completed runs release concurrent capacity.
  Migration `013_run_quota_indexes.sql` supports the daily and active counts.
  These are safety defaults, not commercial plan limits or measured customer
  allowances.
- The local network-boundary verifier now explicitly observes a failed
  browser request to the metadata IP reached through a cross-origin redirect,
  rather than treating iframe `load` completion as proof of blocking. Latest
  local run observed 21 denied proxy attempts and six failed forbidden browser
  requests. It remains a one-run synthetic Docker test and is not a hosted or
  comprehensive SSRF proof.
- Target screenshot redaction now happens in PNG pixels rather than relying on
  a CSS blur that could leave text legible. Atlas measures each configured
  selector's box and writes an opaque black mask with 12 CSS pixels of padding;
  the same mask is applied relative to component screenshot crops. Missing,
  invalid, or unmeasurable selector bounds withhold the screenshot. In the
  latest isolated synthetic worker run, both the 1280x800 checkpoint and
  240x120 component crop contained 6,191 fully opaque black pixels. This is
  evidence for the fixture selector only, not a privacy guarantee for arbitrary
  pages: overflowing content, pseudo-elements, cross-origin frames, later
  layout shifts, and unselected sensitive areas can remain visible. Keep
  screenshot capture opt-in and review artifacts before sharing them.

## Recommended next work (keep hosted workers disabled)

1. Continue adversarially testing the isolated ephemeral worker network
   namespace. The local verifier now exercises direct sockets, worker DNS,
   allowed HTTPS, unlisted origins, fetch, metadata redirects/iframes/images,
   WebSockets, and service-worker fetches through Chromium. Still add alternate
   proxy configuration, QUIC/WebRTC bypass, downloads, expanded destination
   ranges, rebinding, and repeated/runtime-specific tests. Proxy and one-host
   container tests alone do not close bypass paths.
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

## 2026-09-30 continuation: browser egress adversarial probes

The local boundary verifier now drives Chromium beyond a single allowed page.
It attempts metadata access through fetch, an image, a same-origin redirect,
an iframe redirect, a secure WebSocket, and a service-worker install fetch; it
also tries an unlisted hostname and an unlisted documentation IP. The browser
reports the probes blocked, the CDP observer counts failed requests, and a
verifier-only proxy diagnostic reports boolean allow/refuse decisions without
target authorities. This diagnostic is opt-in and disabled in ordinary proxy
operation.

On the local Docker Desktop 29.6.2 run, **6** tracked browser requests to
forbidden destinations failed and the proxy recorded **21** refusals. The same
verifier then completed the full Atlas target matrix/gate/findings/report inside
the bounded worker container: **1/1** synthetic `high-wifi` profile, explicit
`SHIP` (the fixture intentionally sets its score floor to zero), outputs
collected before container exit, and no matching verifier containers/networks
left afterward. This remains one synthetic local run, not production or broad
adversarial proof. `npm run verify:worker-boundary --prefix apps/control-plane`
is still a manual verifier, not CI. See the dated Phase 2 evidence continuation
and `docs/threat-model-worker-egress.md` for remaining bypass cases.

Verification on 2026-09-30: worker image build passed; container-boundary
verifier passed on Docker Desktop 29.6.2; `node --test
tests/egress-proxy.test.js` **7/7**; root `npm test` **396/396**;
control-plane tests with loopback PostgreSQL **35/35**; changed scripts passed
`node --check`, and `git diff --check` passed. The Docker verifier is still a
manual local check and no external staging target was involved.

### WebRTC probe follow-up (2026-09-30)

Chromium sent five UDP packets to a test trap attached to the same internal job
network and gathered zero server-reflexive candidates. This demonstrates local
segment UDP reachability; it does not establish external STUN/TURN behavior.
Do not claim UDP egress is blocked based on the Chromium flag or this result.
External UDP needs a host/runtime default-deny rule and an adversarial test on
the selected deployment network. The updated Docker verifier passed and again
completed the bounded synthetic Atlas job (1/1 high-wifi, explicit SHIP under
the fixture's zero score floor). Control-plane tests without DATABASE_URL were
32 passed, 0 failed, 3 skipped. Root tests and Postgres integration were not
repeated in this follow-up.

### Runtime topology and gate consistency follow-up (2026-09-30)

Local worker startup now inspects Docker's resulting network attachments before
starting the browser: the job network must be internal, the worker may attach
only to that network, and the proxy may attach only to the default bridge and
the job network. The boundary verifier checks this topology (plus its isolated
fixture network) and ensures the persisted worker verdict matches the gate
report.

That check exposed a real target-gate inconsistency: a raw target-policy SHIP
could coexist with a blocking Atlas score-floor finding while the report's
`decision` remained `ship`. The gate now reports HOLD in that case and keeps
the raw target-policy decision as separate evidence. A regression test covers
a target score floor below Atlas's floor. Root tests pass **397/397**;
control-plane tests without Postgres pass **34**, fail **0**, skip **3**;
focused local-worker tests pass **6/6**. The latest Docker verifier run scored
99 and produced consistent SHIP with no findings. An earlier 45 score exposed
the inconsistent raw SHIP plus blocking finding; the regression fixture now
checks that condition yields HOLD. External UDP, Postgres integrations, CI, and
production network enforcement remain unverified.

### Postgres-backed suite follow-up (2026-09-30)

The checked-in local Compose Postgres was healthy and migrations 001–009 were
already applied. `npm test --prefix apps/control-plane` with loopback
`DATABASE_URL` passed **37/37**, including the previously skipped integration
tests. This verifies the local database path only; production DB operations,
backup/restore, and hosted isolation remain open.

### Anonymous share route aggregate ceiling (2026-09-30)

Migration `014_anonymous_share_request_limit.sql` adds fixed-minute counters
for public share-open and artifact routes. The default ceiling is 1,200 requests
per route/minute (`ATLAS_ANONYMOUS_SHARE_RATE_LIMIT_PER_MINUTE`, consistently
configured across API instances). Counting happens before token validation, so
unknown, expired, revoked, and malformed-token attempts consume the same route
budget. Counters retain no IP, token, or user-agent and maintenance deletes
minute buckets older than two minutes. A saturated route returns 429 with
`Retry-After: 60`.

This is a coarse service-wide ceiling. It does not provide per-client fairness,
cannot stop a distributed actor from exhausting the shared budget, and is not
a substitute for an edge/WAF control, proxy log review, abuse monitoring, or
production load testing. It may throttle legitimate users if the limit is set
too low. The per-share limit remains a second independent check after token
lookup.

### Local app onboarding follow-up (2026-09-30)

The package's local `.env` loader is shared by the API and worker entry points.
Shell-provided environment values still take precedence, and the worker remains
disabled unless `ATLAS_ENABLE_LOCAL_WORKER=1`. The checked-in example again
includes the worker image, private artifact directory, review limits, model
settings, Supabase auth values, and run/share quotas. The control-plane README
now documents building the worker image and starting the API and worker in two
local terminals. This makes the local workflow discoverable; it does not prove
the queue has run against an owned customer staging target.

The provided Supabase project's public auth settings reported sign-up enabled
and email auto-confirm disabled. A real confirmation email round trip was not
performed; add the exact local or deployed redirect URL to the project's Auth
redirect allow list before testing sign-up. No account was created by this
check.

On 2026-09-30 the local app was started with `npm start --prefix
apps/control-plane`; the server built and listened on `127.0.0.1:3000`. A
loopback HTTP smoke check returned `provider: supabase`, the configured project
origin, and a non-empty publishable key; the landing page returned 200 and
contained the release-QA product copy. The key value was not printed. This
proves local env loading and runtime config wiring, not a Supabase signup,
email confirmation, or authenticated onboarding round trip.

Verification on this worktree: control-plane tests with local PostgreSQL
**54/54**, root tests **400/400**, Vite production build passed, and
`preview:screenshots` completed desktop 1440 px and emulated mobile 390 px
states without horizontal overflow. Preview data and model outputs are
synthetic. The mobile proposal screen was visually inspected; it labels the
diff unapplied and untested, clearly presents the required source-egress
consent, and wraps long hashes within the viewport. The worker entry-point
guard was also checked with local env loading and remained disabled by default.

### Private S3-compatible artifact storage slice (2026-09-30)

`src/artifact-store.js` adds an optional S3-compatible bucket adapter using the
AWS SDK for JavaScript v3. Local disk remains the default outside production;
the production API refuses startup without a bucket. The local worker stages
the bounded job output on private disk, verifies each artifact's path, byte
length, and SHA-256, then uploads it before committing metadata. On upload or
commit failure, it attempts deletion of the run prefix; the API downloads
through its organization/share authorization and rechecks byte length and
SHA-256. Retention drains its existing database outbox only after remote
prefix deletion succeeds, and it also removes the local run directory when
configured. Share links continue to serve through Atlas rather than expose
object URLs.

The configured bucket must remain private and use TLS outside local testing.
Retention lists versions and delete markers, then deletes each explicit version
ID. Providers that cannot return a complete version listing fail the purge so
the outbox keeps retrying; key-only deletion is not used as a fallback. Mocked
tests cover this behavior, but versioned-object deletion has not been exercised
against a live S3-compatible provider. Object-store policy, least-privilege
credentials, encryption, provider backups, region, and restore also remain
unverified. The adapter has injected-client tests plus one disposable loopback
RustFS container round trip (put/get/prefix-delete); no hosted bucket or
selected-provider configuration was involved. The `verify:artifact-store`
command repeats that guarded loopback smoke against an already-created
disposable bucket. The AWS SDK dependency is pinned at 3.1143.0 and install/audit reported zero
vulnerabilities; Node 20 emitted an upstream notice that SDK versions published
after January 2027 will require Node 22. This slice is not evidence of
production storage readiness.

Latest verification after version-aware purge changes: control-plane tests with
local PostgreSQL **60/60**, root tests **400/400**, frontend build passed, and
`npm audit --prefix apps/control-plane --audit-level=moderate` reported **0
vulnerabilities**. The loopback smoke test passed against a disposable RustFS
container and removed its bucket, object, container, and named volume. The
tracked smoke command requires explicit test opt-in, a test bucket, and a
loopback HTTP endpoint.

### Opaque screenshot redaction (2026-09-30)

The core runner no longer relies on CSS blur for target screenshot privacy.
With explicit capture consent and configured selectors, it measures matching
element boxes and paints opaque black pixels into the PNG with 12 CSS pixels
of padding. The page layout is left untouched. The same treatment applies to
component crops; invalid, missing, or unmeasurable bounds withhold the image.
First-frame score inputs use the original capture held briefly in memory;
artifacts and report links receive only the redacted PNG.
Selectors still need to cover all sensitive content, and overflow,
pseudo-elements, cross-origin frames, layout changes between measurement and
capture, and unselected content remain risks. Human review is still required.

Evidence: `node --test tests/image.test.js` passed **30/30**; root `npm test`
passed **402/402**; `docker build -f apps/worker/Dockerfile -t
atlas-worker:local .` passed; and `npm run verify:worker-boundary --prefix
apps/control-plane` passed on local Docker Desktop. The verifier found 6,191
fully opaque black pixels in both the 1280x800 synthetic checkpoint and its
240x120 component crop. The same one-profile synthetic run recorded six failed
forbidden browser requests, 21 proxy refusals, five UDP packets reaching a
same-job-network trap, zero server-reflexive candidates, and a `HOLD` verdict
at score 35 against the configured 50 floor. This is local synthetic evidence,
not hosted isolation, a customer journey, external STUN coverage, or a repeated
benchmark.

### Stored-run visual comparisons (2026-09-30)

The Component Visual QA panel now offers a prior-run selector when a completed
current run has a matching PNG from the same target, target-contract version,
profile, checkpoint, and component. Both files are loaded through the normal
tenant-scoped artifact endpoint and shown for review. On submission, the API
checks each exact image hash against its artifact record and independently
enforces the same run-binding and relative artifact path. It stores both run
and artifact identities in migration `015_visual_run_comparison_provenance.sql`
and includes them in the audit event and visual-review history. Cross-tenant,
expired, altered, different-contract, profile, checkpoint, or component
artifacts fail before model egress. Manual references and uploaded current
images remain available without Atlas-run provenance.

The comparison produces deterministic pixel evidence and an optional
consented advisory Groq review. Neither can change the release verdict. This
is a reproducible visual-review record, not yet a visual threshold gate.

Verification for this slice: migration 015 applied to the local PostgreSQL
database; `node --test tests/visual-review-api.test.js tests/integration.test.js`
passed **14/14**; `npm test --prefix apps/control-plane` passed **61/61**;
`npm run build --prefix apps/control-plane` passed; and
`npm run preview:screenshots --prefix apps/control-plane` completed at 1440 px
desktop and 390 px mobile widths. The browser preview asserts the same-contract
run selector, browser-local comparison, Groq advisory submission, and stored
reference provenance in history; neither viewport had horizontal overflow.
Both preview screenshots were visually inspected. Fixtures and model output are
synthetic, and no hosted Supabase/Postgres, object store, or Groq request was
used. The API's adversarial test rejects a different artifact path before
provider egress. Remaining gaps include browser-level tests for user switching
between projects while selecting artifacts, a real authorized staging target,
and policy thresholds backed by customer-approved baselines.

### Component visual release threshold (2026-09-30)

Target contracts may opt into `policy.visualGate` version 1 with a maximum
changed-pixel ratio. It requires screenshot consent and at least one configured
component selector. On a completed SHIP run, an editor can compare one captured
component PNG with the same relative profile/checkpoint/component path from a
prior SHIP run of the same target and contract, where the only contract
difference is the immutable build ID. Atlas verifies both stored hashes and
PNG bounds before comparing. A changed ratio above the contract threshold
produces HOLD; a ratio within it produces SHIP. Existing target HOLD or
INCONCLUSIVE decisions cannot be loosened. The component verdict is a separate
immutable record with the threshold, policy hash/version, run/artifact IDs,
hashes, diff metrics, and audit event. Retention removes these records at the
paired run expiry. The run verdict itself remains untouched.

This is a component-scoped visual gate, not an aggregate release verdict: each
evaluation covers one profile/checkpoint/component capture. A team still needs
to evaluate every required capture and combine those component results with the
target journey before using an overall release check. Baseline SHIP is treated
as operator-selected approval; Atlas does not independently establish that a
baseline is visually correct. The threshold is deterministic pixel drift, not
a measure of design quality, accessibility, or visual correctness. Emulated
browser screenshots remain subject to the existing consent/redaction caveats.

Migration `016_visual_gate_evaluations.sql` was applied to local PostgreSQL.
`node --test tests/target-contract.test.js apps/control-plane/tests/visual-gate-api.test.js apps/control-plane/tests/maintenance.test.js`
passed **12/12**. `node --test apps/control-plane/tests/visual-gate-integration.test.js`
passed **1/1** against local PostgreSQL and temporary local PNG artifacts; it
asserted the stored HOLD, idempotent retry, audit event, and unchanged SHIP run
verdict. Synthetic API cases reject mismatched paths before object reads and
prove a visual comparison cannot loosen an existing target HOLD. These checks
do not exercise hosted object storage, real team baselines, a complete profile
aggregate, or a GitHub status check.
