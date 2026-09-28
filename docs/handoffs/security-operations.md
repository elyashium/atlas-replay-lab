# Handoff: security, privacy, and operations

**Status: local foundations exist; hosted security and compliance readiness are
not established.** Do not state SOC 2, GDPR, or other certification/compliance
status. Build and test controls, obtain qualified legal/compliance review, and
only make claims supported by the required independent assessment.

## Current state to preserve

- Root CLI remains offline-capable and zero-dependency. Control-plane
  dependencies stay under `apps/control-plane` (ADR-0002 and ADR-0007).
- The local API uses hashed opaque session tokens, HttpOnly SameSite=Strict
  cookies, same-origin JSON writes, restrictive browser headers, org-scoped
  queries, HTTPS target onboarding, a one-time public-DNS check, and a TXT
  ownership challenge. These controls do not make an arbitrary browser worker
  safe against SSRF, redirects, rebinding, subresources, or metadata services.
- Local Postgres retains queued run rows for 30 days and runs hourly metadata
  purge for expired sessions/share links/non-running runs. The integration test
  exercised expired run/artifact metadata row deletion. No object store,
  backups, or shared report content is connected to deletion. Declared
  retention is not complete retention enforcement until every copy is proven
  deleted.
- Screenshot consent is explicit in the guided target contract and defaults
  off; selectors are best-effort redaction, not a guarantee. Raw camera/audio
  artifacts are prohibited by the repo privacy boundary.
- DNS TXT verifies control of a hostname at a point in time; it is not a safe
  egress policy. No hosted browser worker is enabled.

## Hosted launch control backlog

1. Threat model data and actors: tenants, operator, API, queue, worker, browser
   page, third-party scripts, object store, support, backup provider, optional
   Jev/model provider, CI/GitHub. Mark trust boundaries and abuse cases.
2. Implement and adversarially test destination enforcement at connection time
   for DNS rebinding, redirect chains, browser subresources, IPv4/IPv6,
   loopback/private/link-local/multicast/reserved/metadata ranges, alternate
   numeric host forms, DNS errors, proxying, WebSockets and downloads. Pair this
   with an isolated worker network namespace and explicit per-target egress
   allowlist; URL preflight alone is insufficient.
3. Bound requests, uploads and jobs: content magic/type, compressed and
   decompressed bytes, GLB structure/polygon/resource ceilings, rate limits,
   tenant quotas, wall time, CPU, memory, disk, artifact counts and queue
   concurrency. Untrusted browser jobs run sequential profiles in ephemeral
   isolated state, with no cross-tenant cookies/secrets.
4. Credential handling: scoped short-lived secrets, encryption, redaction in
   logs/artifacts, no URL tokens, least privilege, rotation and audit. Default
   Jev/model egress off; separately disclose/consent if enabled.
5. Artifact safety: private object store, tenant ownership, immutable hashes,
   scoped expiring reads, malware/decoder boundary, screenshot review,
   revocable share links, access logs, deletion across versions and backups,
   and tested restore/deletion procedures.
6. Identity/operator controls: verify email or use reviewed identity provider,
   recovery, MFA for operators, least privilege, access reviews, deployment
   logging, dependency/secret scanning, vulnerability handling, key rotation,
   incident response, backup/restore, vendor/subprocessor and data-flow
   inventory.
7. Retention: state a data-class-specific retention period; implement scheduled
   purge, prove object/version/backup/link deletion, keep minimal deletion
   audit records, and test late jobs/retries cannot recreate expired data.
8. Review privacy terms, consent flows, jurisdiction/region, data processing,
   breach obligations and customer commitments with qualified counsel before
   launch. Select hosting region deliberately; no legal claim from code alone.

## Required evidence before public hosted use

- Threat model and abuse-case tests linked to the actual worker network policy.
- Unsafe URLs/subresources and malicious uploads fail closed; no DNS TOCTOU
  gap can route a job to private/metadata space.
- Second tenant cannot access another tenant's projects, runs, metadata,
  artifacts, shares, logs, or API responses (including guessed IDs).
- Resource ceilings, cancellation, worker loss, retry, queue saturation,
  quotas/rate limits, and fail-closed verdict behavior tested.
- Retention is demonstrated end to end for DB, object versions, shares, backups,
  exports, and generated reports; restore test documented.
- Consent, screenshot redaction/review, audit, incident, key rotation, and
  account/operator procedures are exercised, not only documented.
- No production-readiness, SOC 2, GDPR, SLA, DPA, or residency claim without
  appropriate review and substantiation.

## Stop conditions and approval boundaries

Keep the current app local and workers disabled until above gates pass. The user
must approve external accounts, cloud region/provider, paid services, spending,
retention/business commitments, third-party data egress, and any live customer
data use. Never send messages or customer outreach without explicit
authorization. If a user request conflicts with repo safety rules, identify
the exact rule and offer a safe local path instead of silently bypassing it.
