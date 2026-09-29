# Phase 2 local control-plane slice — 2026-09-27–29

## Current architecture boundary

```mermaid
flowchart LR
  User[Studio user] --> UI[Same-origin web UI]
  UI --> API[Fastify API and session auth]
  API --> DB[(PostgreSQL: orgs, targets, queued runs, visual reports, audit)]
  API -. explicit per-review consent .-> Groq[Groq vision API]
  API --> DNS[DNS ownership challenge]
  DB --> Worker[Opt-in local queue worker]
  Worker --> Proxy[Per-job pinned CONNECT proxy]
  Worker --> Disk[(Private local artifact directory)]
  Worker -. production deployment pending .-> Objects[(Private object storage: not implemented)]
  Objects -. future .-> Report[Private evidence report: not implemented]
```

## What exists

`apps/control-plane` is a separate package using Fastify and PostgreSQL. It has
a responsive same-origin browser UI; password account creation and login;
organization membership and owner setup; project creation; a guided editor for
the existing versioned target contract (with an advanced JSON view); an
explicit staging authorization attestation; critical emulation profile
selection; screenshot consent defaulted off with redaction selectors; an HTTPS
staging target onboarding record with a DNS TXT ownership challenge; and
organization-scoped project, target, and run status API routes. The project UI
shows an unverified target's DNS TXT record and stops returning its token once
verified. A target must pass the DNS challenge before the API will create a
queued run record. Run submission requires an immutable target build ID and
stores a versioned binding snapshot with the contract, release policy hash,
Atlas rule-engine version, requestor, and a 30-day expiry timestamp. A required
idempotency key maps request retries back to the same run row. Migration 002
cancels legacy unbound queue entries before adding the required binding column.
The server purges expired sessions, share-link records, and non-running run
rows hourly. An opt-in local Docker queue worker claims runs using expiring
leases, executes the existing target matrix and deterministic gate, stores
hashed artifacts on disk, and marks harness failures `INCONCLUSIVE`. The API
does not start it automatically. Browser execution remains local development
only and has not been exercised against a real owned staging target in Docker.

The API enforces organization membership in each read/write path, scopes SQL by
organization ID, hashes opaque session tokens in Postgres, uses an HttpOnly,
SameSite=Strict cookie, requires same-origin JSON on writes, and sets a restrictive
content security policy. Target onboarding currently rejects non-HTTPS URLs,
credentials/query/fragment, nonstandard ports, IP literals, local hostnames,
and DNS answers identified as non-public. These checks are not a safe browser
egress boundary and do not mitigate rebinding after verification.

The dependency boundary and remaining safety gates are recorded in
[`ADR-0007`](../adr/0007-phase2-control-plane-boundary.md). No external identity,
hosting, object-storage, or payment account was opened and no spend occurred.

## Local quickstart

Requirements: Node 20+, npm, and Docker Desktop with its local daemon running.
From the repository root:

```powershell
docker compose -f apps/control-plane/docker-compose.yml up -d
npm install --prefix apps/control-plane
$env:DATABASE_URL = "postgres://atlas:local-only-change-me@127.0.0.1:5432/atlas"
$env:ATLAS_APP_ORIGIN = "http://127.0.0.1:3000"
$env:GROQ_API_KEY = "<server-side key>" # optional; required only to submit a visual review
$env:ATLAS_VISUAL_REVIEW_DAILY_LIMIT = "10" # local abuse ceiling, not a commercial plan
npm --prefix apps/control-plane run migrate
npm --prefix apps/control-plane start
```

Open `http://127.0.0.1:3000`, create an account and organization, and add a
project. Target setup requires a public HTTPS staging hostname and permission
to publish `_atlas-verify.<hostname>` as a TXT record. The checked-in local
fixture uses loopback HTTP and is intentionally not accepted as a hosted
target. You can inspect routes at `/api/openapi.json` and service availability
at `/healthz`.

The local Docker credential is only for development. Do not expose the API,
database, or this setup to the public internet.

## Verification performed

- `npm test` (repository root): **363/363 CLI tests passed**, using the
  dependency-free `scripts/test-core.js` runner. Node 20.18.0, Windows x64.
