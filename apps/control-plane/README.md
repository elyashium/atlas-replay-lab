# Atlas control plane (local development)

This is the separate web/API package around Atlas's versioned engine. It uses
Supabase Auth for sign-in and the package's PostgreSQL schema for Atlas
organizations, projects, target contracts, runs, and review records. The
Supabase publishable key is safe for browser use; never put a service-role key
in this app. The engine CLI remains usable offline without this package.

## Start locally

Requirements: Node.js 20+, Docker Desktop, and a Supabase project with email
sign-in enabled.

1. Copy `.env.example` to `.env` and set `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, and (optionally) `GROQ_API_KEY`. Keep `.env` private.
   The Supabase key may be the project's publishable/anon key. The duplicate
   `VITE_*` names are accepted for compatibility; the server returns the
   public auth configuration at `/v1/auth/config`.
2. Install and start the local database:

   ```powershell
   npm install --prefix apps/control-plane
   docker compose -f apps/control-plane/docker-compose.yml up -d postgres
   ```

3. Apply migrations and start the app:

   ```powershell
   npm run migrate --prefix apps/control-plane
   npm start --prefix apps/control-plane
   ```

4. Open `http://127.0.0.1:3000`. In Supabase Auth URL configuration, allow
   `http://127.0.0.1:3000/` as a redirect URL. When email confirmation is on,
   sign-up asks the person to confirm by email before Atlas creates their first
   organization. Do not use `example.test` addresses for a real sign-in.

Target setup includes a static preflight for contract validity and current DNS
classification. It does not open the page, test selectors, verify ownership,
or prove the browser journey; registration and DNS TXT verification follow as
separate steps.

The Component Visual QA panel can compare screenshots from two completed runs
of the same target and contract version. It only pairs PNGs with the same
profile/checkpoint/component path, checks both stored hashes, records artifact
provenance, and runs the deterministic pixel comparison. A target contract may
also opt into a version 1 component visual gate by setting
`policy.visualGate.maxPixelDiffRatio` (0 through 1) and enabling consented
component screenshots. The app then evaluates one matching component capture
against a prior SHIP run from a distinct immutable build. Its immutable
SHIP/HOLD/INCONCLUSIVE result includes exact artifact hashes and the threshold,
and is audited and retained with the runs. It is explicitly scoped to that one
component/profile/checkpoint; it does not aggregate or overwrite the target
run's release verdict. Groq findings remain advisory and cannot affect either
verdict.

The local `.env.example` database password is only for the Docker development
container. For another database, set `DATABASE_URL` to its PostgreSQL
connection string before running migrations or starting Atlas. Supabase Auth
is connected here; Atlas product data is not stored in Supabase's REST API.

## Run a real local browser job

This starts the opt-in Docker worker on your machine. Keep both services bound
to loopback and use only staging targets you are authorized to test. Do not
expose this setup to the internet.

1. Build the isolated worker image from the repository root:

   ```powershell
   docker build -f apps/worker/Dockerfile -t atlas-worker:local .
   ```

2. In the API terminal, set `ATLAS_LOCAL_ARTIFACT_DIR` to a private absolute
   directory outside the repository (the example uses `C:\atlas-local-artifacts`),
   then start Atlas:

   ```powershell
   npm start --prefix apps/control-plane
   ```

   The server and worker read `apps/control-plane/.env`; shell variables take
   precedence over file values.

3. In a second terminal, point the worker at the same local database and
   artifact directory, explicitly opt in, then start it:

   ```powershell
   $env:DATABASE_URL = "postgres://atlas:local-only-change-me@127.0.0.1:5432/atlas"
   $env:ATLAS_LOCAL_ARTIFACT_DIR = "C:\atlas-local-artifacts"
   $env:ATLAS_ENABLE_LOCAL_WORKER = "1"
   npm run worker:local --prefix apps/control-plane
   ```

   The worker claims queued runs, executes verified HTTPS targets in a fresh
   bounded Docker job, and writes artifacts to that local directory. It does
   not start with the API by default. A queued row is not a completed test; a
   worker or harness failure remains `INCONCLUSIVE`.

4. In the UI, create a project, validate and register your staging contract,
   complete its DNS TXT ownership challenge, and submit a run. Inspect the
   completed run and artifact hashes in the report.

This path uses local filesystem artifacts, not object storage. The worker
boundary verifier is a separate synthetic test and is not a test of your
customer journey or proof of production isolation. See
[`../worker/README.md`](../worker/README.md) for current local-worker limits.

## Private object storage

Filesystem storage remains the local default. To use an S3-compatible bucket,
set `ATLAS_ARTIFACT_S3_BUCKET`, `ATLAS_ARTIFACT_S3_REGION`, and the bucket's
access key ID and secret in the ignored `.env`. Set
`ATLAS_ARTIFACT_S3_ENDPOINT` for S3-compatible providers; the API and worker
use the same bucket configuration. `NODE_ENV=production` refuses to start
without a configured bucket. Artifact objects are uploaded by the worker and
served through authenticated Atlas routes, which verify byte length and SHA-256;
the API does not return public object URLs.

Keep the bucket private, use TLS, restrict credentials to the Atlas artifact
prefix, and configure provider encryption, backups, and deletion lifecycle.
The adapter has mock-based tests and one disposable local RustFS round trip.
Retention uses S3 `ListObjectVersions` and deletes every listed version and
delete marker by version ID; providers that cannot return a complete version
listing fail the purge and leave it queued for retry. This code path has not
yet been exercised against the selected hosted provider. Provider permissions,
backup purge, and restore have not been verified. Do not enable hosted runs
until those controls are tested with the selected provider and region.

For a disposable loopback S3-compatible test bucket, set
`ATLAS_ARTIFACT_S3_ENDPOINT=http://127.0.0.1:<port>`, its region and credentials,
`ATLAS_TEST_ARTIFACT_S3_BUCKET` to an already-created test bucket, and
`ATLAS_ARTIFACT_S3_TEST=1`, then run:

```powershell
npm run verify:artifact-store --prefix apps/control-plane
```

The command refuses production mode and non-loopback endpoints. It writes one
random-prefix object and deletes it; use a disposable bucket.

Run submission is bounded per organization by `ATLAS_RUN_DAILY_LIMIT` (default
100 new run records per UTC day) and `ATLAS_RUN_CONCURRENT_LIMIT` (default 5
queued or running records). PostgreSQL advisory locks serialize quota checks
across API instances. Idempotent retries return the existing run without
counting again. These are configurable safety limits, not pricing tiers or
validated customer usage allowances.

## Checks

```powershell
$env:DATABASE_URL = "postgres://atlas:local-only-change-me@127.0.0.1:5432/atlas"
npm run migrate --prefix apps/control-plane
npm test --prefix apps/control-plane
npm run build --prefix apps/control-plane
npm test
```

`npm start` builds the frontend and starts Fastify. The current local run lane
still requires the explicitly configured isolated worker. A queued row alone
is not browser evidence or a release pass. Local artifacts use the configured
filesystem storage path; this is not a public hosted deployment.

Visual review is optional. A submitted image is sent to Groq only after
explicit image-provider consent. The current default vision model is a Groq
preview model, and the result is advisory (`verdictEffect: none`). Pin a model
with `GROQ_VISION_MODEL`; review Groq's current availability and terms before
using this outside development. Never send customer screenshots, source code,
credentials, or personal content during a smoke check.
