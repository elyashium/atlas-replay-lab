# ADR-0001 — The demo is an original experience, with no Flam integration

**Status:** Accepted
**Date:** 2026-01
**Supersedes:** nothing

## Context

This repository exists as proof-of-work aimed at a specific problem domain:
shipping a camera-composited interactive layer to an uncontrolled fleet of phones
and having some principled way to know whether it worked. That domain is one that
Flam operates in, and the temptation when building proof-of-work for a company is
to make the artifact *look like* their product — their brand, their naming, a
mocked version of their SDK surface.

That temptation is worth naming because giving in to it produces an artifact that
is worse on every axis that matters:

- It implies an integration that does not exist. A reader cannot tell from the
  outside whether `flam.initScene()` in a demo is a real call, a mock, or a guess
  at an API the author never had access to. Every subsequent claim inherits that
  ambiguity.
- It invites a trademark and brand-use problem for a thing that is, in the end,
  an unsolicited portfolio piece.
- It makes the engineering harder to evaluate. If the interesting part is the
  tier router, the trace recorder and the replay check, then borrowed branding is
  noise around the signal.

## Decision

The demo experience is **"Orbital"** — an original, synthetic product layer, with
generated assets, invented entirely for this repository.

Concretely:

1. **No Flam branding, logos, copy, or visual identity** appears anywhere in the
   repo, the rendered experience, the reports, or the docs.
2. **No Flam SDK, API, endpoint or data format is used, mocked, stubbed, or
   named** as if it were being called. There is no `flam` module, no
   `flamapp.com` request, no imitation of a Flam interface.
3. **No claim of integration, partnership, endorsement, or evaluation** is made
   in any artifact this repo produces.
4. The README states this in its own section, in plain language, above the fold,
   rather than burying it in a licence file.
5. The manifest itself carries the statement, at the top of
   [`src/manifest/atlas-orbital.manifest.js`](../../src/manifest/atlas-orbital.manifest.js),
   so it survives the file being read in isolation.

What the repo *does* claim is narrower and checkable: it is a technique
demonstration for capability-aware delivery, adversarial device-matrix testing,
privacy-safe tracing, and deterministic replay, built against an original
experience with the same shape of problem.

## Consequences

**Good.** Every claim in the README is about this repository and is verifiable by
running it. There is no "is that real?" question hanging over any artifact. The
work can be shown to anyone, including people who have nothing to do with Flam,
without a caveat.

**Costly.** The demo experience had to be built from nothing — a WebGL scene, a
Canvas2D fallback, a static-safe path, and generated assets
([`scripts/generate-assets.js`](../../scripts/generate-assets.js)) — before any
of the interesting infrastructure could be tested against it. That is a
meaningful fraction of the total code, and none of it is the point.

**Unresolved.** "Orbital" is deliberately generic. It is a product layer with a
detail panel, a cart, and a mock checkout, because the *business invariant*
(§0003) needs a business outcome to be an invariant about. A real integration
would have a real end state, and the manifest is where that would change.

## Alternatives considered

**Rebuild a recognisable Flam-like experience.** Rejected for all of the reasons
above. The marginal persuasiveness is small and the ambiguity it introduces
contaminates every other claim.

**Use a neutral third-party demo scene** (a public glTF model, a known WebGL
sample). Rejected because a scene whose cost profile is fixed by someone else is
a bad substrate for a *quality ladder* — the whole exercise depends on being able
to dial particle count, texture size and per-frame work independently across
three tiers, which means the scene has to be parameterised by design.

**Ship the infrastructure with no demo at all**, as a library. Rejected because
the central claim — "the router downgrades, and replay proves the fix" — is only
demonstrable end to end if there is something to render and fail.
