import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRuntimeConfigProvider } from '../runtime-config.mjs';

const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
const arn = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:synthetic-example';
const config = {
  TWILIO_ACCOUNT_SID: 'synthetic-account', TWILIO_AUTH_TOKEN: 'synthetic-token',
  TWILIO_FROM_NUMBER: 'synthetic-caller', NURSE_PHONE_NUMBER: 'synthetic-recipient',
  BUTTON_SHARED_SECRET: 'synthetic-button', PATIENT_NAME: 'synthetic-name',
};

async function fixture(fetchSecret) {
  const key = '__runtime_config_test_' + Math.random().toString(36).slice(2);
  const calls = [], signatures = [], logs = [], notifications = [], order = [];
  const saved = { ...process.env };
  process.env.CARE_ALERT_SECRET_ARN = arn;
  process.env.PUBLIC_CALLBACK_BASE = 'https://example.invalid';
  process.env.REQUIRE_TWILIO_SIGNATURE = '1';
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  for (const name of Object.keys(originalConsole)) console[name] = (...args) => logs.push(args.map(String).join(' '));
  const get = createRuntimeConfigProvider({ env: { CARE_ALERT_SECRET_ARN: arn }, fetchSecret });
  const twilio = (sid, token) => ({ calls: { create: async params => {
    order.push('call');
    calls.push({ sid, token, params }); return { sid: 'synthetic-call-id' };
  } } });
  twilio.validateRequest = (token, ...args) => { signatures.push({ token, args }); return token === config.TWILIO_AUTH_TOKEN; };
  const https = { request(options, callback) {
    const request = new EventEmitter();
    let body = '';
    request.write = value => { body += value; };
    request.destroy = () => {};
    request.end = () => queueMicrotask(() => {
      order.push('line');
      notifications.push({ options, body: JSON.parse(body) });
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      response.emit('data', '{}');
      response.emit('end');
    });
    return request;
  } };
  globalThis[key] = { get, twilio, https };
  // Replace every network-facing dependency. The integrated handler itself stays intact.
  const mocked = source
    .replace("import https from 'https';", `const https = globalThis[${JSON.stringify(key)}].https;`)
    .replace("import twilio from 'twilio';", `const twilio = globalThis[${JSON.stringify(key)}].twilio;`)
    .replace("import { createRuntimeConfigProvider } from './runtime-config.mjs';",
      `const createRuntimeConfigProvider = () => globalThis[${JSON.stringify(key)}].get;`);
  const mod = await import('data:text/javascript,' + encodeURIComponent(mocked));
  return { ...mod, calls, signatures, logs, notifications, order, restore() {
    delete globalThis[key];
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    Object.assign(console, originalConsole);
  } };
}

const button = secret => ({ requestContext: { http: { method: 'POST', path: '/' } },
  headers: { 'x-button-secret': secret }, queryStringParameters: null });
const alexaCall = { request: { type: 'IntentRequest', intent: { name: 'CallNurseIntent' } } };

test('configuration failure prevents Alexa, button and callback side effects and redacts errors', async () => {
  const f = await fixture(async () => { throw new Error('synthetic-provider-private-data'); });
  try {
    const alexa = await f.handler(alexaCall);
    assert.match(alexa.response.outputSpeech.text, /電話発信を開始できませんでした/);
    assert.equal((await f.handler(button(config.BUTTON_SHARED_SECRET))).statusCode, 503);
    assert.equal((await f.handler({ ...button(config.BUTTON_SHARED_SECRET),
      requestContext: { http: { method: 'POST', path: '/twilio-status' } }, body: 'CallStatus=no-answer' })).statusCode, 503);
    assert.equal(f.calls.length, 0);
    assert.equal(f.signatures.length, 0);
    assert.equal(f.notifications.length, 0);
    assert.doesNotMatch(f.logs.join('\n'), /synthetic-provider-private-data|synthetic-button/);
  } finally { f.restore(); }
});

test('launch, help and stop remain available without retrieving credentials', async () => {
  const f = await fixture(async () => assert.fail('must not load secret'));
  try {
    for (const request of [{ type: 'LaunchRequest' },
      { type: 'IntentRequest', intent: { name: 'AMAZON.HelpIntent' } },
      { type: 'IntentRequest', intent: { name: 'AMAZON.StopIntent' } }]) {
      assert.ok((await f.handler({ request })).response.outputSpeech);
    }
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('Alexa and authenticated button use only loaded credentials and personal routing data', async () => {
  let fetches = 0;
  const f = await fixture(async () => { fetches++; return { SecretString: JSON.stringify(config) }; });
  try {
    assert.equal((await f.handler(button('wrong'))).statusCode, 401);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.handler(button(config.BUTTON_SHARED_SECRET))).statusCode, 200);
    const result = await f.handler(alexaCall);
    assert.match(result.response.outputSpeech.text, /電話発信を開始しました/);
    assert.equal(fetches, 1);
    assert.equal(f.calls.length, 2);
    for (const call of f.calls) {
      assert.equal(call.sid, config.TWILIO_ACCOUNT_SID);
      assert.equal(call.token, config.TWILIO_AUTH_TOKEN);
      assert.equal(call.params.to, config.NURSE_PHONE_NUMBER);
      assert.equal(call.params.from, config.TWILIO_FROM_NUMBER);
      assert.match(call.params.twiml, /synthetic-name/);
      assert.ok(call.params.statusCallback.includes(encodeURIComponent(config.BUTTON_SHARED_SECRET)));
    }
    assert.doesNotMatch(f.logs.join('\n'), /synthetic-token|synthetic-button|synthetic-recipient/);
  } finally { f.restore(); }
});

test('Twilio callback signature uses the loaded token without originating another call on completed', async () => {
  const f = await fixture(async () => ({ SecretString: JSON.stringify(config) }));
  try {
    const result = await f.handler({
      requestContext: { http: { method: 'POST', path: '/twilio-status' } },
      headers: { 'x-twilio-signature': 'synthetic-signature', host: 'example.invalid' },
      queryStringParameters: { secret: config.BUTTON_SHARED_SECRET, attempt: '1' },
      rawQueryString: 'secret=' + config.BUTTON_SHARED_SECRET + '&attempt=1',
      body: 'CallStatus=completed&CallSid=synthetic-call-id',
    });
    assert.equal(result.statusCode, 200);
    assert.equal(f.signatures.length, 1);
    assert.equal(f.signatures[0].token, config.TWILIO_AUTH_TOKEN);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('LINE uses only the loaded token and recipient and remains after call initiation', async () => {
  const secret = { ...config, LINE_CHANNEL_ACCESS_TOKEN: 'synthetic-line-token', LINE_USER_ID: 'synthetic-line-recipient' };
  const f = await fixture(async () => ({ SecretString: JSON.stringify(secret) }));
  try {
    await f.handler(alexaCall);
    assert.deepEqual(f.order, ['call', 'line']);
    assert.equal(f.notifications.length, 1);
    assert.equal(f.notifications[0].options.headers.Authorization, 'Bearer ' + secret.LINE_CHANNEL_ACCESS_TOKEN);
    assert.equal(f.notifications[0].body.to, secret.LINE_USER_ID);
    assert.doesNotMatch(f.logs.join('\n'), /synthetic-line-token|synthetic-line-recipient|synthetic-name/);
  } finally { f.restore(); }
});

test('deployment archive explicitly includes the runtime config module', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /zip -r function\.zip index\.mjs runtime-config\.mjs node_modules\//);
});
