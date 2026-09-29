# Isolated browser worker prototype

This directory contains a pinned Chromium image and a local Docker network-boundary verifier. It is an engineering prototype, not a hosted runner. The API still records a run as `queued` and does not dispatch it to this image.

## Build and verify locally

From the repository root:

```powershell
docker build -f apps/worker/Dockerfile -t atlas-worker:local .
npm run verify:worker-boundary --prefix apps/control-plane
```

The verifier creates temporary Docker networks and three containers: a synthetic HTTPS origin, an egress proxy, and the unprivileged worker. It checks that the worker cannot resolve DNS or open direct sockets to the synthetic origin, a public address, or the metadata address; rejects an origin not in the job allowlist; then starts Chromium and confirms that it can fetch the synthetic HTTPS origin through the proxy. It removes its containers and networks on exit.

The fixture certificate is synthetic, and certificate verification is disabled only in the verifier's browser invocation. This does not change normal Atlas browser verification. The fixture uses an address reserved for documentation and is not a customer target.

## Isolation properties exercised

- The browser container joins an internal job network, has no external interface, and receives no credentials.
- DNS is pointed at a non-resolving loopback address; Chromium is configured to use the per-job proxy, disable proxy bypass, QUIC and DoH, and disable non-proxied WebRTC UDP.
- The proxy connects to the numeric address it checked, and accepts only exact HTTPS origins from the job contract.
- The worker is non-root, read-only except for bounded temporary filesystems, has all Linux capabilities dropped, `no-new-privileges`, a seccomp profile, and Docker CPU, memory and process limits.
- Chromium keeps its user namespace sandbox enabled; the profile allows the namespace syscalls Chromium needs.

These controls and one local Docker test do not prove production isolation. The verifier does not yet cover the full adversarial matrix in `docs/threat-model-worker-egress.md`, production container-runtime behavior, malicious browser escape, job cancellation, artifact extraction, quotas, or API queue dispatch. Do not expose this worker or arbitrary-URL endpoint publicly.

## Image provenance

The Node base image is pinned by digest, and Chromium packages are version-pinned in the Dockerfile. Rebuilds may fail when the pinned packages leave the configured Debian repository; update them only with a reviewed browser/runtime change and rerun the boundary verifier. `seccomp.json` is based on Moby Profiles' default profile at commit `85e237f1fe229a0c61c9c7d8e743fa780d3b97ca`, with namespace syscall rules needed by Chromium. Its Apache-2.0 license is included at `licenses/MOBY-PROFILES-LICENSE.txt`.
