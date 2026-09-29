# Threat model: the worker / browser egress boundary

**Status: threat model and preflight refusal implemented; connection-time egress
enforcement is partly prototyped locally, but API queue dispatch remains disabled.** This document
exists to satisfy Phase 2 item 1 and `security-operations.md` item 2. It is a
design and a test plan. One local synthetic HTTPS test demonstrates that Chromium
can use the proxy while an isolated worker cannot resolve DNS or directly connect
to sampled public/private addresses. This is partial local evidence, not
production assurance. Do not expose the worker or arbitrary-URL endpoint publicly.

Implementation of the preflight half: [`../src/net/destination-policy.js`](../src/net/destination-policy.js).
Tests: `tests/destination-policy.test.js`.
Boundary decision record: [`adr/0007-phase2-control-plane-boundary.md`](adr/0007-phase2-control-plane-boundary.md).
Proxy decision and implementation: [`adr/0008-connection-pinned-egress-proxy.md`](adr/0008-connection-pinned-egress-proxy.md), [`../apps/control-plane/src/egress-proxy.js`](../apps/control-plane/src/egress-proxy.js).
Local worker prototype and verification command: [`../apps/worker/README.md`](../apps/worker/README.md).

## Scope

One question: when Atlas opens a page on behalf of a tenant, what can that page
reach, and what stops it reaching anything else. Everything about billing,
identity and report sharing is out of scope here and lives in
[`handoffs/security-operations.md`](handoffs/security-operations.md).

## Assets

| Asset | Why an attacker wants it |
| --- | --- |
| Cloud instance metadata (`169.254.169.254`, `fd00:ec2::254`, `100.100.100.200`) | Short-lived credentials for the whole account. The single highest-value target. |
| The control-plane API and its database on loopback / private network | Tenant data, ownership records, other tenants' runs. |
| Other tenants' browser profiles, cookies, caches, artifacts | Cross-tenant read; the thing a multi-tenant promise is made of. |
| The worker's own filesystem and process environment | API keys (`TYPESAFE_API_KEY`), registry tokens, SSH keys. |
| Internal services with no authentication because they are "internal" | Lateral movement. |
| Outbound network capacity | Using Atlas as a relay for scanning or abuse, at Atlas's IP reputation. |

## Actors and trust

| Actor | Trust | Notes |
| --- | --- | --- |
| Operator running the CLI locally | Trusted | Runs targets they own. Today this is the only actor. |
| Authenticated tenant submitting a target URL | **Untrusted input, authenticated identity** | May submit a URL they do not own, or one that resolves differently per query. |
| The target page's own JavaScript | **Fully untrusted** | Executes inside the browser after every preflight check has already passed. |
| Third-party subresources the page loads | **Fully untrusted, and not enumerable in advance** | Analytics, CDNs, ad tags, fonts. Each is a fresh destination. |
| DNS answers | **Untrusted and mutable** | The attacker frequently controls the authoritative server. |
| The worker host's network stack | Trusted to enforce what it is configured to enforce | This is the only component that can actually stop a connection. |

Trust boundary that matters: **inside the browser process is untrusted.** Every
control that runs before the browser starts is advisory with respect to what the
page then does.

## Attack surface, by mechanism

Each row states the attack, whether the shipped preflight refuses it, and what
is still required. "Preflight" means `checkDestination` / `checkRedirectChain`.

### 1. Initial destination