- `npm test` (in `apps/control-plane` with local `DATABASE_URL`): **17/17
  tests passed**, including one real Postgres flow across account/org/project,
  mocked DNS ownership verification, challenge visibility, mixed public/private
  DNS refusal, immutable build and policy binding, idempotent queued records,
  cross-org read denial, and
  retention deletion of run/artifact metadata. Other tests cover
  password/cookie helpers, same-origin writes, project scoping, and health.
- `npm ci --offline` (in `apps/control-plane`): **passed**, installed the locked
  dependency tree and reported **0 known vulnerabilities** from the local npm
  advisory cache.
- `node bin/atlas.js doctor`: **passed**; Node 20.18.0 and Chrome 154.0.8037.58
  were found and CDP connected.
- `npm run preview:screenshots` (in `apps/control-plane`): **passed** through
  the existing CDP harness after creating and cleaning up a disposable local
  account/project and inserted a synthetic, unverified DNS challenge row
  directly into local Postgres. Captures show both the challenge card and the
  guided target form at desktop 1440×1100 and emulated mobile 390×844 CSS px
  (DPR 2); document widths matched their viewports, with no horizontal
  overflow. Both states were visually inspected. Artifacts are ignored under
  `artifacts/control-plane-{verification,wizard}-{desktop,mobile}.png`.
- `npm run migrate` (in `apps/control-plane`): **passed** against the existing
  local PostgreSQL 17 database (no-op for applied migrations) and a fresh
  disposable database (applied `001_initial` and `002_immutable_run_binding`).
  Migration application is serialized by a transaction advisory lock. The real integration test
  proves the tested query paths, not a comprehensive tenant-isolation audit or
  the hosted network boundary. DNS answers/TXT were stubbed to avoid contacting
  or running an outside studio target.
- A local queue consumer, browser worker image, report renderer, and private
  artifact download endpoint now exist. The worker job path was not exercised
  end to end against a real owned staging target. No private object store,
  client-share flow, or real customer run metrics exist.

## Blocking gaps before hosted use

The DNS lookup is a one-time onboarding check; the local worker additionally
uses a connection-pinned proxy and isolated Docker network, but the container
attack suite is incomplete and this is not hosted protection evidence. Browser
execution is opt-in local development only. There is no S3-compatible storage,
distributed worker deployment, job cancellation/backoff, quotas, distributed
rate limiting, backup/blob deletion proof, expiring
revocable report links, MFA/recovery, deployment hardening, or end-to-end
second-tenant attack test. The current session/password implementation has no
email verification or recovery and should receive a security review before
hosting. The scheduled purge covers PostgreSQL session, share-link, and
non-running run rows, and the integration test exercised the row/metadata
deletion path. There are no blobs or backups connected to purge yet.

This is a local development control-plane foundation; it is not a hosted MVP
and not production ready.

## 2026-09-29 continuation: isolated egress component (not worker enforcement)

Added `apps/control-plane/src/egress-proxy.js`, a per-job HTTPS CONNECT proxy
component. It accepts an exact HTTPS origin allowlist, checks every DNS answer
with the shared destination classifier, rejects a mixed public/private answer,
then connects to the selected checked numeric address. It does not resolve the
hostname a second time. Plain HTTP proxy requests fail with 403; per-job tunnel
capacity is bounded and excess connections return 503. This does not terminate
TLS or validate encrypted HTTP paths/headers.

Verification on Windows x64 / Node 20.18.0:

- `node --test tests/egress-proxy.test.js`: **6/6 passed**. Includes exact-origin
  allow/deny, malformed and alternate-port authority rejection, mixed DNS
  refusal, a local TCP tunnel proving the checked numeric address was dialed,
  CONNECT-only behavior, and tunnel-capacity rejection. DNS and upstreams are
  test doubles; no external site or malicious container was tested.
- `npm test` (repository root): **369/369 passed**; the root package remains
  dependency-free.
- `node bin/atlas.js doctor`: **passed**, Chrome 154.0.8037.58, CDP 1.3.
- `npm test --prefix apps/control-plane` with local Postgres 17 and
  `DATABASE_URL`: **17/17 passed**, including the Postgres integration flow.
- `npm run migrate --prefix apps/control-plane` with `DATABASE_URL`: passed;
  migrations 001 and 002 were already applied.
