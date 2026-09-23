# AGENTS.md

Single entry point: `node bin/atlas.js`. Zero dependencies by design (ADR-0002: hand-rolled CLI args, CDP over hand-written WebSocket) — do not add any. ESM (`"type": "module"`), Node ≥ 18.17, no install/build step, no lint. CI (`.github/workflows/ci.yml`) runs unit suites only — no network, browser, or key.

## First commands

- `node bin/atlas.js doctor` — start here. Launches a real browser (not just path detection) plus manifest/asset/engine checks. Exits 1 if `atlas all` would fail.
- `node bin/atlas.js all` — full pipeline: matrix → replay (baseline + adaptive `low-cpu-3g`) → gate → compare → `artifacts/report.html`. Exits 1 on HOLD.
- `node bin/atlas.js <cmd> --help` — per-command flags. `--seed` accepts hex (`0x…`).
- `node bin/atlas.js judge --dir <traces>` — batch-judge captured traces (rules always; +Jev when configured). Always exits 0.
- `node bin/atlas.js jev-check` — the one command requiring `TYPESAFE_API_KEY`; validates key + one live smoke call.
- `node bin/atlas.js preflight --url <https://…>` — static weight assessment, no browser. Private hosts refused unless `ATLAS_PREFLIGHT_ALLOW_PRIVATE=1`. Always exits 0.
- `node bin/atlas.js matrix --url <https://…>` — run the matrix against a third-party page (generic probe + generic manifest), not Orbital.

## Tests

- `npm test` = `node --test tests/`. No network, no browser, no key.
- Focused: `node --test tests/<name>.test.js` (`manifest`, `decision`, `gate`, `trace`, `image`, `ws`, `generic`, `judge`, `preflight`, `jev-transport`).
- `decision.test.js` builds fixtures in memory — never requires running `atlas fixtures` first.
## Browser runs (matrix / replay / serve)

- Requires installed Chrome or Edge; override with `ATLAS_CHROME=<exe path>`. Debug visibly with `ATLAS_HEADFUL=1`.
- Profiles in `src/runner/profiles.js` run **sequentially, never parallel** (CPU throttling is whole-browser). Subset: `atlas matrix --profile low-cpu-3g` (repeatable, comma-separated).
- `atlas assets` regenerates deterministic tier assets after editing manifest sizes; matrix also does this on demand. `experience/assets/generated/` and `artifacts/` are gitignored (except `artifacts/.gitkeep`) — never commit outputs.

## Exit codes are meaningful

- `gate`, `all`: 1 on HOLD. `replay`: 1 if not reproduced. `compare`: always 0 (disagreement is a finding).
- `matrix` exits 0 even when runs fail verdicts; only a harness-lost run (missing trace) exits 1.
- `judge`, `preflight`: always 0 — they observe/predict, `gate` decides.
## Decision layer

- `src/decision/index.js:selectEngine` is the only selection point. Default is `RuleBasedDecisionEngine` (no network). `TYPESAFE_API_KEY` → live `JevDecisionEngine` (`POST /v1/systemone`, default model `jev-latest`; pin via `TYPESAFE_MODEL`); `ATLAS_JEV_FIXTURES=1` → illustrative hand-authored fixtures. Absence never fails a command (except `jev-check`).
- Jev always runs inside `GuardedDecisionEngine`: overrides on error → infeasibility → low confidence, and **fail-closed (may tighten a verdict, never loosen)**. Floors: tier 0.55 / verdict 0.6 (`ATLAS_TIER_CONFIDENCE_FLOOR`, `ATLAS_VERDICT_CONFIDENCE_FLOOR`).
- Third interface method: `preflightAssess` (static weight → tier/blowBudget/transferFits). Guard fails closed on tier richness via `tierRank`. Score questions send `criteria` as an **array** (the API 422s an object); score answers read via `readScoreDistribution` (live probabilities are legend-indexed).
- Manifest selection is by recorded trace id: `src/manifest/select.js:manifestFor` (judge + gate share it — never score against Orbital's `checkout-complete` invariant for generic traces).
- Fixture keys are sha256 over the exact request — rebuild with `node bin/atlas.js fixtures`, never hand-edit `src/decision/fixtures/jev-responses.json`. Fixtures are `ILLUSTRATIVE`, not captured model output; never claim they measure Jev.

## Hard constraints (failing tests, not prose)

- Manifest is the contract: `src/manifest/atlas-orbital.manifest.js` + `src/manifest/validate.js`, content-hashed into every trace. Validate after edits via `doctor` or `manifest.test.js`.
- Gate rule 8 (`SCORE_FLOOR = 50` in `release-gate.js`): a critical profile under the floor blocks. Loads each run's trace; unreadable trace = silent skip (rule 1 owns that absence).
- Privacy boundary (`PRIVACY.md`, enforced by `validate.js` + `tests/manifest.test.js`): never add raw camera frames, raw audio, wall-clock timestamps in the event stream (`tOffsetMs` only), input coordinates (latency + `tap:class` only), free-text trace fields, UA/IP/device ids, or fingerprints. Capability consumers only see `normalizeSnapshot` output (`src/capability/buckets.js`).
- Determinism (ADR-0004): seeded RNG + quantised offsets; never fake the clock.
- No Flam integration of any kind (ADR-0001): no branding, SDK, API, or endpoint references anywhere.
- Types: `jsconfig.json` is `checkJs`+`strict`; keep JSDoc `@typedef`s against `types/atlas.d.ts` accurate. There is no typecheck/lint script — rely on `npm test` + `doctor`.
