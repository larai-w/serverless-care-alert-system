# Contributing to EchoCare (serverless-care-alert-system)

Thank you for helping improve EchoCare. Start by reading `README.md` and `AGENTS.md` first.

## Public-repo boundary (required)

- Do not commit credentials, phone numbers, personal data, facility-identifying information, raw logs, internal strategy, or pilot data.
- This repository is a public research prototype; do not make guaranteed emergency or clinical outcome claims in contributions.

## Before you start

- Keep changes scoped and reproducible.
- If your change touches call flow, clearly document risk and test scenario.
- Open an issue before larger behavior changes.

## Required checks before commit

```bash
node --check index.mjs
python3 scripts/check_public_repo.py --staged
```

Run any component tests you changed (`npm test` if applicable).

## Submitting changes

1. Include a short problem statement and expected result.
2. Describe verification commands and results.
3. Keep docs aligned with README when behavior changes.

## License

Contributions are accepted under this repository's existing license.
