# EchoCare — Agent Rules

EchoCare is a public research-prototype repository. It triggers real outbound calls when connected to production Twilio credentials and is not a clinical or emergency system.

## Public repository boundary

- Never commit credentials, phone numbers, Alexa user data, raw logs, personal or facility-identifying information, internal strategy, pricing, pilot data, handoffs, or unpublished drafts.
- Keep deployment credentials in GitHub Actions secrets or encrypted runtime environment variables. Never place them in code, examples, Issues, PRs, commits, or workflow logs.
- Before committing, run `python3 scripts/check_public_repo.py --staged`. Never bypass hooks with `--no-verify`.
- Stage only intended files; never use `git add -A`.

## Safety and validation

- Keep the README limitation explicit: this is a research prototype, not a verified safety system.
- Do not make diagnosis, treatment, prevention, emergency-response, delivery-guarantee, or reliability claims.
- `npm test` is currently a failing placeholder. At minimum, run `node --check index.mjs` and `npm ci` for dependency integrity.
- Local `CallNurseIntent` tests can create a real phone call. Use mocks or Twilio test credentials unless the owner explicitly authorizes a live call.

## Deployment gate

Pushing to `main` runs the production Lambda deployment workflow. Treat `git push origin main` as an external production action: summarize the diff and obtain owner confirmation immediately before pushing.
