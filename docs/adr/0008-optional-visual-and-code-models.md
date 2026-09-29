# ADR-0008: Optional visual review and code proposals are separate from release decisions

**Status: accepted for the local CLI experiment**  
**Date: 2026-09-29**

## Context

Teams need more than a three-way release verdict to inspect visual language and
component issues. Jev implements Atlas's existing typed classification
interface; it is not an image model or a source-code patch engine. Replacing it
or expanding its answer schema would couple optional design critique to the
deterministic release gate.

Images can contain private page content. Source files can contain credentials,
customer data, or proprietary implementation details. Multimodal and coding
providers can return plausible but incorrect claims. A model timeout, malformed
answer, absent image, or unsupported browser state must not become a pass.

## Decision

- Keep rules, target contracts, traces, and the release gate authoritative.
  Visual suggestions and patch proposals always carry `verdictEffect: none`.
- Add independent, opt-in Groq adapters for PNG visual review and single-file
  code proposals. Do not change the `atlas-core` dependency posture or the Jev
  interface.
- Require explicit per-invocation egress flags. Matrix screenshots also
  require target-contract screenshot consent. A user-supplied component image
  and reference must be inside local `artifacts/`; a reference and current image
  must have matching dimensions and a user-written criteria string.
- Send no image, reference, criteria, source file, or code finding to a model by
  default. Read keys only from process environment. Record requested/returned
  model IDs and evidence hashes; mock provider requests in automated tests.
- Validate image dimensions and model response shapes before rendering. Escape
  all model and user text in reports; treat image text and source comments as
  untrusted instructions.
- A code model may return one small diff for one supplied file. Atlas does not
  apply, execute, or test it. Human review and testing against the actual
  component remain required. A future sandbox/PR integration needs its own
  security review and an explicit permission workflow.
- Keep credentials, image data, findings, and diffs local in this experiment.
  Hosted model jobs, per-tenant secrets, artifact retention, and public access
  remain disabled until the Phase 2 hosted safety gates are implemented.

## Consequences

- The default local CLI remains offline and does not need a provider key.
- There are separate deterministic visual comparison, optional vision
  suggestions, and optional code patch proposal artifacts. These are not
  combined into a single score.
- Model accuracy, repeatability, latency, cost, and patch success are unknown
  until a consented evaluation corpus and real provider trial are run.
- The initial Qwen visual model is an implementation default and currently
  listed as a Groq preview model. Verify availability and lifecycle before any
  hosted or paid use.
- This ADR does not authorize production deployment, real customer source/image
  egress, live billing, or code modification in a customer repository.