- `npm audit --prefix apps/control-plane --omit=dev`: **0 production
  vulnerabilities reported** by npm's current advisory data. This is not a
  security audit or a guarantee against undisclosed vulnerabilities.

At this stage, the proxy was not imported by the API or any job consumer. The
later 2026-09-29 entries below record local Docker integration and the local
queue worker. Hosted execution still needs the full adversarial network suite,
private object storage, cancellation/quotas, backup deletion, and real target
evidence; do not read the earlier snapshot as current state.

## 2026-09-29 continuation: local component visual review

The signed-in project view now lets an organization editor submit a current PNG
and optional design reference with team criteria. Provider egress requires an
explicit per-review checkbox. The API enforces strict base64 PNG decoding, a
10 MiB per-image cap, 4096-pixel dimension and 8-million-pixel limits, a
separate request body cap, an atomic configurable daily quota (default ten per
organization), and
request idempotency. The Groq key is read only by the server environment; it
is never returned to the browser. Provider/schema failures are stored as
INCONCLUSIVE with a sanitized error.

The API stores no screenshot bytes. It stores advisory JSON, image hashes,
optional team criteria, an egress-consent audit event, and a retention deadline
in Postgres. Project reads are organization-scoped. The hourly maintenance task
purges visual reports after 30 days, writes a minimal purge audit event, and
removes old quota counters. This is a synchronous local control-plane feature;
it is not a queued worker task and does not affect a release gate.

Verification on Windows x64 / Node 20.18.0 / local PostgreSQL 17:

- Migration 003 applied to the local database.
- `npm test --prefix apps/control-plane` with `DATABASE_URL`: **23/23 passed**.
  This includes a mocked-provider Postgres flow that verified report storage,
  organization-scoped project reads (including a second-organization denial),
  idempotent retry, absence of uploaded PNG bytes in persisted JSON, egress
  audit, and deletion/audit at expiry. No live Groq request was made in this
  test.
- Root `npm test`: **388/388 passed**; root/core dependency posture unchanged.
- `node --check` passed for the API and browser UI JavaScript. `git diff --check`
  passed after the final documentation and UI changes.

## 2026-09-29 continuation: isolated Chromium network prototype

Added `apps/worker/Dockerfile`, a pinned, non-root Chromium image; a per-job
proxy entry point; a restrictive seccomp profile derived from the licensed Moby
default profile; and a local Docker boundary verifier. The verifier puts the
browser on an internal network with DNS unavailable and no direct external
interface, connects a proxy to a separate synthetic HTTPS fixture network, and
applies read-only root, bounded temp filesystems, dropped capabilities,
`no-new-privileges`, CPU/memory/process limits, and the Chromium user namespace
sandbox. No credentials are provided to containers.

Verification on Windows x64 / Node 20.18.0 / Docker Desktop 29.6.2:

- `npm run verify:worker-boundary --prefix apps/control-plane`: **passed**.
  Chromium loaded the synthetic HTTPS fixture through the proxy. Worker DNS,
  direct TCP to the fixture, direct TCP to `1.1.1.1:443`, and direct TCP to
  `169.254.169.254:80` failed; an unlisted CONNECT was refused. The verifier
  removed its temporary containers and networks.
- `npm test`: **390/390 passed**.
- `npm test --prefix apps/control-plane` without `DATABASE_URL`: **25 passed,
  2 Postgres tests skipped**. Then migrations were checked and
  `npm test --prefix apps/control-plane` with the loopback-only local PostgreSQL
  17 container: **27/27 passed**.
- `git diff --check`: passed.

This demonstrates one local path on one Docker Desktop setup with a synthetic
origin. It does not cover the complete DNS/redirect/subresource/alternate-egress
attack matrix, real staging journeys, CI runtime differences, queue dispatch,
cancellation, artifact extraction/retention, or a hosted security boundary. The
At that point in the work, the API left queued runs queued. The later
2026-09-29 continuation below records the opt-in local queue consumer. Keep
public execution disabled. Worker implementation notes and limitations are in
[`../../apps/worker/README.md`](../../apps/worker/README.md) and
[`../threat-model-worker-egress.md`](../threat-model-worker-egress.md).

