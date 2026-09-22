# Atlas Upload — showcase roadmap (URL → rating → upload)

Goal: a showcase visitor brings **their own** AR/VR web experience and leaves
with a degrade report, a replayable failure, and a single rating. No rewrite:
the matrix / trace / replay / gate / judge stays as-is; each slice adds one
ingestion path and the invariants needed to rate it.

Status: plan only. Slices build in order; each is independently demoable.

## Constraints carried in (non-negotiable)

- Zero dependencies (ADR-0002), ESM, Node ≥ 18.17. No npm packages — the XR
  session stub is our own injected script via the existing CDP `inject.js`
  path, not IWER/playwright-webxr (good tools, wrong dependency posture).
- Privacy boundary unchanged: no camera frames/audio ever, `tOffsetMs` only,
  summaries—not event streams—leave the box, Jev egress opt-in per PRIVACY.md.
- Honesty posture unchanged: emulation is labeled emulation (Chromium CDP +
  injected XR stub, no real GPU drivers, no handsets, no HMDs); vendor numbers
  stay attributed; live Jev numbers ship with sample sizes. Real-device
  connector stays explicit Stage 3, never implied.
- Jev weaknesses respected (per TypeSafe's own docs): no counting, no
  arithmetic on money/quantities/dates in questions. Frame counts, p95s, and
  budget comparisons stay in code; Jev gets semantic judgments + confidence.

## Slice 1 — Point at any URL

`atlas matrix --url <https://…>` runs the six-profile matrix against a
deployed third-party WebXR/WebGL app instead of Orbital.

- Generic probe (new `experience/probe-generic.js`, injected the same way as
  `capability-probe.js`): rAF frame-time series, XR `sessionstart`/`end` /
  `error` events, console errors, WebGL context loss, first-non-blank-canvas
  timestamp via pixel sampling, declared fallback detection (does the page
  render *something* usable when `navigator.xr` is absent?).
- Generic driver (`src/runner/drive-generic.js`): load → wait-for-settle →
  scripted look-around (mouse drag / touch swipe) → attempt XR session button
  if present → screenshots at checkpoints. No app-specific states; the trace
  records the generic spine (load/interact/session-attempt/checkout-if-found).
- Trace schema: additive optional fields (`frameTimes`, `xrSessionEvents`,
  `consoleErrors`) — old traces still validate; `summariseTraceForJev`
  compresses frame series to histogram buckets (never ships raw series).
- Matrix profiles gain two XR-flavored variants (8 total): `xr-granted`
  (session supported, permission granted) and `xr-denied` (session requested,
  permission refused) — same CDP mechanics as `camera-denied`.
- Accept: paste an 8th Wall / PlayCanvas / three.js URL, get a full report
  with zero per-app code. Failure story: the *visitor's* app on `low-cpu-3g`.

## Slice 2 — Rate it

One number plus the evidence behind it.

- Comfort invariants (manifest, additive): sustained-fps floor (e.g. p5 frame
  time over a 5s window — motion-sickness proxy), XR-session-fail fallback
  (refused/unavailable session must still leave a usable 2D/static page),
  input-to-photon responsiveness budget. All computed in code from the trace.
- Atlas score 0–100 (composite-scoring pattern): weighted sum of
  visual / interaction / business / comfort sub-scores, weights in
  `src/gate/atlas-score.js` as versioned constants, raw dimensions preserved
  in the report (never just the number — cf. Bloss0m's "don't keep only 0.82").
- Judge fan-out (same single call, ~10 questions): add `comfortRisk` (Score),
  `accessibleFallback` (Noul: usable without XR/controllers?), and per-known-
  incident `matchesIncident<i>` (Noul × k open incidents — failure memory;
  capped by the 255-option/32k-token budget, oldest incidents retire first).
- Pre-flight risk (the showcase magic): `atlas preflight --url` fetches
  headers + asset manifest only (no browser), sends byte counts / texture
  sizes / script weight as state, asks `blowBudget` (Score) + `tier` (Choice).
  Predicts the failure *before* the matrix runs; the matrix then confirms or
  refutes — both outcomes are interesting on stage.
- Report: "what your users feel" section — p95 frame time → comfort label via
  a Score question, plain-language fallback verdict, before/after tier panels.
- Accept: two different visitor URLs get different scores with legible,
  disputable reasons; preflight prediction matches matrix outcome ≥ direction.

## Slice 3 — Upload a `.glb`

For visitors without a deployed URL.

- Viewer harness (`experience/viewer/`): standard three.js-free WebGL viewer
  (our own minimal renderer, consistent with zero-deps) with an owned degrade
  ladder — pixel ratio → shadow map → poly/LOD → lighting → static poster.
  Upload = file drop → content-hash → served locally → matrix runs against it.
- XR session stub (`src/runner/xr-stub.js`, injected pre-load): fake
  `navigator.xr` supporting `immersive-vr` request/end + synthetic head-pose
  sequence (scripted look path, seeded) so session lifecycle, pose-driven
  rendering, and session-fail fallback are all exercisable without a headset.
  Pose scripts are seeded and stored in the trace → replay re-applies them.
- Upload moderation: schema/type validation in code; Jev pre-flight judges
  semantic risk from asset stats (poly count, texture bytes, node count).
  Never executes upload content outside the sandboxed page context.
- Accept: drag → degrade → replay → score in under 5 minutes on stage.

## Showcase demo (90 seconds, Slice 1+2)

1. Paste URL (visitor's or a planted heavy three.js scene). Preflight scores
   it risky in one call (~1s, ~$0.0001).
2. Matrix runs the failure profile live; report shows the exact tier where it
   breaks + comfort label.
3. Replay the divergence; flip to the adapted tier; re-run to green.
4. Atlas score before/after + per-trace cost line ("this whole triage cost
   a fifth of a cent").

## Cost/latency envelope (measured 2026-09-22, jev-1.13.0)

| Stage | Calls | Measured |
|---|---|---|
| preflight | 1 | ~1.3s, ~300 tokens, ~$0.00001 |
| compare (12 pkt + 10 traces) | 22 | mean ~490ms, ~$0.0023 total |
| judge (10 traces) | 10 | mean ~514ms, ~$0.00015/trace |

Fan-out keeps Slice 2 at the same call count as today (questions ride free;
only state+question tokens bill). Full showcase run stays under a cent.

## Explicit non-goals

- Real-device/HMD lab (Stage 3; needs hardware + ADB + a venue rig).
- Native (non-web) AR/VR uploads — browser-runnable only.
- Auto-fixing visitor code — we locate + prove, humans fix.
- Any claim beyond what's measured: emulation labeled, n=small caveats kept.
