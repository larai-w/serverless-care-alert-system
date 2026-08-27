import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs'),
  'utf8'
);

// 家族への LINE 通知は「通報の付加物」であって「通報そのもの」ではない。
// **通知のために通報が壊れる形にしない。** ここではその性質を固定する。
// 夜間に動けなくなった状態から看護師を呼ぶ仕組みなので、
// 付加物が本体を巻き込むのが一番まずい。

test('LINE は電話のあとに送る（すべての経路で）', () => {
  // **順番が逆だと、通知の分だけ通報が遅れる。**
  //
  // ⚠️ 最初のテストは `indexOf` で1件だけ見ていて、Alexa 経路だけ逆にしても
  // 通ってしまった（2026-08-27）。次に書いたものは `callNurse(...)` の
  // 引数が増えたら合わなくなった。**形に依存する書き方は、実装を触るたびに壊れる。**
  //
  // ここでは形ではなく**関係**を見る:
  //   「成功の通知」ひとつひとつについて、**直前に callNurse がある**こと。
  //   その間に return が挟まっていないこと（早期離脱していない）。
  const notifies = [...SRC.matchAll(/notifyFamilyOnLine\(buildFamilyMessage\('placed'\)\)/g)]
    .map((m) => m.index);

  assert.ok(notifies.length >= 2,
    `成功時の通知が ${notifies.length} 箇所。ボタンと Alexa の2経路あるはず`);

  for (const at of notifies) {
    const before = SRC.lastIndexOf('callNurse(', at);
    assert.ok(before !== -1 && before < at,
      '成功の通知の前に callNurse が無い。通知が先に走る形になっている');
    const between = SRC.slice(before, at);
    assert.ok(!/\breturn\b/.test(between),
      'callNurse と通知の間に return がある。通知に届かない経路がある');
  }
});

test('折り返し先を渡さない発信経路が無い', () => {
  // **Alexa 経路では host が取れない。** 関数URLではなく Lambda を直接
  // 呼ぶため。夜間に一番使うのがこの経路なので、ここが抜けると
  // **肝心のときだけ通話結果が分からない**。
  const calls = [...SRC.matchAll(/callNurse\(buildAlertMessage\(\)/g)].map((m) => m.index);
  assert.ok(calls.length >= 2, `callNurse の呼び出しが ${calls.length} 箇所`);
  for (const at of calls) {
    const tail = SRC.slice(at, at + 200);
    assert.match(tail, /callbackBase/,
      'callbackBase を渡していない発信がある。通話結果を受け取れない');
  }
});

test('Alexa 経路（host が無い）でも折り返し先が決まる', async () => {
  // ⚠️ 最初に書いたテストは `SRC` に PUBLIC_CALLBACK_BASE の**文字が**
  // あるかだけを見ていた。宣言部とコメントに残るので、
  // **肝心のフォールバックを消しても通ってしまった**（2026-08-27）。
  // 文字ではなく**挙動**を見る。
  const saved = { ...process.env };
  process.env.PUBLIC_CALLBACK_BASE = 'https://example.on.aws';
  try {
    const mod = await import(`../index.mjs?cb=${Date.now()}${Math.random()}`);

    // 関数URL 経由: イベントの host を使う
    assert.equal(
      mod.callbackBaseFrom({ headers: { host: 'real.on.aws' } }),
      'https://real.on.aws'
    );

    // Alexa 経由: host が無い。**環境変数の受け皿が効くこと**
    assert.equal(
      mod.callbackBaseFrom({ request: { type: 'IntentRequest' } }),
      'https://example.on.aws',
      'host が無いときに折り返し先が決まらない。Alexa 経路で通話結果を受け取れない'
    );

    // どちらも無ければ null（**落とさない**。通報は成立する）
    delete process.env.PUBLIC_CALLBACK_BASE;
    const mod2 = await import(`../index.mjs?cb2=${Date.now()}${Math.random()}`);
    assert.equal(mod2.callbackBaseFrom({}), null, '取れないときに null を返していない');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('LINE の失敗で通報を止めない（throw しない）', () => {
  // notifyFamilyOnLine は必ず解決する。reject する経路があってはいけない。
  const start = SRC.indexOf('async function notifyFamilyOnLine');
  assert.ok(start !== -1, 'notifyFamilyOnLine が無い');
  const end = SRC.indexOf('function buildFamilyMessage', start);
  const body = SRC.slice(start, end);

  assert.ok(!/\breject\s*\(/.test(body), 'reject している。LINE の失敗が通報を巻き込む');
  assert.ok(!/\bthrow\b/.test(body), 'throw している。LINE の失敗が通報を巻き込む');
  assert.match(body, /new Promise\(\s*\(\s*resolve\s*\)/,
    'Promise が resolve のみを受け取る形になっていない');
});

test('発信に失敗したときこそ家族へ送る', () => {
  // **失敗こそ伝える。** 呼んだ本人には音声で伝わるが、家族には
  // CloudWatch 経由のメールしか届かず、夜間は気づけない。
  assert.match(SRC, /console\.error\('Failed to call nurse:[\s\S]{0,300}?buildFamilyMessage\('failed'\)/,
    'Alexa 経路で、発信失敗時に家族へ送っていない');
  assert.match(SRC, /Failed to call nurse from button webhook[\s\S]{0,300}?buildFamilyMessage\('failed'\)/,
    'ボタン経路で、発信失敗時に家族へ送っていない');
});

test('LINE を待つ時間に上限がある', () => {
  // **応答しない LINE API に引きずられない。**
  // 2026-08-26 に ParkinSync で、外部APIのリトライ予算が関数の時間を
  // 食い潰して毎回タイムアウトしていた（CSI-018）。同じ形を作らない。
  assert.match(SRC, /LINE_TIMEOUT_MS\s*=\s*\d+/, '待ち時間の上限が定義されていない');
  const start = SRC.indexOf('async function notifyFamilyOnLine');
  const body = SRC.slice(start, SRC.indexOf('function buildFamilyMessage', start));
  assert.match(body, /timeout:\s*LINE_TIMEOUT_MS/, 'リクエストに timeout を渡していない');
  assert.match(body, /req\.on\('timeout'/, 'timeout を捕まえていない');
  assert.match(body, /req\.destroy\(\)/, 'timeout 後にソケットを閉じていない');
});

test('未設定なら黙って何もしない（通報は動く）', () => {
  // 通知は付加物。設定していないのは「失敗」ではない。
  const start = SRC.indexOf('async function notifyFamilyOnLine');
  const body = SRC.slice(start, SRC.indexOf('function buildFamilyMessage', start));
  assert.match(body, /if \(!LINE_CHANNEL_ACCESS_TOKEN \|\| !LINE_USER_ID\)/,
    '未設定の分岐が無い');
  assert.match(body, /return \{ sent: false, reason: 'not configured' \}/,
    '未設定のとき戻り値で示していない');
});

test('文面で成功と失敗が見分けられる', () => {
  // **読んだ人がすることが変わる。** 同じ文面だと、失敗に気づけない。
  const start = SRC.indexOf('function buildFamilyMessage');
  const body = SRC.slice(start, start + 800);
  assert.match(body, /ナースコール失敗/, '失敗の文面が成功と区別できない');
  assert.match(body, /別の手段で確認/, '失敗時に何をすべきか書いていない');
});