The verifier now goes beyond the browser network probe and runs the actual Atlas
matrix, deterministic target gate, diagnosis, and report in a second isolated
container against that same synthetic HTTPS fixture. One `high-wifi` profile
completed and wrote an explicit result plus matrix, gate, findings, and HTML
report. The verifier retrieved artifacts while the container remained alive,
then signaled collection and cleaned up. This is one synthetic fixture profile,
with the fixture policy's score floor set to zero to verify plumbing; the
resulting `SHIP` is not product-quality evidence. It still does not dispatch
from the API/Postgres queue and is not a run against a real studio's target.
- `npm run preview:screenshots --prefix apps/control-plane` started a disposable
  local API on a loopback ephemeral port, created a test account/project, and
  submitted a synthetic component PNG through the actual browser form and API
  using a mock model adapter. It captured a clearly labeled synthetic finding
  at desktop 1440px and mobile 390px. Document and body widths matched both
  viewports; both screenshots were visually inspected. No model request or
  customer data left the workspace.
- `ATLAS_VISUAL_REVIEW_DAILY_LIMIT` controls the local per-organization UTC-day
  abuse ceiling (10 by default, range 1..1000). This is not a proposed customer
  quota or pricing tier. A process-local lock serializes concurrent retries
  inside one server instance; distributed idempotency is not established.

The prior live visual-provider smoke used synthetic images and returned
inconclusive; no post-fix live analysis, accuracy, latency, or cost measurement
exists. The visual review daily limit of ten is an initial local abuse-control
ceiling, not a pricing or customer entitlement decision. The feature still
lacks managed key storage, distributed quotas, request cancellation, private
report shares, browser capture, object storage, and public-service security
review. Do not host it publicly.

## 2026-09-29 continuation: guarded code proposals

The project view can submit one source file for an advisory proposal based on
a completed component visual review. The request requires a separate source
egress checkbox, editor role, a completed review with validated findings, and
an idempotency key. Source is capped at 64 KiB; common credential patterns are
rejected. The source is sent to Groq for processing and is not retained. The
database keeps its SHA-256, filename, validated result/diff, request metadata,
and explicit-consent audit record for 30 days. Proposed diffs can contain
unchanged source lines. They are not applied or tested and cannot affect a
release verdict. The local abuse ceiling defaults to five requests per
organization per UTC day. Provider calls are mocked in tests; no live source
was sent to Groq.

Verification on Windows x64 / Node 20.18.0 / local PostgreSQL 17:

- Migration 004 applied after migrations 001–003.
- `npm test --prefix apps/control-plane` with `DATABASE_URL`: **27/27 passed**.
  Coverage includes explicit consent, rejection of common credential patterns,
  filename and size limits, validated finding linkage, idempotency, quota and
  role checks, sanitized provider failure, Postgres tenant isolation, source
  non-retention, consent audit, and retention deletion/audit. The retention
  integration test asserts persisted end state because the separate maintenance
  test process may perform the same idempotent purge first.
- Root `npm test`: **388/388 passed**. No live Groq request was made; provider
  adapters were mocked, and the supplied key was not written to disk.
- `npm run preview:screenshots --prefix apps/control-plane` completed with a
  synthetic visual finding and synthetic code proposal at desktop 1440px and
  mobile 390px. Document and body widths matched each viewport. The visual
  finding, source consent, diff, source hash, and unapplied/untested notice were
  visually inspected at both sizes. No model call or customer data left the
  workspace.
- `node --check` passed for the API, client script, preview script, and shared
  proposal adapter; `git diff --check` passed.

At this checkpoint the control-plane provider call was synchronous and its
idempotency lock was process-local; the dated continuation below adds shared
Postgres locking. Provider calls remain synchronous, so there is no durable
visual-model job record or crash recovery. Secret-pattern scanning is
incomplete; a returned diff can repeat source lines. Do not host this endpoint
publicly. Live quality, latency, and cost remain unmeasured.

## 2026-09-29 continuation: opt-in local queue worker

