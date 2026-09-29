# Local visual QA slice — 2026-09-29

## Shipped

- `atlas visual-compare --baseline <png> --actual <png>` compares PNGs and
  records SHA-256 hashes, pixel difference ratio, coarse perceptual score,
  divergence bounds, thresholds, and a heatmap. Dimension mismatch is
  INCONCLUSIVE. This result does not affect the release gate.
- `atlas visual-review --image <png> --consent-to-send-images` accepts a
  user-provided component screenshot under `artifacts/`. Owned-staging matrix
  screenshots require the target contract's capture consent plus separate
  provider-egress consent. Component reviews may include a same-size reference
  and team criteria. A missing model location is retained as an unlocalized
  finding (`region: null`). Provider/schema failures remain inconclusive.
- The optional Groq vision adapter is bounded by PNG size/dimensions, timeout,
  response size and schema validation. It hashes evidence and labels outputs
  as model suggestions with `verdictEffect: none`. Jev and the deterministic
  release gate remain separate.
- `atlas suggest-code-fix --source <file> --consent-to-send-code` sends one
  source file from `artifacts/` and analyzed findings for a single-file diff
  proposal. It rejects credential-like content and oversized or unsafe input.
  It saves a proposal for human review; it does not apply the diff or run tests.
- HTML reports show deterministic comparison, vision suggestions and code
  proposals in separate sections. The report's matrix table scrolls on small
  screens, and report images fit the available width.
- ADR-0008 and `docs/visual-qa-platform.md` describe the model boundary and the
  next platform work. No root/core dependencies were added.

## Verification and measurement

Environment: Windows x64, Node 20.18.0, Chrome 154.0.8037.58.

- `npm test` — **388/388 passed** through the root dependency-free runner.
- `node bin/atlas.js doctor` — **passed**; manifest and assets valid, Chrome
  launched, CDP 1.3 connected. No external call was made by `doctor`.
- `node bin/atlas.js visual-review --help`, `visual-compare --help`, and
  `suggest-code-fix --help` — **passed**.
- `git diff --check` — **passed**.
- Synthetic screenshot comparison produced a 0.0303 pixel-difference ratio
  and 0.991202 coarse perceptual score against thresholds 0.02 and 0.98; it
  correctly reported a threshold failure. Desktop (1440px) and mobile (390px)
  report layouts were visually inspected; document width matched each
  viewport. These synthetic images are not customer evidence or a model
  benchmark.
- One authorized Groq smoke request used synthetic component/reference images
  and placeholder criteria only. The provider returned a response, but its
  issue omitted the requested region, so the pre-fix adapter recorded an
  inconclusive result (0/1 images analyzed). The validator now safely maps a
  missing region to `null`; no post-fix provider retry has been measured.
  Therefore live visual-review success, quality, localization, latency,
  repeatability and cost remain unverified.

## Limits and remaining work

- This is a local CLI slice, not a hosted service. It has no browser worker,
  organization/auth layer, job queue, object store, tenant isolation, SSRF-safe
  browser egress, retention enforcement, or share links.
- Code proposals are not sandboxed or automatically applied. No source upload
  UI, patch verification, PR integration, or test execution exists.
- The vision model's confidence is self-reported and uncalibrated. Pixel
  comparison has no dynamic-region masks, viewport normalization, DOM
  semantics, accessibility verdict, or objective design-quality score.
- Synthetic model fixtures and the one inconclusive live smoke do not establish
  visual-review accuracy or commercial demand.

## 2026-09-30 continuation: guarded diff validation

The code-proposal adapter now parses every unified-diff hunk rather than only
checking the first file headers. It rejects appended second-file headers,
unsupported trailing content, malformed/overlapping hunks, mismatched line
counts, and context/deleted lines that do not match the consented source. It
computes the proposed candidate's SHA-256 in memory while retaining neither
source nor candidate content in the result. `applied` and `testsRun` remain
false; this does not prove a change is behaviorally correct or apply-able in
every toolchain.

Verification: `node --test tests/groq-patch.test.js` passed **4/4**, including
multi-file/trailing-path, truncated-hunk and mismatched-source-context cases.
It also verifies multiple valid hunks produce a candidate hash. The full root
suite passed **398/398**; control-plane tests with local Postgres
17.11 passed **37/37**; `doctor` and `git diff --check` passed. All provider
calls were mocked. No source was sent to Groq and no proposal quality or patch
execution was measured.

