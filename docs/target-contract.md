# Owned staging target contract (v1)

The `matrix --target` lane runs a customer-declared journey against an owned staging URL. `matrix --url` remains a generic observer and makes no customer outcome claim. The target lane is local CLI software; it is not a hosted security boundary.

Start from [`examples/target-contract.json`](../examples/target-contract.json), then set the staging URL and selectors for your app. The contract requires an explicit local authorization attestation and exact allowed top-level origins. That attestation is not independently verified. Configure every app, API, redirect and CDN origin your journey needs. A top-level redirect outside this set fails closed. This first version does not block or fully enforce subresource egress; do not run it against untrusted targets.

Journey actions are selector based: `waitForVisible`, `waitForHidden`, `click`, and `fill`. `budgets.stepTimeoutMs` and `budgets.journeyTimeoutMs` bound the run. A fill reads its value from an `ATLAS_*` environment variable. Values are sent to the page but never written to Atlas reports or traces. Click uses CDP pointer/touch input in Chromium emulation; it does not establish physical input fidelity. Missing selectors, missing credentials, a missing success condition, or a top-level redirect outside the allowed origins fails the declared journey. A configured fallback is required only on named profiles, and every fallback profile must also be critical so missing fallback evidence cannot ship.

Page camera/microphone access is denied unless `mediaConsent` is explicitly true; this does not enable raw media artifact capture. Screenshots are disabled unless `screenshots.consent` is true. Enabling capture requires at least one redaction selector. Atlas measures each matching element's box, then paints an opaque black rectangle with 12 CSS pixels of padding into the PNG without changing the page layout. Missing or unmeasurable selectors withhold the screenshot. Selectors must cover the full sensitive area; overflowing content, pseudo-elements, cross-origin frames, later layout shifts, or unselected values can remain visible. Inspect screenshots before sharing. Query strings and fragments are refused in contract target URLs to prevent common token leaks. Target page error details are withheld from artifacts; counts and generic categories remain visible.

The report's target policy is versioned and evaluates every `criticalProfiles` journey plus the Atlas score floor. Failed evidence produces `HOLD`; missing evidence produces `INCONCLUSIVE`; only complete passing evidence produces `SHIP`. Set `target.buildId` to the commit or deployment id to identify the app build. `ATLAS_BUILD_ID` or `GITHUB_SHA` identifies the Atlas runner when supplied. Separate reports can then show which identifier changed; this first version does not automatically diff two target reports. The allowed-origin check covers top-level document navigations only. This local runner does not constrain browser subresource egress. These verdicts cover the declared journey in Chromium emulation. They do not prove conversion, a real device, Safari/iOS, radio, physical camera, GPU or thermal behavior. The selector journey is repeatable from the contract but is not a captured user-input replay.

Run:

```powershell
$env:ATLAS_TEST_USER = "staging-test-user"
$env:ATLAS_TEST_PASSWORD = "provided-out-of-band"
node bin/atlas.js matrix --target examples/target-contract.json
```

For the included controlled fixture, start `node examples/start-staging-scene.js`, then run the example contract with `node bin/atlas.js matrix --target examples/target-contract.json`. The fixture is a local demonstration of the contract engine, not evidence from an unaffiliated customer's app. For a real team, replace its URL and selectors and set `authorization.authorized` only when you have permission to test that staging system.
