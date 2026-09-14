import https from 'https';
import twilio from 'twilio';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  NURSE_PHONE_NUMBER,
  // 誰からのコールかを読み上げに入れる。寝起きでも状況が掴めるようにするため。
  // このリポジトリは公開なので名前はコードに書かず、Lambda の環境変数で渡す
  // (AGENTS.md: personal information をコミットしない)。未設定でも動く。
  PATIENT_NAME,
  // 物理ボタンからの Webhook を認証する共有シークレット。
  // 未設定なら Webhook 入口は無効(誰でも通報できる状態にしない)。
  BUTTON_SHARED_SECRET,
  // 家族への LINE 通知。**未設定でも通報は動く**(通知は付加物)。
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_USER_ID,
  // Twilio に伝える折り返し先の基点(この関数の関数URL)。
  // ⚠️ **Alexa 経由の呼び出しでは host が取れない。**
  // Alexa は関数URLではなく Lambda を直接呼ぶため、イベントに host が無い。
  // 夜間に一番使うのは Alexa 経路なので、ここが空だと
  // **肝心の経路だけ通話結果を受け取れない**。だから環境変数で持つ。
  PUBLIC_CALLBACK_BASE,
} = process.env;

// LINE API を待つ上限。**電話より長く待たない。**
// 通知のために通報が遅れたら本末転倒(CLAUDE.md §2.6)。
const LINE_TIMEOUT_MS = 3000;

// 通話結果を受け取る入口のパス。ボタン通報と同じ関数URLだが、
// **パスで分ける**。同じ入口にすると、Twilio からの通知で
// もう一度通報を起こしてしまう。
const STATUS_CALLBACK_PATH = '/twilio-status';

// **段階的に切り替えるための旗。** 既定は off。
// 署名検証が本番のイベント形で本当に通ることをログで確かめてから on にする。
// ナースコールの経路なので、ここを一気に切り替えて 401 になると
// 「看護師が出なかった」という一番伝えたい通知が黙って消える。
const REQUIRE_TWILIO_SIGNATURE = process.env.REQUIRE_TWILIO_SIGNATURE === '1';

// 再発信は1回だけ。**何度も鳴らすと、本当に必要なときに無視される。**
const MAX_CALL_ATTEMPTS = 2;

/**
 * Twilio 経由で介護者の電話番号に自動音声通話を発信する。
 * @param {string} message - 読み上げるメッセージ
 */
async function callNurse(message, { attempt = 1, callbackBase = null } = {}) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !NURSE_PHONE_NUMBER) {
    throw new Error('Required Twilio environment variables are not set.');
  }

  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  const params = {
    twiml: `<Response><Say language="ja-JP">${message}</Say></Response>`,
    to: NURSE_PHONE_NUMBER,
    from: TWILIO_FROM_NUMBER,
  };

  // **「かけた」は「つながった」ではない。**
  // Twilio に結果を知らせてもらう。これが無いと、看護師が出なかったことを
  // 誰も知らないまま終わる(2026-08-27 まではその状態だった)。
  //
  // 何回目の発信かを URL に載せる。**保存先を持たずに再発信を1回に抑える**ため。
  // 再発信の通知には attempt=2 が付くので、そこからさらに再発信しない。
  if (callbackBase && BUTTON_SHARED_SECRET) {
    params.statusCallback =
      `${callbackBase}${STATUS_CALLBACK_PATH}` +
      `?secret=${encodeURIComponent(BUTTON_SHARED_SECRET)}&attempt=${attempt}`;
    params.statusCallbackMethod = 'POST';
    params.statusCallbackEvent = ['completed'];
  }

  const call = await client.calls.create(params);

  console.log(`Call initiated: ${call.sid} (attempt ${attempt})`);
  return call.sid;
}

/**
 * 看護師の電話で読み上げる文言を組み立てる。
 * Alexa からでも物理ボタンからでも同じ内容を読む。呼び出し経路によって
 * 聞こえ方が変わると、寝起きで混乱するため。
 */
function buildAlertMessage() {
  // 名前が設定されていれば「◯◯さんからナースコールです」と読む。
  // 未設定なら従来どおり。名前の有無で動作が変わらないようにする。
  const caller = PATIENT_NAME ? `${PATIENT_NAME}さんから` : '';
  return `${caller}ナースコールです。`
    + 'アレクサアプリを開いて、呼びかけでお話しください。'
    + `繰り返します。${caller}ナースコールです。`
    + 'アレクサアプリの呼びかけでお話しください。';
}