The synthetic UI preview (`npm run preview:screenshots --prefix
apps/control-plane`, with local Postgres) passed at **1440 px** and **390 px**.
The code proposal view displayed the source and candidate hashes, said that
hunks matched supplied source, and clearly stated Atlas did not write, run, or
test the candidate. Both viewports had no horizontal overflow. I inspected the
generated desktop and mobile proposal screenshots. The preview injected a
synthetic proposal; it made no provider request and is not a model-result
measurement.

## 2026-09-30 continuation: consented component crops

Owned target contracts may optionally declare up to five unique component
selectors under `screenshots.componentSelectors`. The existing target contract
version remains v1 and omission stays backward-compatible. Capture requires
the target's screenshot consent plus at least one redaction selector. At the
final declared journey checkpoint, Chromium requires exactly one visible,
fully in-viewport match per selector, enforces dimension and PNG size limits,
and writes a separate PNG. Failure reasons are attached to the matrix row and
trace notes; crop failures never create a visual pass.

Verification on the synthetic isolated TLS target: the worker boundary script
blocked direct public/private connections, observed 22 denied browser egress
attempts and five UDP trap packets (not an external STUN test), then completed
one Chromium matrix run. It exported a **240×120** selector crop beside the
**1280×800** full checkpoint. The journey itself passed, while the Atlas core
gate held because the synthetic trace score was **35**, below its existing
50-point floor. This verifies crop plumbing and fail-closed gate consistency;
it does not measure crop privacy quality, visual-review accuracy, or customer
behavior.

`npm test` passed **399/399**; control-plane tests with local Postgres passed
**37/37**; `node --check` for changed JS, `git diff --check`, and the isolated
worker build passed. The synthetic UI preview passed at **1440 px** and
**390 px** with no horizontal overflow; I inspected the target wizard at both
sizes. Provider calls remained mocked. No key was used and no customer image
was sent to Groq.

## 2026-09-30 continuation: visual review source provenance

Reviews submitted from a completed run PNG now send the selected run and
artifact IDs. The API verifies that the artifact is a PNG attached to a
completed run in the same project and that its stored SHA-256 matches the exact
submitted PNG bytes before egress. It records source run/artifact IDs and the
artifact basename in review history and the egress audit event. Uploaded images
have no linked source. Images remain unpersisted; the 30-day review record
contains hashes, findings, criteria, and provenance identifiers only.

Added reversible migration `010_visual_review_provenance.sql`. Targeted API
tests cover valid provenance, a missing/cross-project artifact, and a hash
mismatch that blocks provider invocation. This is traceability for the local
synchronous review path; it does not make the visual result a release verdict.

After migration 010 was applied to the local PostgreSQL 17 database,
`npm test --prefix apps/control-plane` passed **38/38** and root `npm test`
passed **399/399**. The browser preview completed at 1440 px and 390 px with
no horizontal overflow; both rendered histories showed the run and exact
artifact basename as source provenance. The preview image/model remain
synthetic fixtures, and no provider call was made.

## 2026-09-30 continuation: human finding dispositions

Migration `011_visual_finding_dispositions.sql` adds a reversible, tenant-scoped
table for `confirmed`, `accepted-risk`, `false-positive`, and `needs-follow-up`
labels. There is no free-text note. Only organization editors can update a
finding from a completed visual review. Updates serialize on the review row,
same-value retries create no duplicate audit entry, changed/cleared values are
audited, and the labels cascade-delete with the review at its enforced expiry.
The project endpoint returns current labels. The rule release decision remains
separate and the UI says so beside each selector.

The Postgres integration test applied a disposition, retried it, checked the
single audit entry and project history, then exercised review retention cleanup.
The browser preview saved a synthetic `confirmed` label and reloaded it at both
1440 px and 390 px; neither viewport had horizontal overflow. I inspected both
visual-review screenshots. `node --test
apps/control-plane/tests/visual-review-api.test.js` passed **8/8** and the
Postgres visual-review integration passed **1/1**. Provider calls remained
mocked; these labels are not evaluated ground truth or a quality benchmark.

After the final run-lock and retention checks were added,
`npm test --prefix apps/control-plane` passed **39/39** and root `npm test`
passed **399/399**. The local PostgreSQL database has migrations through 011.
The synthetic browser preview again saved/reloaded `confirmed` at desktop and
mobile widths without horizontal overflow; provider calls were mocked.

## 2026-09-30 continuation: enforce visual-record expiry at reads

Project detail now filters expired visual reviews, finding dispositions, and
code proposals at query time, so an overdue retention worker cannot leave
expired material visible through the API. Creating a proposal requires an
unexpired source review; idempotent retries for an expired visual review or
code proposal return `410 Gone`. The Postgres integration scenario expires a
proposal while its source review remains active, checks its retry is rejected,
then expires the review and checks that the project response omits its report,
labels, and proposals. A fresh proposal request against that expired review is
rejected before calling the provider. Physical row deletion and its audit event
remain the maintenance worker's job; this does not establish backup, object
storage, or Groq-side deletion.

