# Architecture Decision Records

Six decisions that shaped this repository, in the order they were made. Each one
records what was actually chosen, what it cost, and what would have to change for
the decision to be revisited.

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-original-experience-no-flam-integration.md) | The demo is an original experience with no Flam branding, assets, SDK or integration | Accepted |
| [0002](0002-zero-dependencies-cdp-over-raw-websocket.md) | No runtime dependencies; drive Chrome directly over CDP | Accepted |
| [0003](0003-manifest-as-contract.md) | The quality ladder is declarative data, validated, and content-hashed | Accepted |
| [0004](0004-determinism-model.md) | Determinism comes from a seeded RNG and quantised offsets, not a faked clock | Accepted |
| [0005](0005-decision-engine-interface.md) | The decision layer is an interface; the rule engine is the default and a guard has the last word | Accepted |
| [0006](0006-jev-typed-answers-only.md) | Jev answers in a fixed vocabulary; there is no rationale string | Accepted |

These are decision records, not documentation. Where they disagree with the code,
the code is right and the record is stale — say so in a pull request rather than
quietly editing history.
