import test from 'node:test';
import assert from 'node:assert/strict';

// 通話結果の受け口。**「かけた」は「つながった」ではない。**
// 2026-08-27 まで、看護師が出たかどうかをシステムは知らなかった。
// 夜間に動けない状態で使う仕組みなので、
// 「呼んだのに誰も来ない」に気づけないのは重い。

const SECRET = 'test-secret-value';
const BASE = 'https://example.lambda-url.us-east-1.on.aws';

function statusEvent(status, { attempt = 1, secret = SECRET } = {}) {
  return {
    requestContext: { http: { path: '/twilio-status', method: 'POST' } },
    headers: { host: 'example.lambda-url.us-east-1.on.aws' },
    queryStringParameters: { secret, attempt: String(attempt) },
    body: new URLSearchParams({ CallStatus: status, CallSid: 'CA-test' }).toString(),
    isBase64Encoded: false,
  };
}

async function loadHandler(env = {}) {
  const saved = { ...process.env };
  // 回帰テストは実際のTwilio APIへ接続しない。資格情報がローカル環境に
  // 残っていても、callNurseの設定不足経路を通して安全に再発信失敗を検証する。
  for (const key of [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'NURSE_PHONE_NUMBER',
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, {
    BUTTON_SHARED_SECRET: SECRET,
    PUBLIC_CALLBACK_BASE: BASE,
    ...env,
  });
  const mod = await import(`../index.mjs?status=${Date.now()}${Math.random()}`);
  return { handler: mod.handler, restore: () => { 
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }};
}

test('シークレットが無ければ拒否する', async () => {
  const { handler, restore } = await loadHandler();
  try {
    const res = await handler(statusEvent('no-answer', { secret: 'wrong' }));
    assert.equal(res.statusCode, 401, '誤ったシークレットを通している');
    const res2 = await handler(statusEvent('no-answer', { secret: '' }));
    assert.equal(res2.statusCode, 401, 'シークレット無しを通している');
  } finally { restore(); }
});

test('シークレット未設定なら受け口ごと無効になる', async () => {
  // **開いたまま放置しない。** 設定漏れで誰でも叩ける状態にしない。
  const { handler, restore } = await loadHandler({ BUTTON_SHARED_SECRET: '' });
  try {
    const res = await handler(statusEvent('no-answer'));
    assert.equal(res.statusCode, 503, '未設定なのに受け付けている');
  } finally { restore(); }
});

test('つながったら、かけ直さない', async () => {
  const { handler, restore } = await loadHandler();
  try {
    const res = await handler(statusEvent('completed'));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).action, 'none', 'つながったのに何かしている');
  } finally { restore(); }
});

test('途中の状態では何もしない', async () => {
  // ringing などで動くと、鳴っている最中にかけ直してしまう。
  const { handler, restore } = await loadHandler();
  try {
    for (const s of ['ringing', 'in-progress', 'queued']) {
      const res = await handler(statusEvent(s));
      assert.equal(JSON.parse(res.body).action, 'none', `${s} で動いている`);
    }
  } finally { restore(); }
});

test('2回目でも出なければ、あきらめて家族に知らせる', async () => {
  // **鳴らし続けない。** 何度も鳴らすと、本当に必要なときに無視される。
  const { handler, restore } = await loadHandler();
  try {
    const res = await handler(statusEvent('no-answer', { attempt: 2 }));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).action, 'gave-up',
      '2回目でも出ないのに、まだかけ直そうとしている');
  } finally { restore(); }
});

test('出なかったときは、かけ直す（1回目）', async () => {
  // Twilio資格情報を意図的に外し、外部接続なしで再発信経路を検証する。
  // ここで見たいのは「何もしない」ではなく、再発信を試みた結果に失敗すること。
  const { handler, restore } = await loadHandler();
  try {
    const res = await handler(statusEvent('no-answer', { attempt: 1 }));
    assert.equal(res.statusCode, 502, '再発信の設定不足を明確に失敗として返す');
  } finally { restore(); }
});

test('通報の入口と結果の入口を取り違えない', async () => {
  // **同じ関数URL。パスで分けている。** 取り違えると、Twilio からの
  // 結果通知で通報が起きて、無限に鳴り続ける。
  const { handler, restore } = await loadHandler();
  try {
    const asButton = {
      ...statusEvent('completed'),
      requestContext: { http: { path: '/', method: 'POST' } },
    };
    const res = await handler(asButton);
    // ボタン経路として扱われる → 発信を試みる（ダミー認証で 502）
    assert.notEqual(res.statusCode, 200,
      'ルートパスが結果の受け口として扱われている（パス分離が効いていない）');
  } finally { restore(); }
});

test('attempt が数値でなければ、かけ直さずあきらめる', async () => {
  // **止まらなくなる経路。** `Number('abc')` は NaN で、`NaN >= 2` は false。
  // そのため上限判定をすり抜けて再発信し、次の callback には `attempt=NaN`
  // が載る。それもまた NaN なので、**何回でも鳴り続ける**。
  // 鳴っているのは看護師の携帯なので、これは深夜に人を起こし続ける。
  const { handler, restore } = await loadHandler();
  try {
    for (const bad of ['abc', '', 'NaN', 'null']) {
      const res = await handler(statusEvent('no-answer', { attempt: bad }));
      const action = res.statusCode === 200 ? JSON.parse(res.body).action : 'recall-failed';
      assert.equal(action, 'gave-up',
        `attempt=${JSON.stringify(bad)} で action=${action}。数えられない回数で鳴らし続けている`);
    }
  } finally { restore(); }
});

test('かけ直しの上限は attempt を切り上げてから数える', async () => {
  // 小数を渡されても、上限までの回数が増えないこと。
  const { handler, restore } = await loadHandler();
  try {
    const res = await handler(statusEvent('no-answer', { attempt: '1.5' }));
    const action = res.statusCode === 200 ? JSON.parse(res.body).action : 'recall-failed';
    assert.equal(action, 'gave-up',
      `attempt=1.5 で action=${action}。切り上げれば2回目なので、あきらめるべき`);
  } finally { restore(); }
});
