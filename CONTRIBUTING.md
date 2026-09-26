# Contributing to EchoCare (serverless-care-alert-system)

Thank you for helping improve EchoCare. Start by reading `README.md` and `AGENTS.md` first.

## Public-repo boundary (required)

- Do not commit credentials, phone numbers, personal data, facility-identifying information, raw logs, internal strategy, or pilot data.
- This repository is a public research prototype; do not make guaranteed emergency or clinical outcome claims in contributions.

## Before you start

- Keep changes scoped and reproducible.
- If your change touches call flow, clearly document risk and test scenario.
- Open an issue before larger behavior changes.

## Run it locally

There is no server to start — this is a single Lambda handler (`index.mjs`).
You exercise it by calling the handler from the tests.

```bash
npm ci
node --check index.mjs
```

The checked-in deployment workflow uses Node.js 20. See the
[README check guide](README.md#source-and-checks) for the existing test files and
an environment-clearing command to run them. Some tests exercise failure paths
by removing Twilio credentials; LINE settings can still be inherited by handler
imports. Do not assume all network clients are mocked or run with live credentials.

For a non-calling manual example, use the README's `LaunchRequest`. Calling
`CallNurseIntent`, an authenticated button event, or a retry callback can cause a
real call when runtime credentials are present. Live phone/LINE tests require
explicit authorization.

## Required checks before commit

```bash
node --check index.mjs
python3 scripts/check_public_repo.py --staged
```

For behavior changes, run the relevant suite in the isolated environment described above and report exactly what was checked. Documentation-only work should not be represented as a successful call-path test.

## Submitting changes

Every push to `main` triggers a production Lambda code update, even for documentation.
Use a review branch; PR creation and production merge are separate decisions.

1. Include a short problem statement and expected result.
2. Describe verification commands and results.
3. Keep docs aligned with README when behavior changes.

## License

Contributions are accepted under this repository's existing license.