| # | Attack | Preflight | Still required |
| --- | --- | --- | --- |
| 1.1 | Submit `http://127.0.0.1:5432/` directly | Refused (loopback) | — |
| 1.2 | Submit `http://169.254.169.254/latest/meta-data/` | Refused (link-local) | — |
| 1.3 | Submit `http://100.100.100.200/` (Alibaba metadata, CGNAT range) | Refused (shared-address-space) | — |
| 1.4 | Alternate numeric forms: `http://2130706433/`, `http://0177.0.0.1/`, `http://0x7f000001/`, `http://127.1/` | Refused — WHATWG `URL` canonicalises the host before the policy reads it; asserted by test rather than assumed | — |
| 1.5 | IPv4-mapped IPv6: `http://[::ffff:127.0.0.1]/`, `http://[::ffff:a9fe:a9fe]/` | Refused (classifier recurses into the embedded v4) | — |
| 1.6 | NAT64 / v4-compatible: `http://[64:ff9b::169.254.169.254]/`, `http://[::192.168.0.1]/` | Refused (same recursion) | — |
| 1.7 | Teredo / 6to4 tunnels: `http://[2001::1]/`, `http://[2002:c000:204::1]/` | Refused outright — the far end is peer-chosen, so there is no destination to reason about | — |
| 1.8 | Unique-local / link-local v6: `fd00::1`, `fe80::1`, `fe80::1%eth0` | Refused | — |
| 1.9 | Non-http scheme: `file://`, `gopher://`, `dict://`, `ftp://` | Refused (scheme allowlist) | Browser-level scheme restriction; the page can still attempt these itself |
| 1.10 | Credentials in URL: `https://u:p@host/` | Refused | — |
| 1.11 | Split-horizon DNS: one A record public, one loopback | Refused — **every** resolved address must pass, not the first | — |
| 1.12 | Host that resolves to nothing, or whose lookup errors | Refused (unknown fails closed) | — |
| 1.13 | Non-standard port to an internal service on a public IP | **Not refused.** A public address on port 9200 is permitted | Per-target port allowlist, or accept the risk explicitly for operator-owned targets |

### 2. Time-of-check to time-of-use

| # | Attack | Preflight | Still required |
| --- | --- | --- | --- |
| 2.1 | **DNS rebinding.** `attacker.test` answers `93.184.216.34` with TTL 1 to the preflight resolver, then `127.0.0.1` to the browser seconds later | **Not refused.** This is unfixable at preflight, by construction | Egress enforcement in the worker's network namespace, evaluated at connect time on the resolved address |
| 2.2 | Resolver disagreement: the policy's resolver and the browser's resolver are different code paths and may get different answers even without malice | Not refused | Same as 2.1, plus pinning the resolved address into the browser (`--host-resolver-rules`) so both agree — pinning alone is not sufficient, because subresources resolve their own names |
| 2.3 | Long-lived connection reused after a DNS change | Not refused | Connection-time enforcement; per-run ephemeral profile so no pool survives a run |

**This row is why the shipped module carries `ISOLATION_REQUIRED_NOTE` and why
its own header says it is not a security boundary.** No amount of range coverage
closes 2.1.

### 3. Redirects