Verification on 2026-09-30: `node --test
apps/control-plane/tests/visual-review-api.test.js
apps/control-plane/tests/visual-review-integration.test.js` passed **10/10** with
local Postgres, including an OpenAPI expiry-contract assertion. The control-plane
suite passed **40/40**, root `npm test` passed **400/400**,
`node --check` passed for the changed server and API test, and `git diff
--check` passed. Provider calls were mocked; no screenshot or source was sent
to Groq.

## Reproduce local checks

```powershell
node bin/atlas.js doctor
node bin/atlas.js visual-compare --baseline artifacts/components/baseline.png --actual artifacts/components/current.png
node bin/atlas.js report
$env:GROQ_API_KEY = "<key supplied by the operator>"
node bin/atlas.js visual-review --image artifacts/components/current.png --consent-to-send-images
node bin/atlas.js report
```

Inspect and redact images locally before provider egress. Keep keys out of the
repository and generated artifacts.

## 2026-09-30 continuation: Supabase Auth and landing page

The control-plane app now supports Supabase email/password sign-up and
sign-in. The server verifies access tokens through Supabase Auth, links the
verified provider subject to an Atlas user, and provisions one organization
idempotently. In Supabase mode, local password registration/login and cookie
sessions are disabled. Migration `012_supabase_auth.sql` adds the reversible
identity mapping. The publishable key is returned only through the documented
public auth configuration; no service-role key is used. Atlas project/run data
continues to use the control plane's PostgreSQL schema, not Supabase REST.

The app now has an evidence-first Web3D/WebAR landing page and setup guide at
`apps/control-plane/README.md`. `npm start --prefix apps/control-plane` now
builds and launches the server through its wrapper. The start-path smoke
exercised `GET /`, the auth configuration, static frontend bundle, and the
blocked local login endpoint. The live Supabase Auth settings endpoint
returned HTTP 200 for the configured project. No user account was created, so
email-delivery, confirmation redirect, full sign-in, and first-workspace
provisioning remain unverified against the actual Supabase account. The
Supabase integration test uses a controlled fake verifier and local Postgres.

Verification on 2026-09-30, Windows x64 / Node 20.18.0:

- Root `npm test`: **400/400 passed**.
- With local Docker PostgreSQL 17 and migrations through 012,
  `npm test --prefix apps/control-plane`: **45/45 passed**.
- `npm run build --prefix apps/control-plane`: passed (Vite production build).
- `npm start --prefix apps/control-plane`: served on `127.0.0.1:3000`; the
  server health route becomes healthy when the local database is available.
- Desktop landing at **1440 px** and mobile at **390 px** had no horizontal
  overflow and no browser exceptions. I inspected both; the mobile decorative
  labels were moved off the report illustration after the first visual check.
  Screenshots are local, ignored artifacts at
  `artifacts/landing-desktop.png` and `artifacts/landing-mobile.png`.
- One real Groq visual-review call sent only a **32 x 32 synthetic solid-color
  PNG**. `qwen/qwen3.8-27b` returned successfully in **633 ms**, with zero
  findings and `verdictEffect: none`. This checks provider connectivity and
  response parsing only; it is not a model-quality, latency, cost, or visual
  QA benchmark. A first 16 x 16 probe received HTTP 400; resizing the synthetic
  fixture to 32 x 32 produced a successful call. No user/customer data was
  sent.

