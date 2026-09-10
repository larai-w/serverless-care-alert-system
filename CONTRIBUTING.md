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
npm install
npm test          # node --test tests/*.test.mjs
```

The tests need **Node 20 or newer** (they use the built-in test runner) and
**no AWS or Twilio account**. Credentials are stubbed with dummy values, so
`callNurse` fails on purpose; the tests check what the handler *decides*, not
whether a call goes through. **Nothing in the test suite places a real call or
sends a real LINE message.**

To try a change by hand, write a small event and pass it to the handler the way
`tests/call-status.test.mjs` does. Do not point it at real phone numbers.

## Required checks before commit

```bash
node --check index.mjs
python3 scripts/check_public_repo.py --staged
```

Run the full test suite (`npm test`). It is fast and needs no credentials.

## Submitting changes

1. Include a short problem statement and expected result.
2. Describe verification commands and results.
3. Keep docs aligned with README when behavior changes.

## License

Contributions are accepted under this repository's existing license.