/**
 * Alexa レスポンスオブジェクトを生成するヘルパー。
 */
function buildAlexaResponse(speechText, shouldEndSession = true) {
  return {
    version: '1.0',
    response: {
      outputSpeech: {
        type: 'PlainText',
        text: speechText,
      },
      shouldEndSession,
    },
  };
}

/**
 * 物理ボタンからの Webhook を処理する。
 *
 * 公開URLなので、共有シークレットが一致しない限り通報しない。
 * シークレット未設定のときは入口ごと無効にする(設定漏れで誰でも
 * 通報できる状態になる方が危険なため、fail closed)。
 *
 * @param {object} event - Lambda 関数URL のイベント
 */
async function handleButtonWebhook(event) {
  const reply = (statusCode, body) => ({
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!BUTTON_SHARED_SECRET) {
    console.error('BUTTON_SHARED_SECRET is not set; webhook entry is disabled.');
    return reply(503, { error: 'webhook disabled' });
  }

  // ヘッダーはクライアントによって大文字小文字が揺れる。関数URLは小文字化するが、
  // クエリ文字列も受け付ける(Webhook のヘッダーを設定できない機器があるため)。
  const provided = event.headers?.['x-button-secret']
    ?? event.queryStringParameters?.secret;

  if (!provided || !timingSafeEqualString(provided, BUTTON_SHARED_SECRET)) {
    console.warn('Webhook rejected: bad or missing secret.');
    return reply(401, { error: 'unauthorized' });
  }

  try {
    const sid = await callNurse(buildAlertMessage(), {
      callbackBase: callbackBaseFrom(event),
    });
    await notifyFamilyOnLine(buildFamilyMessage('placed'));
    return reply(200, { ok: true, callSid: sid });
  } catch (err) {
    console.error('Failed to call nurse from button webhook:', err);
    await notifyFamilyOnLine(buildFamilyMessage('failed'));
    return reply(502, { error: 'call failed' });
  }
}

/**
 * 家族の LINE へ通知する。**通報の付加物であって、通報そのものではない。**
 *
 * なぜ要るか(2026-08-27):
 *   発信に失敗したとき、呼んだ本人には音声で伝わるが、家族には
 *   **CloudWatch アラーム経由のメールしか届かない**。夜中の3時にメールは
 *   届いても気づけない。成功したときも、家族は「呼ばれたこと」を知らない。
 *
 * 設計の約束:
 *   1. **電話が先、LINE は後。** 順番を逆にしない
 *   2. **絶対に throw しない。** LINE の失敗で通報を止めない
 *   3. **未設定なら黙って何もしない。** 通知は付加物なので、
 *      無くても通報は成立する
 *   4. **待ち時間に上限を置く。** 応答しない LINE API に引きずられない
 *
 * ⚠️ **LINE は代替手段ではない。** 通信が死んでいれば電話も LINE も鳴らない。
 * 確実に鳴る物理的な手段の併用が前提であることは変わらない。
 *
 * @returns {Promise<{sent: boolean, reason?: string}>} 例外は投げない
 */
async function notifyFamilyOnLine(text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_USER_ID) {
    // 設定していないだけ。**失敗ではない**ので警告にしない。
    console.log('LINE notify skipped: not configured');
    return { sent: false, reason: 'not configured' };
  }

  const body = JSON.stringify({
    to: LINE_USER_ID,
    messages: [{ type: 'text', text }],
  });

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = https.request(
      {
        hostname: 'api.line.me',
        path: '/v2/bot/message/push',
        method: 'POST',
        timeout: LINE_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            // 成功も残す。失敗しか記録が無いと
            // 「送ったつもりで届いていない」を切り分けられない。
            console.log(`LINE notify ok: ${res.statusCode}`);
            done({ sent: true });
          } else {
            console.error(`LINE notify failed: ${res.statusCode} ${data}`);
            done({ sent: false, reason: `http ${res.statusCode}` });
          }
        });
      }
    );

    req.on('timeout', () => {
      console.error(`LINE notify timed out after ${LINE_TIMEOUT_MS}ms`);
      req.destroy();
      done({ sent: false, reason: 'timeout' });
    });
    req.on('error', (err) => {
      console.error('LINE notify error:', err.message);
      done({ sent: false, reason: err.message });
    });

    req.write(body);
    req.end();
  });
}

/**
 * 家族へ送る文面。**成功と失敗で、読んだ人がすることが変わる。**
 */