The default Groq vision model is currently marked preview by Groq; review its
[current model information](https://console.groq.com/docs/model/qwen/qwen3.8-27b)
before relying on it outside development. The control plane is not production
hosted: the local development database and artifact storage are not managed
production infrastructure, the hosted isolated worker and object store are
not enabled, and real Supabase sign-up has not been completed in this project.
A local Docker PostgreSQL instance is provisioned for development. Supabase
Postgres is optional and is not required by the current schema integration.

## 2026-09-30 continuation: redirect evidence in worker SSRF verifier

The isolated Chromium network verifier previously asserted that a redirected
iframe's `load` event completed, which does not by itself prove that its
forbidden destination was blocked. The verifier now records denied request
host/path pairs and requires an actual failed request to
`169.254.169.254/metadata-probe` from the cross-origin redirect. This makes the
iframe navigation completion explicitly non-authoritative evidence.

Rebuilt `atlas-worker:local` and ran
`npm run verify:worker-boundary --prefix apps/control-plane` on Docker Desktop.
Observed: direct synthetic-target/public/metadata sockets failed with
`ENETUNREACH`; the browser had six failed forbidden requests; the metadata
redirect was explicitly observed failing; and the proxy logged 21 rejected
browser egress attempts. Five UDP probe packets reached the same-job-network
trap, with zero server-reflexive candidates. That does not test external
STUN/TURN reachability. One actual target-contract job completed in the
isolated Chromium container and exported the 240 x 120 component crop beside
the 1280 x 800 checkpoint. Its customer-declared target policy returned SHIP,
while the deterministic Atlas release gate returned HOLD because score 35 is
below the hard 50-point floor. The top-level job result retained HOLD. This is
synthetic harness evidence, not a customer run or real target-quality proof.

The control-plane CI job now runs `npm run build --prefix apps/control-plane`
after its PostgreSQL-backed test suite so frontend compilation is a required
check. The Docker boundary verifier remains local and is not part of CI.

## 2026-09-30 continuation: target static preflight and share-entry fix

The target onboarding UI and API now have an explicit read-only static
preflight. It requires a valid versioned contract, immutable build/deployment
ID, HTTPS origins on standard port, and a DNS answer set consisting only of
public addresses. It does not persist a target, verify DNS ownership, open the
browser, or validate selectors. The UI requires a successful preflight before
registration and invalidates that result when any target setting changes.
Registration reruns the checks and then issues the separate TXT ownership
challenge. The API includes a tenant-scoped project check and performs no
target/audit insert during preflight.

The first updated browser preview exposed that anonymous share URLs still
referenced the removed `.intro` element and therefore remained on the landing
page. The share-entry handler now hides the actual landing and workspace
sections before loading the report. `npm run preview:screenshots --prefix
apps/control-plane` then completed at 1440 px desktop and 390 px mobile,
including static preflight, anonymous shared report, selected PNG preview,
local comparison, advisory finding, disposition, and unapplied code proposal.
All measured layouts had matching viewport/client/scroll widths. I visually
inspected the mobile target-preflight and anonymous-share screenshots; the
preflight explicitly shows pending ownership and untested selectors. The
shared-report fixture is illustrative and inconclusive; it is not a browser
run.

Verification after these changes: `npm test --prefix apps/control-plane`
passed **47/47** with local PostgreSQL; `npm run build --prefix
apps/control-plane`, `node --check` for the changed server and browser script,
and `git diff --check` passed. Static preflight API tests prove valid checks
make no target/audit insert, public/private DNS is handled fail-closed, and a
missing build ID is rejected. This still does not execute a target journey or
replace the isolated-worker SSRF boundary.

## 2026-09-30 continuation: organization run quotas

Run submission now enforces configurable defaults of 100 new run records per
organization UTC day and five queued/running records. The API takes a
transaction-scoped, organization-specific PostgreSQL advisory lock before it
checks an idempotency key and counts usage, then performs the insert while
still holding that lock. Retries find the original row before checking either
quota. The active count excludes expired metadata and drops on cancellation or
completion. Daily counts include canceled and failed submissions so they
cannot be repeatedly cycled to evade the quota. Responses return `429` with a
quota type, configured limit, and retry guidance. The queue UI surfaces that
guidance. These are configurable operational defaults, not approved pricing
tiers or estimates of customer use.

Reversible migration `013_run_quota_indexes.sql` adds organization/date and
organization/active indexes. API unit tests cover daily and concurrent
rejection plus idempotent retry behavior. A PostgreSQL integration test uses
two separate API instances and database pools to race different idempotency
keys: exactly one request receives the sole concurrency slot, the retry is
idempotent, cancellation frees capacity, and the second accepted run exhausts
the daily cap. It verifies only two run rows were created.

Verification on 2026-09-30: migrations through 013 applied to local Docker
PostgreSQL 17; full `npm test --prefix apps/control-plane` passed **50/50**,
including the multi-instance quota integration; root `npm test` remains
**400/400**; frontend build, browser preview, `node --check`, and
`git diff --check` passed. Limits still require production operator tuning,
monitoring, abuse controls, and customer-validated allowances.

## 2026-09-30 continuation: screenshot request-size regression check

The visual-review endpoint has a route-local **28 MiB** JSON body cap to carry
up to two base64 PNGs, while the general API retains its **256 KiB** cap. A
new API test submits two valid random **512 x 512 PNGs**, each larger than 256
KiB, through the consented review route with a mocked provider. That request
succeeds, while an unrelated project-write payload above 256 KiB returns
`413 Payload Too Large`. This verifies the larger cap is isolated to visual
review; it does not benchmark memory under concurrent large uploads.

`node --test apps/control-plane/tests/visual-review-api.test.js` passed **10/10**.
