import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeConfigProvider } from '../runtime-config.mjs';

const arn = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:synthetic-example';
const env = { CARE_ALERT_SECRET_ARN: arn, AWS_REGION: 'us-east-1', TWILIO_AUTH_TOKEN: 'stale-env-token' };
const value = {
  TWILIO_ACCOUNT_SID: 'synthetic-account', TWILIO_AUTH_TOKEN: 'synthetic-token',
  TWILIO_FROM_NUMBER: 'synthetic-caller', NURSE_PHONE_NUMBER: 'synthetic-recipient',
  BUTTON_SHARED_SECRET: 'synthetic-button', PATIENT_NAME: 'synthetic-name',
  LINE_CHANNEL_ACCESS_TOKEN: 'synthetic-line-token', LINE_USER_ID: 'synthetic-line-recipient',
};
const response = v => ({ SecretString: JSON.stringify(v) });

test('legacy mode preserves the snapshot without loading the SDK or calling the provider', async () => {
  const input = { BUTTON_SHARED_SECRET: 'synthetic-legacy' };
  const get = createRuntimeConfigProvider({ env: input, fetchSecret: () => assert.fail('must not fetch') });
  input.BUTTON_SHARED_SECRET = 'changed-after-import';
  assert.equal((await get()).BUTTON_SHARED_SECRET, 'synthetic-legacy');
});

test('one validated fetch serves concurrent and warm requests, without environment merging', async () => {
  let calls = 0;
  const get = createRuntimeConfigProvider({ env, fetchSecret: async options => {
    calls++;
    assert.equal(options.secretArn, arn);
    assert.equal(options.region, 'us-east-1');
    return response({ ...value, UNRECOGNIZED: 'ignored' });
  } });
  const [first, second] = await Promise.all([get(), get()]);
  assert.equal(calls, 1);
  assert.strictEqual(first, second);
  assert.strictEqual(await get(), first);
  assert.equal(first.TWILIO_AUTH_TOKEN, value.TWILIO_AUTH_TOKEN);
  assert.equal(first.UNRECOGNIZED, undefined);
  assert.ok(Object.isFrozen(first));
});

test('missing optional fields do not inherit stale personal or LINE data', async () => {
  const minimal = { ...value };
  for (const key of ['PATIENT_NAME', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_USER_ID']) delete minimal[key];
  const get = createRuntimeConfigProvider({
    env: { ...env, PATIENT_NAME: 'stale-name', LINE_CHANNEL_ACCESS_TOKEN: 'stale-token', LINE_USER_ID: 'stale-recipient' },
    fetchSecret: async () => response(minimal),
  });
  const config = await get();
  assert.equal(config.PATIENT_NAME, undefined);
  assert.equal(config.LINE_USER_ID, undefined);
  assert.equal(config.LINE_CHANNEL_ACCESS_TOKEN, undefined);
});

test('blank optional LINE settings disable notifications rather than sending with whitespace credentials', async () => {
  const get = createRuntimeConfigProvider({ env, fetchSecret: async () => response({
    ...value, LINE_CHANNEL_ACCESS_TOKEN: ' ', LINE_USER_ID: '',
  }) });
  const config = await get();
  assert.equal(config.LINE_CHANNEL_ACCESS_TOKEN, undefined);
  assert.equal(config.LINE_USER_ID, undefined);
});

test('failed loads redact provider diagnostics, never fall back, and retry on the next request', async () => {
  let calls = 0;
  const get = createRuntimeConfigProvider({ env, fetchSecret: async () => {
    if (++calls === 1) throw new Error('synthetic-private-diagnostic');
    return response(value);
  } });
  await assert.rejects(get(), error => {
    assert.equal(error.message, 'Runtime configuration unavailable.');
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.stack, /synthetic-private-diagnostic/);
    return true;
  });
  assert.equal((await get()).TWILIO_AUTH_TOKEN, value.TWILIO_AUTH_TOKEN);
  assert.equal(calls, 2);
});

test('invalid references and region mismatch reject without fetching or using legacy values', async () => {
  for (const input of ['', 'plain-name', arn + ' ', arn.replace('us-east-1', 'eu-west-1')]) {
    const get = createRuntimeConfigProvider({ env: { ...env, CARE_ALERT_SECRET_ARN: input },
      fetchSecret: () => assert.fail('must not fetch') });
    await assert.rejects(get(), /Runtime configuration unavailable/);
  }
});

test('malformed and incomplete secret values fail closed with a fixed diagnostic', async () => {
  const cases = [ {}, { SecretBinary: new Uint8Array([1]) }, { SecretString: 'private-invalid-json' },
    response(null), response([]), response('text'), response({}),
    response({ ...value, BUTTON_SHARED_SECRET: '' }),
    response({ ...value, TWILIO_AUTH_TOKEN: '  ' }),
    response({ ...value, NURSE_PHONE_NUMBER: 42 }),
    response({ ...value, PATIENT_NAME: {} }),
    response({ ...value, LINE_USER_ID: '' }),
    response({ ...value, LINE_CHANNEL_ACCESS_TOKEN: undefined }),
  ];
  for (const result of cases) {
    const get = createRuntimeConfigProvider({ env, fetchSecret: async () => result });
    await assert.rejects(get(), { message: 'Runtime configuration unavailable.' });
  }
});

test('a hung provider aborts, fails closed, and can retry without adopting a late result', async () => {
  let calls = 0, signal, lateResolve;
  const get = createRuntimeConfigProvider({ env, timeoutMs: 10, fetchSecret: options => {
    calls++;
    if (calls === 1) { signal = options.signal; return new Promise(resolve => { lateResolve = resolve; }); }
    return response(value);
  } });
  await assert.rejects(get(), /Runtime configuration unavailable/);
  assert.equal(signal.aborted, true);
  const fresh = await get();
  lateResolve(response({ ...value, TWILIO_AUTH_TOKEN: 'late-stale-token' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await get()).TWILIO_AUTH_TOKEN, fresh.TWILIO_AUTH_TOKEN);
  assert.equal(calls, 2);
});