Added a local-only Postgres queue consumer that claims one run with a bounded
lease, runs its profiles sequentially in a fresh Docker container, heartbeats
the lease, handles cancellation, retries harness failures once, and records
artifacts in a private local directory. Each run gets a job-specific internal
Docker network and allowlisted HTTPS proxy. Worker output is copied while the
container is alive, validated for file type, path, count, and total size, then
hashed and registered in Postgres. Retention uses a retryable database outbox
to remove the matching local run directory. Expired-lease recovery runs every
15 seconds while the worker polls for new work once per second.

Verification on Windows x64 / Node 20.18.0 / Docker Desktop 29.6.2 / local
PostgreSQL 17:

- Root `npm test`: **390/390 passed**.
- `npm test --prefix apps/control-plane` with loopback-only `DATABASE_URL`:
  **33/33 passed**.
- `node bin/atlas.js doctor`: passed with Chrome 154.0.8037.58 and CDP 1.3.
- `npm run verify:worker-boundary --prefix apps/control-plane`: passed. DNS and
  direct public, fixture, and metadata sockets were blocked; allowlisted HTTPS
  was reached through the proxy. The actual matrix, gate, findings, and report
  completed in the isolated container. One captured run returned `SHIP` with a
  target score of 99/100 and no target gate findings; another verifier run in
  this work session returned `HOLD`. The verifier removes its ephemeral output,
  so the runs are not retained for independent artifact review. This variation
  means the synthetic fixture verdict is plumbing evidence only, not a stable
  performance or product benchmark.
- `node --check` for the changed worker scripts and `git diff --check`: passed.

The Postgres integration suite now exercises authenticated target setup and
queue submission, a real SQL lease claim, the worker's atomic result/artifact
commit, authenticated report download, download audit, and cross-organization
artifact denial in one run. Its labeled synthetic executor does not launch
Docker. The isolated verifier separately runs the actual Atlas matrix and
artifact exporter inside Docker against a synthetic origin. The browser
executor is therefore covered at the Docker boundary and the API/queue
orchestration is covered with Postgres, but a single live API-to-Docker run is
still unverified. Cancellation, retries, and retention are exercised in
separate Postgres integration assertions. Hosted object storage, multi-host
workers, network adversarial coverage, credentials, quotas, durable distributed
visual-provider calls, and real owned-staging evidence remain unfinished. The
worker is disabled unless `ATLAS_ENABLE_LOCAL_WORKER=1` is set and is not a
hosted service. Do not expose the control plane publicly.

## 2026-09-29 continuation: run screenshots into visual review

The project visual-review form can now choose a PNG artifact from a completed
run as well as upload a local PNG. It fetches the selected artifact through the
organization-authenticated, integrity-checked download route (which records an
artifact-download audit), previews the image, then requires the existing
separate Groq egress consent before submission. Captures still require the
target contract's explicit screenshot consent and redaction selectors; every
image must be inspected before provider egress. Visual findings remain advisory
and do not affect release verdicts. The browser does not crawl an arbitrary
URL for visual review, and model egress remains synchronous.

- `npm run preview:screenshots --prefix apps/control-plane` with local
  PostgreSQL exercised artifact selection, authenticated PNG fetch, preview,
  unchecked egress consent, mocked visual analysis, and code-proposal display at
  desktop 1440px and mobile 390px. Both layouts had no horizontal overflow; the
  screenshot preview image loaded at both sizes. This used a synthetic PNG and
  mock reviewer; no model call or customer data left the workspace.

## 2026-09-29 continuation: objective reference-difference evidence

Reference-based component reviews now include Atlas's existing deterministic
PNG comparison: share of pixels beyond per-channel tolerance 6, coarse 16x16
luminance similarity, dimensions, and the calculated change bounding box. It is
explicitly labeled pixel-change evidence, not a design-quality/accessibility
score, and `verdictEffect` remains `none`. It is computed after idempotency and
daily-quota checks; no screenshot bytes are added to the review row. The
vision-model result remains a separate advisory section and may be inconclusive
even when deterministic comparison metrics exist.

- `node --test apps/control-plane/tests/visual-review-api.test.js`: **6/6
  passed**, including a synthetic 2x2 pair with one changed pixel (25% pixel
  difference) and no release effect.
- The desktop 1440px and mobile 390px browser preview showed deterministic
  reference metrics and the distinct synthetic model advisory. Neither layout
  overflowed horizontally. It used synthetic PNGs and a mock reviewer; no
  live provider request or customer data was used.
