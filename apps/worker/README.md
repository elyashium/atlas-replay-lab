# Isolated browser worker prototype

This directory contains a pinned Chromium image, a local Docker network-boundary verifier, and a target-contract executor. It is a local development runner, not a hosted service. A separate opt-in worker process can claim queue rows; the API itself never starts browsers.

## Build and verify locally

From the repository root:

```powershell
docker build -f apps/worker/Dockerfile -t atlas-worker:local .
npm run verify:worker-boundary --prefix apps/control-plane
```

To process runs in the local control-plane setup, start Postgres and apply migrations, configure a private artifact directory outside the repository, then launch the API and worker in separate terminals:

```powershell
$env:DATABASE_URL = "postgres://atlas:local-only-change-me@127.0.0.1:5432/atlas"
$env:ATLAS_LOCAL_ARTIFACT_DIR = "C:\atlas-local-artifacts"
$env:ATLAS_APP_ORIGIN = "http://127.0.0.1:3000"
npm run start --prefix apps/control-plane
```

In a second terminal, use the same environment and explicitly opt in:

```powershell
$env:DATABASE_URL = "postgres://atlas:local-only-change-me@127.0.0.1:5432/atlas"
$env:ATLAS_LOCAL_ARTIFACT_DIR = "C:\atlas-local-artifacts"
$env:ATLAS_ENABLE_LOCAL_WORKER = "1"
npm run worker:local --prefix apps/control-plane
```

The worker only accepts verified HTTPS targets, runs profiles sequentially in a fresh container/profile, retries harness failures once, and records exhausted harness failures as `INCONCLUSIVE`. Target failures are completed runs with the deterministic gate's `HOLD`; they are not retried as harness errors. Artifact metadata is tenant-scoped in Postgres; files are stored under `<artifact-dir>/<run-uuid>/`, served only after organization authentication and hash verification, and purged through a retryable retention queue. This local directory is not encrypted object storage or a backup system.

The verifier creates temporary Docker networks and containers for a synthetic HTTPS origin, an egress proxy, a boundary-check browser, and a separate full Atlas job. It checks that the job networks are Docker-internal, the browser worker has exactly one network attachment, and the egress proxy has only its expected attachments. It then checks that the worker cannot resolve DNS or open direct sockets to the synthetic origin, a public address, or the metadata address; rejects an origin not in the job allowlist; confirms Chromium reaches the synthetic HTTPS page through the proxy; and runs the actual target-contract matrix, deterministic gate, findings, and report in the isolated image. The browser adversarial page also attempts metadata access through fetch, image, redirect, iframe, WebSocket and a service worker, plus requests to an unlisted host and IP. Chromium reports blocked outcomes, and the proxy's test-only, hostname-free counters record the rejected CONNECTs. The verifier checks the final job verdict matches the gate report and cannot be SHIP when that report has a blocking finding. It transfers result artifacts while the bounded temporary output filesystem is still mounted, then removes its containers, networks, and temporary host files on exit.

The fixture certificate is synthetic, and certificate verification is disabled only in the verifier's browser invocation. This does not change normal Atlas browser verification. The fixture uses an address reserved for documentation and is not a customer target.

## Isolation properties exercised

- The browser container joins an internal job network, has no external interface, and receives no credentials.
- DNS is pointed at a non-resolving loopback address; Chromium is configured to use the per-job proxy and disable proxy bypass, QUIC, DoH, and non-proxied WebRTC UDP. The adversarial probe still observed STUN UDP packets reach a same-job-network trap, so the Chromium flag alone is not evidence that UDP is blocked.
- The proxy connects to the numeric address it checked, and accepts only exact HTTPS origins from the job contract.
- The worker is non-root, read-only except for bounded temporary filesystems, has all Linux capabilities dropped, `no-new-privileges`, a seccomp profile, and Docker CPU, memory and process limits.
- Chromium keeps its user namespace sandbox enabled; the profile allows the namespace syscalls Chromium needs.

This proves one synthetic target contract on one local Docker Desktop setup (one `high-wifi` profile; no screenshots), including Atlas evidence creation and collection. In the latest verification the browser had six failed requests to forbidden destinations, the proxy recorded 21 refusals, and the synthetic target completed with SHIP at score 99; these are single-run measurements, not a repeated benchmark. A WebRTC probe sent five UDP packets to a test trap on the same internal job network and produced zero server-reflexive candidates. Docker's internal network was not tested against an external STUN service, so this does not establish external UDP behavior; production still needs host/runtime-enforced default-deny UDP egress and a deployment-specific test. Runtime topology assertions make the local Docker assumptions fail closed, but do not prove production isolation. The verifier does not yet cover the full adversarial matrix in `docs/threat-model-worker-egress.md`, alternate-proxy configuration, downloads, external WebRTC/STUN reachability, production container-runtime behavior, malicious browser escape, the full API-to-worker queue lifecycle, customer journeys, quotas, or hosted operations. Do not expose this worker or arbitrary-URL endpoint publicly.

## Image provenance

The Node base image is pinned by digest, and Chromium packages are version-pinned in the Dockerfile. Rebuilds may fail when the pinned packages leave the configured Debian repository; update them only with a reviewed browser/runtime change and rerun the boundary verifier. `seccomp.json` is based on Moby Profiles' default profile at commit `85e237f1fe229a0c61c9c7d8e743fa780d3b97ca`, with namespace syscall rules needed by Chromium. Its Apache-2.0 license is included at `licenses/MOBY-PROFILES-LICENSE.txt`.
