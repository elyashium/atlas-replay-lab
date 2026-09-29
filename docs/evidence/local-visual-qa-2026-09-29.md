# Local visual QA slice — 2026-09-29

## Shipped

- `atlas visual-compare --baseline <png> --actual <png>` compares PNGs and
  records SHA-256 hashes, pixel difference ratio, coarse perceptual score,
  divergence bounds, thresholds, and a heatmap. Dimension mismatch is
  INCONCLUSIVE. This result does not affect the release gate.
- `atlas visual-review --image <png> --consent-to-send-images` accepts a
  user-provided component screenshot under `artifacts/`. Owned-staging matrix
  screenshots require the target contract's capture consent plus separate
  provider-egress consent. Component reviews may include a same-size reference
  and team criteria. A missing model location is retained as an unlocalized
  finding (`region: null`). Provider/schema failures remain inconclusive.
- The optional Groq vision adapter is bounded by PNG size/dimensions, timeout,
  response size and schema validation. It hashes evidence and labels outputs
  as model suggestions with `verdictEffect: none`. Jev and the deterministic
  release gate remain separate.
- `atlas suggest-code-fix --source <file> --consent-to-send-code` sends one
  source file from `artifacts/` and analyzed findings for a single-file diff
  proposal. It rejects credential-like content and oversized or unsafe input.
  It saves a proposal for human review; it does not apply the diff or run tests.
- HTML reports show deterministic comparison, vision suggestions and code
  proposals in separate sections. The report's matrix table scrolls on small
  screens, and report images fit the available width.
- ADR-0008 and `docs/visual-qa-platform.md` describe the model boundary and the
  next platform work. No root/core dependencies were added.

## Verification and measurement

Environment: Windows x64, Node 20.18.0, Chrome 154.0.8037.58.

- `npm test` — **388/388 passed** through the root dependency-free runner.
- `node bin/atlas.js doctor` — **passed**; manifest and assets valid, Chrome
  launched, CDP 1.3 connected. No external call was made by `doctor`.
- `node bin/atlas.js visual-review --help`, `visual-compare --help`, and
  `suggest-code-fix --help` — **passed**.
- `git diff --check` — **passed**.
- Synthetic screenshot comparison produced a 0.0303 pixel-difference ratio
  and 0.991202 coarse perceptual score against thresholds 0.02 and 0.98; it
  correctly reported a threshold failure. Desktop (1440px) and mobile (390px)
  report layouts were visually inspected; document width matched each
  viewport. These synthetic images are not customer evidence or a model
  benchmark.
- One authorized Groq smoke request used synthetic component/reference images
  and placeholder criteria only. The provider returned a response, but its
  issue omitted the requested region, so the pre-fix adapter recorded an
  inconclusive result (0/1 images analyzed). The validator now safely maps a
  missing region to `null`; no post-fix provider retry has been measured.
  Therefore live visual-review success, quality, localization, latency,
  repeatability and cost remain unverified.

## Limits and remaining work

- This is a local CLI slice, not a hosted service. It has no browser worker,
  organization/auth layer, job queue, object store, tenant isolation, SSRF-safe
  browser egress, retention enforcement, or share links.
- Code proposals are not sandboxed or automatically applied. No source upload
  UI, patch verification, PR integration, or test execution exists.
- The vision model's confidence is self-reported and uncalibrated. Pixel
  comparison has no dynamic-region masks, viewport normalization, DOM
  semantics, accessibility verdict, or objective design-quality score.
- Synthetic model fixtures and the one inconclusive live smoke do not establish
  visual-review accuracy or commercial demand.

## 2026-09-30 continuation: guarded diff validation

The code-proposal adapter now parses every unified-diff hunk rather than only
checking the first file headers. It rejects appended second-file headers,
unsupported trailing content, malformed/overlapping hunks, mismatched line
counts, and context/deleted lines that do not match the consented source. It
computes the proposed candidate's SHA-256 in memory while retaining neither
source nor candidate content in the result. `applied` and `testsRun` remain
false; this does not prove a change is behaviorally correct or apply-able in
every toolchain.

Verification: `node --test tests/groq-patch.test.js` passed **4/4**, including
multi-file/trailing-path, truncated-hunk and mismatched-source-context cases.
It also verifies multiple valid hunks produce a candidate hash. The full root
suite passed **398/398**; control-plane tests with local Postgres
17.11 passed **37/37**; `doctor` and `git diff --check` passed. All provider
calls were mocked. No source was sent to Groq and no proposal quality or patch
execution was measured.

The synthetic UI preview (`npm run preview:screenshots --prefix
apps/control-plane`, with local Postgres) passed at **1440 px** and **390 px**.
The code proposal view displayed the source and candidate hashes, said that
hunks matched supplied source, and clearly stated Atlas did not write, run, or
test the candidate. Both viewports had no horizontal overflow. I inspected the
generated desktop and mobile proposal screenshots. The preview injected a
synthetic proposal; it made no provider request and is not a model-result
measurement.

## Reproduce local checks

```powershell
node bin/atlas.js doctor
node bin/atlas.js visual-compare --baseline artifacts/components/baseline.png --actual artifacts/components/current.png
node bin/atlas.js report
$env:GROQ_API_KEY = "<key supplied by the operator>"
node bin/atlas.js visual-review --image artifacts/components/current.png --consent-to-send-images
node bin/atlas.js report
```

Inspect and redact images locally before provider egress. Keep keys out of the
repository and generated artifacts.