function buildFamilyMessage(outcome) {
  const who = PATIENT_NAME ? `${PATIENT_NAME}さん` : '患者さん';
  const at = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  switch (outcome) {
    case 'placed':
      return `【ナースコール】${who}が看護師を呼びました。\n${at}\n看護師の電話を鳴らしています。`;
    case 'answered':
      return `【ナースコール】看護師が電話に出ました。\n${at}`;
    case 'retrying':
      return `【ナースコール】看護師が電話に出ませんでした。\n${at}\nもう一度かけ直しています。`;
    case 'unanswered':
      // **一番伝えたい状態。**「呼んだのに誰も来ない」が起きている。
      return `【ナースコール応答なし】${who}が看護師を呼びましたが、${MAX_CALL_ATTEMPTS}回とも電話に出ませんでした。\n${at}\n**すぐに様子を見てください。**`;
    default:
      return `【ナースコール失敗】${who}が看護師を呼びましたが、電話の発信に失敗しました。\n${at}\n**別の手段で確認してください。**`;
  }
}


/**
 * 呼び出し元の関数URLの基点を組み立てる。Twilio に折り返し先を伝えるため。
 * 取れなければ `null`。**取れなくても通報は成立する**ので落とさない。
 */
export function callbackBaseFrom(event) {
  const host = event?.headers?.host ?? event?.requestContext?.domainName;
  if (host) return `https://${host}`;
  // Alexa 経由など、イベントから取れない場合の受け皿。
  return PUBLIC_CALLBACK_BASE || null;
}

/**
 * Twilio からの通話結果を受ける。
 *
 * **なぜ要るか(2026-08-27)**
 *   `client.calls.create()` は「発信を受け付けた」ことしか返さない。
 *   **看護師が出たかどうかを、システムは知らなかった。**
 *   `Call initiated` は「かけた」であって「つながった」ではない。
 *   夜間に動けない状態で使う仕組みなので、
 *   「呼んだのに誰も来ない」に気づけないのは重い。
 *
 * **やること**
 *   - 出なかった(no-answer / busy / failed / canceled)なら **1回だけ**かけ直す
 *   - 出なかったことを家族の LINE に伝える
 *   - つながったことも伝える(「呼んだのに来ない」と区別するため)
 *
 * **再発信を1回に抑える方法**
 *   保存先を持たず、折り返し先 URL の `attempt` で数える。
 *   再発信の通知には `attempt=2` が付くので、そこからは再発信しない。
 *   **状態を持たない分、壊れる箇所が減る。**
 */