- Full `npm test --prefix apps/control-plane` with loopback-only Postgres:
  **34/34 passed**. Root `npm test`: **390/390 passed**. Changed server/client/
  preview scripts passed `node --check`; `git diff --check` passed.

## 2026-09-29 continuation: browser-local reference comparison

Added a no-egress comparison action to the screenshot review form. It decodes
the current and approved PNGs in the browser, then runs the existing Atlas
`diffImages` function in a module web worker. The browser enforces a 10 MiB PNG
limit and dimension/pixel ceilings before decoding. This path sends no image,
criteria, or request to the control-plane API or a model provider, and it does
not persist its result. The separately consented server review still requires
explicit provider egress consent; when a reference is included, deterministic
pixel evidence is computed server-side and stored alongside the advisory
review, with no verdict effect.

The synthetic preview was visually inspected at desktop 1440px and mobile
390px. Both displayed the local-only comparison and showed no horizontal page
overflow. The desktop showed a 100.00% pixel difference, 68.09% coarse
luminance similarity, tolerance 6, and the full 16-by-16 difference bounds for
the synthetic fixture. The mobile view stacks the image previews; its native
run selector truncates a long synthetic option label. These fixture metrics
are UI plumbing evidence, not a design score or benchmark. Groq consent was
unchecked during local comparison; the later provider response in the preview
was mocked. No live Groq call or customer image was used.

- `npm test`: **390/390 passed**.
- `npm test --prefix apps/control-plane` with loopback-only Postgres:
  **34/34 passed**.
- `node --check` passed for the API, UI, pixel-diff worker, and preview script;
  `git diff --check` passed.

This adds a useful local review tool but does not establish design-quality
judgment, visual regression policy, accessibility assessment, arbitrary-URL
capture, or hosted provider-call durability. Visual model findings remain
advisory, and screenshot capture still depends on target consent and configured
redaction selectors.

## 2026-09-29 continuation: visual finding locations

The active browser session now shows the selected screenshot alongside numbered
model-supplied finding regions, with matching numbers on each finding. Region
coordinates remain explicitly illustrative and model-supplied; they are not
pixel segmentation or verified defect boundaries. The selected screenshot is
held in browser memory only for this view, can be cleared with the visible
control, is not copied into the report row, and is unavailable after a fresh
page load. This makes a review more inspectable without extending screenshot
retention on the server.

- `npm run preview:screenshots --prefix apps/control-plane` completed with exit
  0 at desktop 1440px and mobile 390px. The synthetic review displayed one
  numbered finding region at each size, and the clear-local-image action
  removed it at both sizes; all measured document/body widths matched the
  viewport.
- The desktop and mobile report screenshots were visually inspected. The
  numbered box aligns with the synthetic 16-by-16 screenshot; the corresponding
  finding is numbered, and the mobile clear control remains readable.
- The preview model response and image are synthetic. This checks UI wiring,
  not model localization quality or a real customer defect.

## 2026-09-29 continuation: cross-instance visual AI idempotency

Visual-review and code-proposal routes now take a PostgreSQL session advisory
lock keyed by organization plus idempotency key before checking for a prior
result, reserving daily quota, or calling the provider. The service entry point
uses a separate lock pool so synchronous provider waits do not hold a normal
API-query pool connection. A retry on a second API instance waits for the first
request to finish, then returns its stored row instead of repeating provider
egress or consuming quota again.

- Postgres integration used two independent API instances and four independent
  connection pools. Concurrent identical visual-review requests returned the
  same review ID with one mock provider call, one row, and one quota unit.
- The same two-instance test concurrently submitted an identical code proposal
  and observed the same proposal ID, one mock provider call, and one quota unit.
- `node --test apps/control-plane/tests/integration.test.js`: **2/2 passed**.
- Full control-plane suite with loopback-only Postgres: **35/35 passed**; root
  suite: **390/390 passed**. Browser preview passed on desktop/mobile after
  wiring the preview server to a distinct lock pool.

This closes concurrent duplicate requests across API instances, but not crash
recovery. The provider call still runs inline; a process can fail after remote
egress and before its result is committed. Durable model jobs, cancellation,
retry semantics, and distributed queue quotas remain unimplemented.

