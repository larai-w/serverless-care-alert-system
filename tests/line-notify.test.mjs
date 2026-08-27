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
  // ⚠️ 最初に書いたテストは `indexOf` で1件だけ見ていたため、
  // **Alexa 経路の順番を逆にしても通ってしまった**（2026-08-27）。
  // 呼び出し箇所は2つ（ボタン / Alexa）ある。
  // **経路の数だけ確かめないと、片方が壊れても気づけない。**
  const calls = [...SRC.matchAll(/await callNurse\(buildAlertMessage\(\)\);/g)]
    .map((m) => m.index);
  const notifies = [...SRC.matchAll(/notifyFamilyOnLine\(buildFamilyMessage\('placed'\)\)/g)]
    .map((m) => m.index);

  assert.equal(calls.length, 2, `callNurse の呼び出しが ${calls.length} 箇所。経路は2つのはず`);
  assert.equal(notifies.length, 2, `成功時の通知が ${notifies.length} 箇所。経路は2つのはず`);

  // それぞれの経路で、電話 → 通知 の順になっていること
  for (let i = 0; i < calls.length; i += 1) {
    assert.ok(
      notifies[i] > calls[i],
      `${i + 1}番目の経路で LINE 通知が電話より先にある。通報が遅れる`
    );
    // 別の経路の通知と取り違えていないこと（間に次の callNurse が無い）
    if (calls[i + 1] !== undefined) {
      assert.ok(
        notifies[i] < calls[i + 1],
        `${i + 1}番目の経路に通知が無く、次の経路の通知を見ている`
      );
    }
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
