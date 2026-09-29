# Phase 3 evidence: local GitHub target-check action

## Implemented

`.github/actions/atlas-target-qa` is an opt-in composite GitHub Action. This
continuation hardened its existing implementation to read
an authorized target contract from the caller's checked-out repository, binds
the caller-supplied deployed commit SHA into that contract, invokes Atlas's
existing `matrix --target` and `gate` CLI commands, validates the resulting
gate's build binding and critical-profile evidence, then creates and completes
a GitHub Check Run on `GITHUB_SHA`.

The default mode is advisory: `SHIP` is success, `HOLD` is neutral, and
`INCONCLUSIVE` or a matrix harness error is failure. Blocking mode is explicit
and makes `HOLD` fail. The action itself does not upload evidence; it returns
the local artifact directory for a separate, explicitly opted-in workflow
upload. The Check Run links to the Actions workflow run, not a hosted/private
Atlas report.

## Verification performed

- `npm test`: **395/395 passed**. The five focused tests in
  `tests/github-target-check.test.js` cover fail-closed verdict mapping,
  advisory/blocking conclusions, build-SHA binding, Check Run API request
  shape, and harness failure handling with mocked GitHub/CLI dependencies.
- `npm test --prefix apps/control-plane` with local PostgreSQL: **35/35
  passed**. This action does not change control-plane runtime behavior.
- `node --check` on the Action runner, verdict helper, and Action tests; `git
  diff --check`: passed.
- No real GitHub Check Run was created, no external staging target was
  exercised, and no browser pipeline ran as part of this action change. The
  Check Runs API request was mocked in unit tests.

## Constraints and follow-up

- The action runner itself is not the Phase 2 isolated worker. Target pages can
  reach whatever the Actions runner network permits; current target navigation
  enforcement does not cover browser subresource egress. Use only authorized
  owned staging targets and do not treat this as a hosted arbitrary-URL service.
- The action expects `checks: write`. GitHub restricts write permissions for
  workflows triggered by fork pull requests unless repository settings grant
  them. The action fails closed if it cannot create/update the check; do not
  enable broad write-token access for untrusted pull-request code.
- GitHub considers `neutral` a successful conclusion for required checks. Keep
  advisory checks out of branch protection; choose `blocking` only after an
  owner explicitly approves that release policy.
- Pin the reusable action and other workflow actions to reviewed commit SHAs.
  No branch protection or repository settings were changed.
- A separate controlled PR must verify real `SHIP`, `HOLD`, `INCONCLUSIVE`,
  worker/browser outage, rerun history, and the deployed build identifier
  before calling this a validated release integration.

## Primary references

- [GitHub Actions workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)
- [GitHub protected branches and required checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub runner image software (Ubuntu 24.04)](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)
