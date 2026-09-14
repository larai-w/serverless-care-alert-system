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
  // ⚠️ 以前は先頭から 800 文字だけを見ていて、文面にコメントを足しただけで失敗の文面が範囲外に出た（2026-09-14）。
  // 文字数ではなく、関数の終わり（行頭の `}`）までを見る。
  const end = SRC.indexOf('\n}\n', start);
  assert.ok(start !== -1 && end !== -1, 'buildFamilyMessage の範囲が取れない');
  const body = SRC.slice(start, end);
  assert.match(body, /ナースコール失敗/, '失敗の文面が成功と区別できない');
  assert.match(body, /別の手段で確認/, '失敗時に何をすべきか書いていない');
});

test('発信直後の家族通知は「鳴っている」と言わない', () => {
  // **システムが知っている以上を言わない。**（2026-09-14）
  // Alexa 側は 6b4042a で「電話を鳴らしました」→「発信を開始しました」に直したが、
  // 家族向けの `placed` だけ「看護師の電話を鳴らしています」が残っていた。
  // この時点で分かっているのは「かけ始めた」ことだけで、相手の電話が鳴ったかは分からない。
  // 家族が「もう鳴っているなら大丈夫」と読むと、様子を見に行くのが遅れる。
  const start = SRC.indexOf('function buildFamilyMessage');
  assert.ok(start !== -1, 'buildFamilyMessage が無い');
  const placedAt = SRC.indexOf("case 'placed':", start);
  assert.ok(placedAt !== -1, "buildFamilyMessage に case 'placed' が無い");
  const placed = SRC.slice(placedAt, SRC.indexOf('case ', placedAt + 1));
  assert.doesNotMatch(placed, /鳴らしています|鳴っています|鳴らしました/,
    '発信を始めただけの時点で「鳴っている」と伝えている');
  assert.match(placed, /発信を始めました/, '発信を始めたことを伝えていない');
});

// ---------------------------------------------------------------------------
// 2026-09-14 /hci-check「ナースコールの折り返し」
// ---------------------------------------------------------------------------

function familyCase(name) {
  const start = SRC.indexOf('function buildFamilyMessage');
  assert.ok(start !== -1, 'buildFamilyMessage が無い');
  const at = SRC.indexOf(`case '${name}':`, start);
  assert.ok(at !== -1, `buildFamilyMessage に case '${name}' が無い`);
  const next = SRC.slice(at + 1).search(/case '|default:/);
  return SRC.slice(at, next === -1 ? undefined : at + 1 + next);
}

test('つながったときに「看護師が電話に出ました」と言い切らない（#1・#5）', () => {
  // Twilio の `completed` は、人だけでなく**留守番電話や自動音声メニューが受けても**起こる。
  // 留守番電話検出を付けていないので、人が出たかをシステムは知らない。
  // 家族が「出た」と読むと、様子を見に行かなくなる。人が出ても、来てくれるかはまだ分からない。
  const answered = familyCase('answered');
  assert.doesNotMatch(answered, /電話に出ました/, '留守番電話でも「看護師が電話に出ました」と伝えている');
  assert.match(answered, /つながりました/, 'つながったことを伝えていない');
  assert.match(answered, /留守番電話/, '留守番電話の場合もあることを伝えていない');
  assert.match(answered, /来てもらえるか/, '来てもらえるかはまだ分からないことを伝えていない');
});

test('かけ直しに失敗したら、1回目に出なかったことも伝える（#6）', () => {
  // 以前は `failed`（「電話の発信に失敗しました」）を送っていた。
  // 1回目は発信できて出なかったのに、最初からかけられなかったように読める。
  assert.match(SRC, /Failed to re-call nurse[\s\S]{0,300}?buildFamilyMessage\('recall-failed'\)/,
    'かけ直しの失敗で、専用の文面を送っていない');
  const recallFailed = familyCase('recall-failed');
  assert.match(recallFailed, /ナースコール失敗/, '失敗の文面が成功と区別できない');
  assert.match(recallFailed, /出ず|出ませんでした/, '1回目に出なかったことを伝えていない');
  assert.match(recallFailed, /かけ直し/, 'かけ直しに失敗したことを伝えていない');
  assert.match(recallFailed, /別の手段で確認/, '何をすべきか書いていない');
});

test('2回目の電話は、2回目だと最初に言う（#7）', async () => {
  // 1回目を寝ていて逃した看護師は、同じ読み上げだと繰り返しだと分からない。
  const mod = await import(`../index.mjs?alert=${Date.now()}${Math.random()}`);
  assert.equal(typeof mod.buildAlertMessage, 'function', 'buildAlertMessage を確かめられない');
  assert.doesNotMatch(mod.buildAlertMessage(), /2回目/, '1回目なのに「2回目」と言っている');
  assert.match(mod.buildAlertMessage({ attempt: 2 }), /^2回目のお知らせです。/, '2回目だと最初に言っていない');
  assert.match(SRC, /callNurse\(buildAlertMessage\(\{\s*attempt:\s*attempt \+ 1\s*\}\)/,
    'かけ直しで、何回目かを読み上げに渡していない');
});

test('監視の印を変えない（#2）', () => {
  // CloudWatch のメトリクスフィルタは**この固定文字列**を数える。
  // 文言を変えると、フィルタは黙って0件になり、アラームは緑のまま（RB-0020「当たらないフィルタは無いより悪い」）。
  for (const mark of [
    'Failed to call nurse',
    'Failed to re-call nurse',
    'Nurse did not answer',
    'LINE notify failed',
    'LINE notify timed out',
    'LINE notify error',
  ]) {
    assert.ok(SRC.includes(mark), `監視の印「${mark}」がコードから消えている`);
  }
});
