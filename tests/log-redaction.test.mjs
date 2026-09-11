import test from 'node:test';
import assert from 'node:assert/strict';

// ハンドラは受け取ったイベントを丸ごとログに出す。
// **`rawQueryString` には共有シークレットが載る。**
//
// 2026-09-11: 折り返しの受け口を curl で叩いたら、CloudWatch に
// `secret=<平文>` がそのまま残った。ログの保存期間は無期限だった。
// 実際に出たのは1件（このテスト実行）だが、**Twilio からの本物の
// 折り返しが来れば毎回残る。** 通報のたびに秘密が1行増える形。

const SECRET = 'SUPER+SECRET/VALUE=';

function capture(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) {
    console[k] = (...a) => lines.push(a.map(String).join(' '));
  }
  return fn().finally(() => Object.assign(console, orig)).then(() => lines.join('\n'));
}

async function loadHandler() {
  const saved = { ...process.env };
  Object.assign(process.env, {
    BUTTON_SHARED_SECRET: SECRET,
    TWILIO_ACCOUNT_SID: 'AC-test', TWILIO_AUTH_TOKEN: 'token',
    TWILIO_FROM_NUMBER: '+10000000000', NURSE_PHONE_NUMBER: '+81000000000',
  });
  const mod = await import(`../index.mjs?redact=${Date.now()}${Math.random()}`);
  return { handler: mod.handler, restore: () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }};
}

function webhookEvent(path) {
  return {
    version: '2.0',
    rawPath: path,
    rawQueryString: `secret=${encodeURIComponent(SECRET)}&attempt=1`,
    headers: { host: 'x.lambda-url.us-east-1.on.aws', 'x-button-secret': SECRET },
    queryStringParameters: { secret: SECRET, attempt: '1' },
    requestContext: { http: { path, method: 'POST' } },
    body: 'CallStatus=ringing&CallSid=CA-test',
    isBase64Encoded: false,
  };
}

test('シークレットをログに書かない（クエリ文字列）', async () => {
  const { handler, restore } = await loadHandler();
  try {
    const out = await capture(() => handler(webhookEvent('/twilio-status')));
    assert.ok(!out.includes(SECRET),
      'ログに共有シークレットが平文で出ている。CloudWatch は無期限保存で、消せるのはストリーム単位だけ');
  } finally { restore(); }
});

test('シークレットをログに書かない（ヘッダー）', async () => {
  // 物理ボタンは `x-button-secret` ヘッダーで送ってくる。こちらも同じ。
  const { handler, restore } = await loadHandler();
  try {
    const out = await capture(() => handler(webhookEvent('/button')));
    assert.ok(!out.includes(SECRET), 'ヘッダーのシークレットがログに出ている');
  } finally { restore(); }
});

test('伏せても、調べるのに要る情報は残す', async () => {
  // **消しすぎない。** 経路・メソッド・attempt が読めないと障害調査ができない。
  const { handler, restore } = await loadHandler();
  try {
    const out = await capture(() => handler(webhookEvent('/twilio-status')));
    assert.match(out, /twilio-status/, 'パスが読めない');
    assert.match(out, /attempt/, 'attempt が読めない');
  } finally { restore(); }
});
