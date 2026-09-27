# ADR-0007: Phase 2 control plane wraps the local engine

Status: accepted for the initial local control-plane slice (2026-09-27).

## Context

Atlas currently has a zero-dependency Node CLI with a versioned target
contract, trace schema, and deterministic release gate. A hosted product needs
accounts, tenant-scoped records, a durable queue, artifact storage, browser
workers, and a web interface. Putting server dependencies into the CLI would
break offline use and the existing no-dependencies design.

## Decision

- Put Fastify and the PostgreSQL client in `apps/control-plane`, not the root
  CLI package. The local CLI remains usable without a signup, network, or
  dependency install.
- Keep the current target contract validator as the contract authority. The
  control plane snapshots contract version and contents into each run record.
- Use PostgreSQL for organizations, memberships, projects, targets, sessions,
  run state, artifact metadata, share-link metadata, and audit events.
- Create a private, same-origin web interface and JSON API. The initial account
  owner is the first organization owner. Session bearer tokens are random,
  stored only as SHA-256 hashes, and sent in HttpOnly SameSite=Strict cookies.
- Require a DNS TXT ownership challenge for target onboarding and accept only
  HTTPS URLs with public DNS answers. This is onboarding validation only; it
  does not secure browser navigation or page subresources against rebinding.
- Record a requested run in the durable queue. Do not claim it ran and do not
  return a green verdict. Browser execution stays disabled until an isolated
  worker network policy is implemented and exercised.
- The initial local database uses a loopback-only Docker Compose service. No
  cloud accounts, paid services, or external identity provider are created.

## Consequences and deferred gates

This is a control-plane foundation, not a hosted launch. It does not yet have
an isolated Chrome worker, S3-compatible object store, client share links,
queued-job cancellation/retry/leases, request quotas, distributed rate limits,
retention deletion, backup deletion evidence, MFA, an account recovery flow,
or an end-to-end tenant isolation test against PostgreSQL. The initial
ownership DNS check cannot stop rebinding after registration. Never expose the
API to the public internet or attach a worker until those gates are closed.

The initial login uses Node scrypt and application-managed sessions to keep
the local slice operable without an identity provider. Before public hosting,
review this choice with a security threat model and consider a managed OIDC
provider; no external account has been created or selected.