| # | Attack | Preflight | Still required |
| --- | --- | --- | --- |
| 3.1 | `https://ok.test` → `301` → `http://169.254.169.254/` | Refused *if the caller re-checks each hop* — `checkRedirectChain` exists for this and names the refused hop index | The caller must actually pass the chain; a browser that follows redirects internally never hands one over |
| 3.2 | Meta-refresh / `location.assign` / `history.pushState` to a forbidden host | **Not refused** — no HTTP redirect to intercept | Connection-time enforcement |
| 3.3 | Redirect to a permitted origin that itself proxies to metadata (open redirect / SSRF-as-a-service on the target's own domain) | Not refused, and not refusable — the destination genuinely is the declared origin | Accept as residual risk for operator-owned targets; out of scope for untrusted targets, which are not run |

### 4. Subresources and in-page APIs

None of these are refused by preflight: every one of them is decided by page
code that runs after the check. They are listed to make the size of the gap
explicit rather than to imply coverage.

| # | Mechanism | Notes |
| --- | --- | --- |
| 4.1 | `<script>`, `<link>`, `<img>`, `<iframe>`, `<video>`, fonts | Arbitrary destinations, chosen at parse time |
| 4.2 | `fetch` / `XMLHttpRequest` | Cross-origin reads are blocked by CORS; the *request* still leaves, which is all an SSRF needs for a side effect |
| 4.3 | `WebSocket` | Not subject to CORS; a same-process channel to any reachable host |
| 4.4 | `EventSource`, `navigator.sendBeacon`, `Report-To`, `ping` attribute | Fire-and-forget egress |
| 4.5 | Service workers, `Cache` API | Persist across navigations within a profile — mitigated only by a per-run ephemeral profile |
| 4.6 | `WebRTC` data channels and STUN/TURN | Egress that is not HTTP and will not appear in the CDP network log |
| 4.7 | DNS prefetch, `<link rel=preconnect>` | Exfiltration over DNS alone |
| 4.8 | Downloads | Disk consumption and content that later enters an artifact pipeline |
| 4.9 | `WebTransport` / HTTP/3 | Bypasses proxy-based controls that only understand HTTP/1.1 and 2 |

Mitigation for the whole of section 4 is structural and identical: an egress
allowlist enforced outside the browser process, plus a per-run ephemeral profile,
plus no ambient credentials anywhere the browser can reach.

### 5. The worker itself

| # | Attack | Still required |
| --- | --- | --- |
| 5.1 | Renderer sandbox escape reaching the worker filesystem | One-run-per-container; no secrets in the container; no shared mounts |
| 5.2 | Reading `TYPESAFE_API_KEY` or registry tokens from the environment | Workers hold no credentials; model calls, if any, are made by the control plane, never by the worker |
| 5.3 | Resource exhaustion: infinite canvas, memory balloon, fork bomb, disk fill | Hard CPU / memory / disk / wall-time caps, enforced by the runtime not the harness; a killed run is `INCONCLUSIVE`, never `SHIP` |
| 5.4 | Cross-run contamination through a reused profile | Fresh profile per run; profiles within one job run sequentially; cleanup verified after each |
| 5.5 | A lost worker silently producing a green result | Policy: harness loss is `INCONCLUSIVE`/`HOLD`. Already the rule in `src/gate/release-gate.js` rules 1 and 5 |

## Required design, restated as gates

An untrusted target may be run only when all of the following are true and each
has an adversarial test:

1. The worker runs in its own network namespace with a **default-deny** egress
   policy, and the per-target allowlist is installed as firewall rules on
   resolved addresses — not as a URL check.
2. The allowlist is derived from the target contract's `allowedOrigins`, which
   already exist and are already validated as origins without wildcards.
3. The worker holds no credentials of any kind, and no metadata endpoint is
   routable from its namespace regardless of allowlist contents.
4. Browser profiles are ephemeral, one per run, and cleanup is verified.
5. CPU, memory, disk, wall-time and artifact-count ceilings are enforced by the
   runtime; exceeding one produces `INCONCLUSIVE`.
6. Every redirect hop and every recorded subresource destination is captured in
   the trace so a violation is visible after the fact, not only prevented.
7. The adversarial suite covers rows 1.1–1.13, 2.1–2.3, 3.1–3.2 and a
   representative case from each of 4.1–4.9, and runs in CI.

The prototype has not completed gates 1 through 7. It exercises one synthetic
HTTPS origin, worker DNS failure, direct-socket failures to sampled public and
private destinations, and an unlisted CONNECT refusal. It does not test all
redirect/subresource/alternate-egress cases, the full destination list,
resource-exhaustion handling, cancellation, artifact cleanup, or CI execution.
Until 1 through 7 exist with passing tests, the operating rule is the one in
`docs/handoffs/phase-1.md`: run only targets the operator has permission to run.

## What the shipped preflight is honestly for

It refuses the obvious and the accidental: a typo that points a run at
`localhost`, a staging hostname that quietly resolves into the corporate VPN, a
copy-pasted metadata URL, a contract whose `allowedOrigins` does not include the
CDN it actually needs. Those are real, and they are the failures an operator
running their own targets will actually hit. It is not, and is not claimed to be,
a control that would stop someone who wants to get in.
