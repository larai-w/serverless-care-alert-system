# EchoCare — voice and button alert research prototype

**An Alexa / HTTP webhook → AWS Lambda → Twilio calling prototype, with optional LINE notifications.**

[日本語](README.ja.md) · [Local setup](#local-setup) · [Source and checks](#source-and-checks) · [Product page](https://veai.jp/apps/echocare/)

This repository, `serverless-care-alert-system`, is also referred to as Nursecall. Its public product name is **EchoCare**. It explores initiating a phone call to one configured contact from a voice intent or a button webhook. The handler, spoken messages and notification text are implemented in [index.mjs](index.mjs).

**Research prototype. Not for clinical or emergency use, and not a verified safety system.** An accepted call request does not prove a phone rang, a person answered, or assistance was provided. There is no evaluated clinical prediction or trained ML model in this repository.

## Implemented scope

The following describes source behavior, not a live deployment certification:

| Path | What the code does | Boundary |
| --- | --- | --- |
| Alexa | Handles launch/help/stop/cancel and `CallNurseIntent` | Identity and Skill ID restrictions depend on external trigger configuration; the handler does not verify a Skill ID itself |
| Button webhook | Accepts an HTTP event with a shared secret and starts a call | Disabled when `BUTTON_SHARED_SECRET` is absent; one configured destination |
| Twilio call | Sends Japanese TwiML speech to `NURSE_PHONE_NUMBER` | Request acceptance is not delivery confirmation |
| Status callback | Routes `/twilio-status` separately and processes call status | Requires callback configuration and authentication; no durable call-state store |
| Retry | On `no-answer`, `busy`, `failed` or `canceled`, retries when the supplied attempt is below 2 | The attempt is carried in the callback URL; duplicate callbacks are not deduplicated |
| LINE notification | Reports initiation, connection status or failure when configured | Optional; HTTP success is not proof someone read the message |
| Logging | Redacts selected shared-secret fields from received-event logs | Not general anonymization of all event or error data |

Multi-recipient escalation, professional care-system integration, human acknowledgment, and a durable delivery ledger are not implemented.

## Architecture

```text
Alexa custom skill ---- CallNurseIntent ----+
                                          |
Button / HTTP client -- shared secret -----+--> Lambda: index.handler
                                               |         |
                                               |         `--> optional LINE push
                                               v
                                         Twilio Voice API
                                               |
                                               v
                                       One configured phone
                                               |
Twilio status callback --> /twilio-status ------+
                           auth + status decision
                           notify / retry / stop
```

The Lambda handles Alexa events and Function URL-style HTTP events. An HTTP event whose path is `/twilio-status` enters the callback handler; other HTTP paths enter the button handler. The code has no database, queue or infrastructure-as-code stack in this repository.

The phone message asks the recipient to open the Alexa app and use its communication feature. This code does not establish that follow-up conversation automatically.

### Call result semantics

| Result | Interpretation in this prototype |
| --- | --- |
| `calls.create()` resolves | Twilio accepted the request; Alexa reports initiation only |
| `completed` callback | The call connected and ended; voicemail or an automated menu may have answered |
| Missed status, attempt below 2 | Try another call and report the retry, or report failure to initiate it |
| Missed status, attempt at least 2 | Stop retrying for that callback and send an unanswered notice |
| Other status | No further action in the callback handler |

The intended chain has an initial call and one retry. This is **not a global two-call guarantee**: there is no persistent deduplication or replay protection, and repeated button requests or repeated first-attempt callbacks can initiate more calls.

## Local setup

Requirements: Git, npm and a Node.js version compatible with the project. The checked-in deployment workflow currently installs Node.js 20. Python 3 is used by the public-content guard.

```bash
git clone https://github.com/larai-w/serverless-care-alert-system.git
cd serverless-care-alert-system
npm ci
node --check index.mjs
```

There is no web server or frontend to start. `node --check` parses the module without invoking the handler or placing a call.

For a non-calling example, use an isolated shell and a `LaunchRequest`:

```bash
node --input-type=module -e '
  const { handler } = await import("./index.mjs");
  const result = await handler({ request: { type: "LaunchRequest" } });
  console.log(result.response.outputSpeech.text);
'
```

This branch returns Japanese introduction text and does not call Twilio or LINE. It does not validate Alexa integration. Do not replace it with `CallNurseIntent`, an authenticated button request, or a retry callback while live credentials are loaded.

## Configuration reference

All values are runtime configuration. Names below are safe to document; actual credentials, phone numbers and identifying text must remain outside this public repository.

| Variable | Role |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Twilio account used for calling |
| `TWILIO_AUTH_TOKEN` | Secret for Twilio API access and callback signature verification |
| `TWILIO_FROM_NUMBER` | Configured outbound Twilio number |
| `NURSE_PHONE_NUMBER` | One destination per deployment; not a hard-coded source value |
| `BUTTON_SHARED_SECRET` | Secret required by the button entry; also required for enabling status callbacks |
| `PUBLIC_CALLBACK_BASE` | Callback base URL when the incoming event has no host, notably the Alexa path |
| `REQUIRE_TWILIO_SIGNATURE` | `1` enforces Twilio signature validation; otherwise callbacks use the query secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | Optional secret for LINE notifications |
| `LINE_USER_ID` | Optional LINE destination; notifications need both LINE values |
| `PATIENT_NAME` | Optional identifying text inserted into messages; keep unset in shared examples |

The callback URL is attached only when a callback base and `BUTTON_SHARED_SECRET` are available. The base is derived from the HTTP host when present, otherwise from `PUBLIC_CALLBACK_BASE`. Call initiation can still succeed without callbacks, so it must not be confused with a working status path.

### Authentication and privacy details

- Button authentication accepts `x-button-secret` or a `secret` query parameter. Prefer headers for clients that support them; URL secrets can appear in external logs.
- Signature enforcement defaults to **off** unless `REQUIRE_TWILIO_SIGNATURE=1`. When enabled, the callback verifier uses the exact URL, raw query string and parsed form fields. This is source behavior, not a statement about the deployed setting.
- The code currently includes the shared secret in the generated callback URL even when signature enforcement is enabled. Turning on signature enforcement alone does not remove that URL exposure.
- The selected event-secret redaction is not a guarantee that phone numbers, identity fields or vendor error payloads are absent from all logs. Review logging and retention in a deployment separately.
- LINE is attempted after the call operation. Its request has a configured 3-second timeout and failures are handled separately; this is not an end-to-end delivery latency guarantee.

## Source and checks

`npm test` now maps to `node --test tests/*.test.mjs`; it is no longer a placeholder.

| Area | Existing checks |
| --- | --- |
| Button secret and Alexa routing | [webhook-auth.test.mjs](tests/webhook-auth.test.mjs) |
| Callback status and attempt parsing | [call-status.test.mjs](tests/call-status.test.mjs) |
| Optional signature enforcement | [twilio-signature.test.mjs](tests/twilio-signature.test.mjs) |
| Shared-secret redaction | [log-redaction.test.mjs](tests/log-redaction.test.mjs) |
| LINE ordering, messages and callback base | [line-notify.test.mjs](tests/line-notify.test.mjs) |
| Public prototype/license metadata | [public-metadata.test.mjs](tests/public-metadata.test.mjs) |

These include source assertions and synthetic handler events. Some deliberately remove calling credentials to exercise failure branches; they do not prove a successful end-to-end call. Some handlers also reference LINE configuration, so use a clean environment rather than assuming every external dependency is mocked.

To run the existing suite without inherited application credentials:

```bash
env -u TWILIO_ACCOUNT_SID -u TWILIO_AUTH_TOKEN \
  -u TWILIO_FROM_NUMBER -u NURSE_PHONE_NUMBER -u PATIENT_NAME \
  -u BUTTON_SHARED_SECRET -u PUBLIC_CALLBACK_BASE \
  -u REQUIRE_TWILIO_SIGNATURE -u LINE_CHANNEL_ACCESS_TOKEN \
  -u LINE_USER_ID npm test
```

The command is for a POSIX shell. On other platforms, use an equivalent clean process environment. Do not perform live call or LINE-send checks as part of ordinary documentation work.

[Security CI](.github/workflows/security-baseline.yml) checks the public-content boundary and secrets. The checked-in workflows do not run `npm test`; do not infer behavioral coverage from a green secret scan.

## Deployment boundary

The [deployment workflow](.github/workflows/deploy.yml) runs on **every push to `main`**, including documentation-only changes, and on manual dispatch. It installs dependencies, packages `index.mjs` with `node_modules`, assumes an AWS role through GitHub OIDC (`AWS_DEPLOY_ROLE_ARN`) and updates Lambda code.

It does not provision the Alexa skill, Twilio account, Function URL, runtime variables or monitoring. It does not run the behavioral suite before updating code. The configured Lambda handler is `index.handler`; Alexa trigger restrictions and callback reachability must be configured and reviewed separately.

Keep documentation publication on a review branch. Merging to `main` is a production release decision. Deployment and real outbound calls require explicit authorization.

## Contributing and license

Read [CONTRIBUTING.md](CONTRIBUTING.md). Keep examples synthetic, describe expected behavior and check the staged public files before committing:

```bash
python3 scripts/check_public_repo.py --staged
```

Repository map: [handler](index.mjs) · [tests](tests/) · [product manifest](product.json) · [workflows](.github/workflows/).

[MIT License](LICENSE) · Part of [VEAI LAB.](https://veai.jp/).
