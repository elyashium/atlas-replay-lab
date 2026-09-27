# Phase 2 local control-plane slice — 2026-09-27–28

## Current architecture boundary

```mermaid
flowchart LR
  User[Studio user] --> UI[Same-origin web UI]
  UI --> API[Fastify API and session auth]
  API --> DB[(PostgreSQL: orgs, targets, queued runs, audit)]
  API --> DNS[DNS ownership challenge]
  DB -. queued rows only .-> Worker[Isolated Chrome worker: not implemented]
  Worker -. future .-> Objects[(Private object storage: not implemented)]
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
organization-scoped project, target, and run status API routes. A target must pass the DNS challenge before
the API will create a queued run record. Each run stores a snapshot of the
validated contract, selected policy version, requestor, and a 30-day expiry
timestamp. A required idempotency key maps request retries back to the same run
row. The server purges expired sessions, share-link records, and non-running
run rows hourly. The integration test exercised deletion of expired run and
artifact metadata rows against PostgreSQL. The run stays `queued` and has no
verdict because no worker is connected.

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

- `npm test` (repository root): **264/264 CLI tests passed**, using the
  dependency-free `scripts/test-core.js` runner. Node 20.18.0, Windows x64.
- `npm test` (in `apps/control-plane` with local `DATABASE_URL`): **13/13
  tests passed**, including one real Postgres flow across account/org/project,
  mocked DNS ownership verification, idempotent queued records, cross-org read
  denial, and retention deletion of run/artifact metadata. Other tests cover
  password/cookie helpers, same-origin writes, project scoping, and health.
- `npm ci --offline` (in `apps/control-plane`): **passed**, installed the locked
  dependency tree and reported **0 known vulnerabilities** from the local npm
  advisory cache.
- `node bin/atlas.js doctor`: **passed**; Node 20.18.0 and Chrome 154.0.8037.57
  were found and CDP connected.
- `npm run preview:screenshots` (in `apps/control-plane`): **passed** through
  the existing CDP harness after creating and cleaning up a disposable local
  account/project. Captures show the guided target form at desktop 1440×1100
  and emulated mobile 390×844 CSS px (DPR 2); document widths matched their
  viewports, with no horizontal overflow. Both captures were visually
  inspected. Artifacts are ignored under
  `artifacts/control-plane-wizard-{desktop,mobile}.png`.
- `npm run migrate` (in `apps/control-plane`): **passed** against the local
  PostgreSQL 17 container and applied `001_initial`. The real integration test
  proves the tested query paths, not a comprehensive tenant-isolation audit or
  the hosted network boundary. DNS answers/TXT were stubbed to avoid contacting
  or running an outside studio target.
- No queue consumer/browser worker, report renderer, artifact object store,
  client-share flow, real run metrics, or release verdict was exercised.

## Blocking gaps before hosted use

The DNS lookup is a one-time onboarding check, not protection from DNS
rebinding, redirect pivots, private subresources, metadata services, or unsafe
downloads. There is no worker network namespace or outbound allowlist. Browser
execution is deliberately absent. There is no S3-compatible storage, artifact
content-serving endpoint, job retry/cancellation, quotas, distributed
rate limiting, backup/blob deletion proof, expiring
revocable report links, MFA/recovery, deployment hardening, or end-to-end
second-tenant attack test. The current session/password implementation has no
email verification or recovery and should receive a security review before
hosting. The scheduled purge covers PostgreSQL session, share-link, and
non-running run rows, and the integration test exercised the row/metadata
deletion path. There are no blobs or backups connected to purge yet.

This is a local development control-plane foundation; it is not a hosted MVP
and not production ready.