## 2026-09-30 continuation: scoped client report links

The local app now exposes a recipient-safe share path for completed runs. An
organization editor explicitly opts into the run summary and individually
selects artifacts; no artifact is selected by default. Share links support
1/7/30-day expiry, capped by source-run retention, and editor revocation. The
random token is returned once in a URL fragment, hashed in Postgres, stripped
from browser history after recipient startup, and never placed in the open
request URL. Anonymous recipients see only the selected summary and artifacts.
Artifact reads re-check scope, run retention, object path, symlink state, byte
length, and SHA-256. Successful opens/downloads update a counter and audit
action/timestamp. The UI offers explicit PNG preview; owner view shows state,
access count, and recent actions without recipient IP/identity.

Migration `008_share_scope.sql` and its down migration add summary consent,
selected artifact IDs, access count, and last-access time. `PRIVACY.md` now
documents bearer-link semantics and the local prototype boundary. This remains
local disk storage; no hosted object store, backup-aware deletion, anonymous
rate limit, deployed proxy-log review, or abuse monitoring was added.

Verification on 2026-09-30:

- `node --test apps/control-plane/tests/integration.test.js` with local
  PostgreSQL: **2/2 passed**, including hashed token storage, selected scope,
  download integrity, unselected-item denial, expiry, revocation, audit and
  cross-organization create denial.
- `npm test --prefix apps/control-plane` with local PostgreSQL: **35/35
  passed**. Root `npm test`: **390/390 passed**.
- `npm run preview:screenshots --prefix apps/control-plane` passed. The UI
  preview uses synthetic run/artifact rows and mock model responses. At 1440 px
  desktop and emulated 390 px mobile, recipient view showed one selected PNG,
  loaded its preview, stripped the fragment, and had no horizontal overflow.
  Owner share-create previews also completed at both widths. Screenshot files
  are ignored under local `artifacts/` and contain a redacted placeholder
  rather than an active bearer token.
- `node --check` on server/client/integration/preview scripts and `git diff
  --check`: passed after the privacy, handoff, and evidence-note edits.

These are local test/fixture measurements, not customer usage, a security
assessment, hosted evidence, or a real target-browser job. Anonymous links are
bearer credentials: anyone possessing a current link can read its selected
content. Keep hosted workers disabled and do not publish this endpoint until
the above hosted safety gaps are resolved.

## 2026-09-30 continuation: database-backed share request limit

Migration `009_share_request_limit.sql` adds fixed-minute PostgreSQL buckets
keyed by share link. Shared report opens and in-scope artifact reads reserve a
bucket atomically before returning report data or reading an artifact. Default
limit is 120 valid requests per share/minute, configurable through
`ATLAS_SHARED_REPORT_RATE_LIMIT_PER_MINUTE` (all API instances must use the
same setting). Excess requests return HTTP 429 with `Retry-After: 60`. No IP is
used in this limiter. Maintenance removes buckets more than two minutes old;
share deletion cascades matching counters. Unknown-token attempts are not
limited by this layer and still need network-edge abuse protection.

- Local Postgres integration uses a limit of two: one open and one artifact
  download succeed on API instance A; an open via instance B, with a separate
  pool, receives 429. The database records three requests but only two
  successful share accesses.
- `npm run migrate --prefix apps/control-plane`: migration 009 applied to local
  PostgreSQL.
- `node --test apps/control-plane/tests/integration.test.js`: **2/2 passed**.
- `npm test --prefix apps/control-plane` with loopback Postgres: **35/35
  passed**, including maintenance bucket cleanup. Root `npm test`: **390/390
  passed**.
- `npm run preview:screenshots --prefix apps/control-plane`: passed. Desktop
  1440 px and mobile 390 px previews use synthetic run/artifact data; shared
  report loaded one selected PNG, stripped the fragment token, and had no
  horizontal overflow.
- `node --check` on the changed server, maintenance, and test scripts plus
  `git diff --check`: passed after the documentation updates.

This proves local cross-instance database enforcement under a small test, not
production throughput, edge filtering, invalid-token throttling, deployment
logging, or general quota enforcement.
