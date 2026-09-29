# GitHub target QA Check Run (preview)

Atlas provides a reusable composite action at
`.github/actions/atlas-target-qa`. It runs the real Atlas `matrix --target`
engine on the GitHub runner against the declared owned staging URL, applies
the target release gate to that matrix, and creates a GitHub Check Run attached
to the workflow's `GITHUB_SHA`. It does not call the hosted control plane or
turn unit-test success into target evidence.

This is a preview integration. No live GitHub repository or external staging
site has been exercised by this repository. The action runner itself is not an
isolated target worker: it can reach networks permitted to the runner, and the
current target browser lane only enforces top-level allowed-origin navigation.
Use only a staging host you own or are authorized to test. Do not use
`pull_request_target` to execute untrusted pull-request code. For repositories
accepting forks, the standard fork token is read-only, so Check Run creation
fails closed; do not grant write tokens to untrusted workflows to work around
that limitation.

## Workflow example

Deploy the exact PR build first, then pass the immutable SHA reported by that
deployment. The contract file should use that preview's HTTPS URL, list its
exact origin in `target.allowedOrigins`, include the declared user journey and
policy, and set `authorization.authorized` only when your team has permission
to test it.

```yaml
name: Atlas staging QA

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  checks: write

concurrency:
  group: atlas-target-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  target-qa:
    needs: deploy # An existing deployment job must expose this exact deployed build SHA.
    # Keep this on trusted PRs only; it runs a browser against the staging URL.
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Run Atlas target check
        id: atlas
        uses: elyashium/atlas-replay-lab/.github/actions/atlas-target-qa@<FULL_ATLAS_COMMIT_SHA>
        with:
          contract-path: .atlas/target-contract.json
          target-build-id: ${{ needs.deploy.outputs.target-build-id }}
          github-token: ${{ github.token }}
          mode: advisory
        env:
          ATLAS_TEST_USER: ${{ secrets.ATLAS_TEST_USER }}
          ATLAS_TEST_PASSWORD: ${{ secrets.ATLAS_TEST_PASSWORD }}

      # Optional. Review screenshot consent and the generated evidence first.
      # If you choose to upload, set retention-days to your approved minimum.
      - name: Archive reviewed Atlas evidence
        if: always() && steps.atlas.outputs.artifact-dir != ''
        uses: actions/upload-artifact@v4
        with:
          name: atlas-target-qa-${{ github.run_id }}
          path: ${{ steps.atlas.outputs.artifact-dir }}
          retention-days: 1
```

Replace the action placeholder with a full immutable Atlas commit SHA. Pin
other Actions to reviewed full commit SHAs according to your repository supply
chain policy. The sample assumes a `deploy` job with an output named
`target-build-id`; adapt the dependency to your staging deployment. The target
contract is required to agree with the tested build ID. GitHub-hosted Ubuntu
24.04 currently includes Google Chrome, but runner images change; set
`ATLAS_CHROME` if your runner needs a different binary.

## Verdict and branch policy

- `SHIP` completes the Check Run as `success`.
- `HOLD` completes as `neutral` in `advisory` mode and `failure` in `blocking`
  mode.
- `INCONCLUSIVE`, missing reports, or a matrix harness error always complete
  as `failure`, including advisory mode.

Advisory mode is the default. GitHub treats a `neutral` conclusion as
satisfactory for a required check, so do not add the advisory Atlas check to a
branch protection/ruleset requirement. Set `mode: blocking` only after the team
has reviewed the target contract and policy, and has elected to gate merges.
Atlas does not change branch protection settings. Each rerun creates a new
Check Run, preserving earlier verdicts. The report bundle remains on the
runner unless a workflow separately uploads it; screenshots are sensitive and
may be uploaded only under your team's consent and retention decision.

The action requires Node.js 20+, a Chrome-compatible browser, `checks: write`
for the workflow token, and a full immutable target build SHA. It sends only
check metadata to the GitHub Checks API. Atlas test credentials stay in the
runner environment and are not sent to GitHub by the action. A test run still
measures Chromium emulation and the contract's declared journey; it is not
Safari/iOS or physical device evidence.

See [Phase 3 handoff](handoffs/phase-3.md) for remaining validation and
production requirements.
