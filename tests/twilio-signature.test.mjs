import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// 共有シークレットは statusCallback の **URL クエリ**に載っている。
// URL は Twilio 側の通話ログに保存されるので、そこを見られる人には
// シークレットが見える。署名なら秘密は URL に出ない。
//
// ただしナースコールの経路なので、**一気に切り替えない**。
// `REQUIRE_TWILIO_SIGNATURE=1` を立てるまでは今までどおり動くこと、
// 立てたら署名の無い要求を落とすこと。両方を固定する。

const SECRET = 'test-secret-value';
const TOKEN = 'test-auth-token';
const HOST = 'example.lambda-url.us-east-1.on.aws';
const PATH = '/twilio-status';

function sign(url, params, token = TOKEN) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function statusEvent({ attempt = 1, status = 'no-answer', signature, withSecret = true } = {}) {
  const form = { CallStatus: status, CallSid: 'CA-test' };
  const rawQueryString = withSecret
    ? `secret=${encodeURIComponent(SECRET)}&attempt=${attempt}`
    : `attempt=${attempt}`;
  const headers = { host: HOST };
  if (signature !== undefined) headers['x-twilio-signature'] = signature;
  return {
    requestContext: { http: { path: PATH, method: 'POST' } },
    headers,
    rawQueryString,
    queryStringParameters: withSecret
      ? { secret: SECRET, attempt: String(attempt) }
      : { attempt: String(attempt) },
    body: new URLSearchParams(form).toString(),
    isBase64Encoded: false,
    __url: `https://${HOST}${PATH}?${rawQueryString}`,
    __form: form,
  };
}

async function loadHandler(env = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    BUTTON_SHARED_SECRET: SECRET,
    TWILIO_ACCOUNT_SID: 'AC-test',
    TWILIO_AUTH_TOKEN: TOKEN,
    TWILIO_FROM_NUMBER: '+10000000000',
    NURSE_PHONE_NUMBER: '+81000000000',
    ...env,
  });
  const mod = await import(`../index.mjs?sig=${Date.now()}${Math.random()}`);
  return {
    handler: mod.handler,
    restore: () => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    },
  };
}

test('旗を立てていなければ、署名が無くても今までどおり通る', async () => {
  // **既存の動作を壊さない。** ここが落ちると本番で通知が消える。
  const { handler, restore } = await loadHandler();
  try {
    const res = await handler(statusEvent({ status: 'completed' }));
    assert.equal(res.statusCode, 200, '署名を必須にしていないのに落としている');
  } finally { restore(); }
});

test('旗を立てたら、正しい署名だけを通す', async () => {
  const { handler, restore } = await loadHandler({ REQUIRE_TWILIO_SIGNATURE: '1' });
  try {
    const ev = statusEvent({ status: 'completed', withSecret: false });
    ev.headers['x-twilio-signature'] = sign(ev.__url, ev.__form);
    const res = await handler(ev);
    assert.equal(res.statusCode, 200,
      '正しい署名を落としている。本番で通知が全部消える形');
  } finally { restore(); }
});

test('旗を立てたら、署名が無ければ落とす', async () => {
  const { handler, restore } = await loadHandler({ REQUIRE_TWILIO_SIGNATURE: '1' });
  try {
    const res = await handler(statusEvent({ status: 'completed' }));
    assert.equal(res.statusCode, 401,
      '署名が無いのに通している。シークレットだけで通ると意味が無い');
  } finally { restore(); }
});

test('旗を立てたら、署名が違えば落とす', async () => {
  const { handler, restore } = await loadHandler({ REQUIRE_TWILIO_SIGNATURE: '1' });
  try {
    const ev = statusEvent({ status: 'completed', withSecret: false });
    ev.headers['x-twilio-signature'] = sign(ev.__url, ev.__form, 'wrong-token');
    assert.equal((await handler(ev)).statusCode, 401, '別の鍵で作った署名を通している');

    const ev2 = statusEvent({ status: 'completed', withSecret: false });
    ev2.headers['x-twilio-signature'] = sign(ev2.__url, ev2.__form);
    ev2.body = new URLSearchParams({ CallStatus: 'no-answer', CallSid: 'CA-test' }).toString();
    assert.equal((await handler(ev2)).statusCode, 401,
      '本文を差し替えられても通している。署名の意味が無い');
  } finally { restore(); }
});

test('rawQueryString が無ければ「検証できていない」扱いにする', async () => {
  // 並び順を復元できないので、正しい要求でも一致しない。
  // **そこを「不正」と言い切らない**が、旗を立てているなら通さない。
  const { handler, restore } = await loadHandler({ REQUIRE_TWILIO_SIGNATURE: '1' });
  try {
    const ev = statusEvent({ status: 'completed', withSecret: false });
    ev.headers['x-twilio-signature'] = sign(ev.__url, ev.__form);
    delete ev.rawQueryString;
    assert.equal((await handler(ev)).statusCode, 401);
  } finally { restore(); }
});
