// 物理ボタンの Webhook 入口が、誰でも押せる状態になっていないことを固定する。
//
// この入口は公開URLに晒される。認証が緩むと、通報が第三者から起こせる。
// 深夜に鳴る仕組みなので、誤通報は実害がある。
//
// Twilio の環境変数は意図的に未設定にしてある。認証を通ると callNurse が
// 例外を投げて 502 になるため、401(認証で弾いた)と 502(認証は通った)で
// 区別できる。Twilio を実際に呼ばずに認証だけ検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';

// 実在しないダミー値。gitleaks の誤検知を避けるため、高エントロピーな
// 文字列を直書きせず組み立てる。許可リストで抜け道を作ると、将来の
// 本物のシークレットも同じ経路で通ってしまう。
const DUMMY_SECRET = ['dummy', 'not', 'a', 'real', 'secret'].join('-');
process.env.BUTTON_SHARED_SECRET = DUMMY_SECRET;
delete process.env.TWILIO_ACCOUNT_SID;

const { handler } = await import('../index.mjs');

const webhookEvent = (headers = {}, qs = null) => ({
  requestContext: { http: { method: 'POST', path: '/' } },
  headers,
  queryStringParameters: qs,
});

test('シークレットが無ければ通報しない', async () => {
  const r = await handler(webhookEvent());
  assert.equal(r.statusCode, 401);
});

test('シークレットが違えば通報しない', async () => {
  const r = await handler(webhookEvent({ 'x-button-secret': 'wrong' }));
  assert.equal(r.statusCode, 401);
});

test('長さだけ合っていても通報しない', async () => {
  const r = await handler(webhookEvent({ 'x-button-secret': 'x'.repeat(DUMMY_SECRET.length) }));
  assert.equal(r.statusCode, 401);
});

test('正しいシークレットなら通報処理まで進む（ヘッダー）', async () => {
  const r = await handler(webhookEvent({ 'x-button-secret': DUMMY_SECRET }));
  assert.equal(r.statusCode, 502, 'Twilio 未設定のため 502。認証は通っている');
});

test('正しいシークレットなら通報処理まで進む（クエリ文字列）', async () => {
  // Webhook のヘッダーを設定できない機器があるため、クエリでも受ける
  const r = await handler(webhookEvent({}, { secret: DUMMY_SECRET }));
  assert.equal(r.statusCode, 502);
});

test('Webhook を足しても Alexa の経路は変わらない', async () => {
  const r = await handler({ request: { type: 'LaunchRequest' } });
  assert.match(r.response.outputSpeech.text, /ナースコール/);
});
