# ADR-0008: connection-pinned per-job egress proxy

- Status: proxy component accepted; local opt-in Docker worker and network-boundary prototype verified; hosted worker remains deferred.
- Date: 2026-09-29.
- Decision owners: product/engineering.

## Context

The API's DNS check at target onboarding cannot prevent rebinding when Chrome
connects later. Browser pages can also initiate requests to subresources,
redirects, WebSockets, workers and downloads. A hostname allowlist checked only
before navigation therefore cannot protect a hosted worker.

## Decision

Add a small CONNECT-only HTTPS proxy in the control-plane package. Each job
provides exact HTTPS origins from its immutable target contract. For every
CONNECT authority, the proxy:

1. Rejects malformed authority forms, non-allowlisted origins, and ports other
   than HTTPS 443.
2. Resolves all A/AAAA answers and classifies every address using the shared
   destination policy; one forbidden or unknown answer refuses the connection.
3. Connects to the exact checked numeric address so it does not perform a
   second hostname lookup between authorization and socket creation.
4. Tunnels TLS bytes without terminating TLS. Ordinary HTTP proxy requests are
   refused, and a bounded number of tunnels is allowed per proxy instance.

The implementation is a necessary connection-time control, but it is not a
complete security boundary by itself. A worker must run in an ephemeral
network namespace/container with firewall policy that prevents Chrome from
reaching any destination except its per-job proxy. The worker image must disable
or block bypass paths (direct egress, DNS, QUIC, alternate proxy configuration)
and tests must observe enforcement at the actual network boundary. Because TLS
is opaque, the proxy authorizes CONNECT authority and destination address; it
does not inspect encrypted HTTP paths or prove that an application-level Host
header corresponds to the authority.

## Consequences

- The local component is independently testable without changing the
  zero-dependency CLI engine.
- DNS rebinding between lookup and connect is closed for the proxy's own socket
  because it dials a numeric result. Mixed public/private DNS sets fail closed.
- Exact origin policy means a target must enumerate required script, asset,
  API, and identity origins; wildcard origins are not supported.
- There is no worker consumer or network namespace yet. Do not route jobs to
  Chrome, expose the app publicly, or claim hosted SSRF protection based on the
  proxy tests.

## Verification required before integration

- Unit and local tunnel tests for allowed, denied, mixed DNS, DNS error/timeout,
  concurrency limits, and exact numeric dialing.
- Container-level tests that try direct sockets, DNS, alternate proxies, QUIC,
  redirects, iframes, fetch, WebSockets, downloads, and service workers against
  private/loopback/link-local/metadata destinations.
- Worker resource limits, cancellation, timeout, teardown, and no cross-run
  browser-state tests.
- A reviewed threat model and evidence that firewall policy is applied to the
  namespace actually running Chrome.

## Local prototype evidence (2026-09-29)

`npm run verify:worker-boundary --prefix apps/control-plane` passed on local
Docker Desktop 29.6.2. It used the pinned `atlas-worker:local` image and ran
Chromium against a synthetic HTTPS fixture. The isolated worker's DNS lookup
failed; direct TCP attempts to the fixture, `1.1.1.1:443`, and
`169.254.169.254:80` failed; a non-allowlisted CONNECT was denied; Chromium
loaded the fixture through the proxy. The verifier cleaned up its test
containers and networks. This is one local environment and one synthetic
fixture, not a production or comprehensive adversarial security test. The
opt-in local queue worker now uses the per-job proxy and isolated container;
hosted orchestration remains deferred.

## 2026-09-30 continuation

The same verifier now runs browser-originated probes for fetch, image, redirects
and iframe redirects, secure WebSocket, service-worker fetch, unlisted hostname
and unlisted IP. Chromium observed **6** failed forbidden requests and the
test-only proxy counter observed **21** refusals; that manual verifier then
completed a one-profile synthetic Atlas job and collected its reports. Counts
are a single local run, not an adversarial coverage percentage. Alternate proxy
and browser switches, WebRTC/STUN, downloads, rebinding, broad address ranges,
CI enforcement, and production runtime assurance remain open.