async function handleCallStatus(event) {
  const reply = (statusCode, body) => ({
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!BUTTON_SHARED_SECRET) {
    console.error('BUTTON_SHARED_SECRET is not set; status callback is disabled.');
    return reply(503, { error: 'callback disabled' });
  }

  // Twilio は application/x-www-form-urlencoded で送ってくる。
  // **署名の対象なので、認証より先に読む。**
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');
  const form = new URLSearchParams(raw);
  const formParams = Object.fromEntries(form.entries());

  const sig = verifyTwilioSignature(event, formParams);
  // **毎回残す。** 旗を立てる前に、本番のイベント形で本当に通るかを
  // ログで確かめるための材料。
  console.log(`Status callback signature: ${sig.reason}`);

  if (REQUIRE_TWILIO_SIGNATURE) {
    if (!sig.valid) {
      console.warn(`Status callback rejected: signature ${sig.reason}.`);
      return reply(401, { error: 'unauthorized' });
    }
  } else {
    const provided = event.queryStringParameters?.secret;
    if (!provided || !timingSafeEqualString(provided, BUTTON_SHARED_SECRET)) {
      console.warn('Status callback rejected: bad or missing secret.');
      return reply(401, { error: 'unauthorized' });
    }
  }
  const status = form.get('CallStatus');
  const sid = form.get('CallSid');
  // **数えられない値は「もう限界」として扱う。**
  // `Number('abc')` は NaN で、`NaN >= MAX_CALL_ATTEMPTS` は false。
  // 素直に比較すると上限をすり抜けて再発信し、次の callback にも
  // `attempt=NaN` が載る。それもまた NaN なので**何回でも鳴り続ける**。
  // 鳴っているのは看護師の携帯なので、深夜に人を起こし続けることになる。
  // 小数も切り上げて数える（1.5 を1回目と数えると上限が1回増える）。
  const attempt = attemptFrom(event.queryStringParameters?.attempt);

  console.log(`Call status: ${status} (sid ${sid}, attempt ${attempt})`);

  if (status === 'completed') {
    await notifyFamilyOnLine(buildFamilyMessage('answered'));
    return reply(200, { ok: true, status, action: 'none' });
  }

  const missed = ['no-answer', 'busy', 'failed', 'canceled'];
  if (!missed.includes(status)) {
    // ringing など途中の状態。何もしない。
    return reply(200, { ok: true, status, action: 'none' });
  }

  if (attempt >= MAX_CALL_ATTEMPTS) {
    // **鳴らし続けない。** 何度も鳴らすと、本当に必要なときに無視される。
    console.warn(`Nurse did not answer after ${attempt} attempts.`);
    await notifyFamilyOnLine(buildFamilyMessage('unanswered'));
    return reply(200, { ok: true, status, action: 'gave-up' });
  }

  try {
    const nextSid = await callNurse(buildAlertMessage(), {
      attempt: attempt + 1,
      callbackBase: callbackBaseFrom(event),
    });
    // かけ直したことも伝える。**黙ってやり直さない。**
    await notifyFamilyOnLine(buildFamilyMessage('retrying'));
    return reply(200, { ok: true, status, action: 'retried', callSid: nextSid });
  } catch (err) {
    console.error('Failed to re-call nurse:', err);
    await notifyFamilyOnLine(buildFamilyMessage('failed'));
    return reply(502, { error: 'recall failed' });
  }
}

/**
 * 何回目の発信かを読む。**読めなければ上限とみなす。**
 * 迷ったときに「鳴らさない」側へ倒す。鳴りすぎは無視につながり、
 * 本当に必要なときに効かなくなる。
 */
function attemptFrom(raw) {
  const n = Number(raw ?? '1');
  if (!Number.isFinite(n) || n < 1) return MAX_CALL_ATTEMPTS;
  return Math.ceil(n);
}

/**
 * Twilio からの POST であることを署名で確かめる。
 *
 * なぜ要るか:
 *   いまは共有シークレットを statusCallback の **URL クエリ**に載せている。
 *   URL は Twilio 側の通話ログに保存されるので、**そこを見られる人には
 *   シークレットが見える**。署名なら秘密は URL に出ない。
 *
 * 署名対象は Twilio が実際に叩いた URL そのもの。`rawQueryString` が無いと
 * 並び順を復元できず、正しい要求でも不一致になる。**その場合は「検証できて
 * いない」と言う。「不正」とは言わない。**
 *
 * @returns {{valid: boolean, reason: string}}
 */
function verifyTwilioSignature(event, formParams) {
  const signature = event?.headers?.['x-twilio-signature'];
  if (!signature) return { valid: false, reason: 'absent' };
  if (!TWILIO_AUTH_TOKEN) return { valid: false, reason: 'no auth token' };

  const base = callbackBaseFrom(event);
  if (!base) return { valid: false, reason: 'no callback base' };

  const rawQuery = event?.rawQueryString;
  if (typeof rawQuery !== 'string') return { valid: false, reason: 'no raw query' };

  const url = `${base}${STATUS_CALLBACK_PATH}${rawQuery ? `?${rawQuery}` : ''}`;
  try {
    const ok = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, formParams);
    return { valid: ok, reason: ok ? 'ok' : 'mismatch' };
  } catch (err) {
    // 検証そのものが落ちた。**通す理由にはしない。**
    console.error('Twilio signature check threw:', err.message);
    return { valid: false, reason: 'error' };
  }
}

/**
 * 文字列を定数時間で比較する。長さの違いだけでも情報が漏れるため、
 * 先に長さを揃えず、常に全体を走査する。
 */
function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * ログに出す前に秘密を伏せる。
 *
 * なぜ要るか(2026-09-11):
 *   受け取ったイベントを丸ごとログに出していた。共有シークレットは
 *   **`rawQueryString` と `x-button-secret` ヘッダー**に載るので、
 *   Twilio からの折り返しが来るたびに CloudWatch へ平文で1行増える。
 *   この関数のロググループは**保存期間が無期限**で、消せるのは
 *   ストリーム単位だけ。1行だけ消すことはできない。
 *
 * **消しすぎない。** 経路・メソッド・`attempt` は障害調査に要るので残す。
 * 秘密そのものだけを `<redacted>` に置き換える。
 */
function redactEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const mask = '<redacted>';
  const out = { ...event };

  if (typeof out.rawQueryString === 'string') {
    out.rawQueryString = out.rawQueryString.replace(/(^|&)secret=[^&]*/g, `$1secret=${mask}`);
  }
  if (out.queryStringParameters?.secret !== undefined) {
    out.queryStringParameters = { ...out.queryStringParameters, secret: mask };
  }
  if (out.headers) {
    const h = { ...out.headers };
    // ヘッダー名は大文字小文字が揺れる。関数URLは小文字化するが、前提にしない。
    for (const k of Object.keys(h)) {
      if (k.toLowerCase() === 'x-button-secret') h[k] = mask;
    }
    out.headers = h;
  }
  return out;
}

/**
 * AWS Lambda ハンドラー。Alexa からのリクエストを処理する。
 */
export const handler = async (event) => {
  console.log('Received event:', JSON.stringify(redactEvent(event), null, 2));

  // --- 物理ボタンからの Webhook -------------------------------------------
  // 声が出しにくいときの入口。Alexa と同じ通報を起こす。
  // Lambda 関数URL 経由で来るため、Alexa のイベントとは形が違う
  // (requestContext を持ち、request.type を持たない)。
  if (event?.requestContext?.http) {
    // **パスで分ける。** 同じ入口にすると、Twilio からの通話結果の通知で
    // もう一度通報を起こしてしまう。
    const path = event.requestContext.http.path ?? '/';
    if (path === STATUS_CALLBACK_PATH) {
      return handleCallStatus(event);
    }
    return handleButtonWebhook(event);
  }

  const requestType = event?.request?.type;

  if (!requestType) {
    console.warn('No request type found in event:', JSON.stringify(event));
    return buildAlexaResponse('リクエストの種類が不明です。');
  }

  if (requestType === 'LaunchRequest') {
    return buildAlexaResponse(
      '連絡用の試作システムを起動しました。これは緊急通報サービスではありません。設定された連絡先へ電話を始めるには「看護師を呼んで」と話しかけてください。',
      false
    );
  }

  if (requestType === 'IntentRequest') {
    const intentName = event.request.intent?.name;

    if (intentName === 'CallNurseIntent') {
      try {
        // 深夜に確実に起こせるのは携帯への実通話だけ。Alexa アプリの着信は
        // マナーモードでなくても鳴らず、呼びかけ・アナウンスも Echo で鳴らない。
        // そのため「電話で起こす → その電話で次の行動を伝える」形にしている。
        // 看護師は電話を取った時点でスマホを手にしているので、
        // Alexa アプリからの呼びかけは1操作で済む。
        // 患者側の Echo は呼びかけを自動で受けるため、手が使えなくても会話できる。
        await callNurse(buildAlertMessage(), { callbackBase: callbackBaseFrom(event) });
        // **電話のあとに通知する。** 通知が先だと、通報が遅れる。
        await notifyFamilyOnLine(buildFamilyMessage('placed'));
        // ⚠️ **「発信を開始した」以上のことを言わない。**
        // main の 6b4042a で直した文言をそのまま使う。再発信の仕組みが
        // 入っても、この時点で分かっているのは「かけ始めた」ことだけ。
        return buildAlexaResponse(
          '看護師さんへの電話発信を開始しました。電話がつながらない場合は、別の連絡手段を使ってください。'
        );
      } catch (err) {
        console.error('Failed to call nurse:', err);
        // **失敗こそ家族に伝える。** 呼んだ本人には音声で伝わるが、
        // 家族はメールしか受け取れず、夜間は気づけない。
        await notifyFamilyOnLine(buildFamilyMessage('failed'));
        return buildAlexaResponse(
          '看護師さんへの電話発信を開始できませんでした。別の連絡手段を使ってください。'
        );
      }
    }

    if (intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent') {
      return buildAlexaResponse('ナースコールシステムを終了します。');
    }

    if (intentName === 'AMAZON.HelpIntent') {
      return buildAlexaResponse(
        '「看護師を呼んで」と話しかけると、設定された連絡先への電話発信を始めます。相手が応答したかは確認できません。緊急時は別の連絡手段を使ってください。',
        false
      );
    }

    return buildAlexaResponse('そのコマンドは認識できませんでした。もう一度お試しください。');
  }

  if (requestType === 'SessionEndedRequest') {
    console.log('Session ended:', event.request.reason);
    return {};
  }

  return buildAlexaResponse('リクエストを処理できませんでした。');
};
