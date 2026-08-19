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
} = process.env;

/**
 * Twilio 経由で介護者の電話番号に自動音声通話を発信する。
 * @param {string} message - 読み上げるメッセージ
 */
async function callNurse(message) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !NURSE_PHONE_NUMBER) {
    throw new Error('Required Twilio environment variables are not set.');
  }

  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  const call = await client.calls.create({
    twiml: `<Response><Say language="ja-JP">${message}</Say></Response>`,
    to: NURSE_PHONE_NUMBER,
    from: TWILIO_FROM_NUMBER,
  });

  console.log(`Call initiated: ${call.sid}`);
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
    const sid = await callNurse(buildAlertMessage());
    return reply(200, { ok: true, callSid: sid });
  } catch (err) {
    console.error('Failed to call nurse from button webhook:', err);
    return reply(502, { error: 'call failed' });
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
 * AWS Lambda ハンドラー。Alexa からのリクエストを処理する。
 */
export const handler = async (event) => {
  console.log('Received event:', JSON.stringify(event, null, 2));

  // --- 物理ボタンからの Webhook -------------------------------------------
  // 声が出しにくいときの入口。Alexa と同じ通報を起こす。
  // Lambda 関数URL 経由で来るため、Alexa のイベントとは形が違う
  // (requestContext を持ち、request.type を持たない)。
  if (event?.requestContext?.http) {
    return handleButtonWebhook(event);
  }

  const requestType = event?.request?.type;

  if (!requestType) {
    console.warn('No request type found in event:', JSON.stringify(event));
    return buildAlexaResponse('リクエストの種類が不明です。');
  }

  if (requestType === 'LaunchRequest') {
    return buildAlexaResponse(
      'ナースコールシステムを起動しました。看護師を呼ぶには「看護師を呼んで」と話しかけてください。',
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
        await callNurse(buildAlertMessage());
        return buildAlexaResponse('看護師さんの電話を鳴らしました。呼びかけがあるまでお待ちください。');
      } catch (err) {
        console.error('Failed to call nurse:', err);
        return buildAlexaResponse('申し訳ありません。看護師への連絡に失敗しました。もう一度お試しください。');
      }
    }

    if (intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent') {
      return buildAlexaResponse('ナースコールシステムを終了します。');
    }

    if (intentName === 'AMAZON.HelpIntent') {
      return buildAlexaResponse(
        '「看護師を呼んで」と話しかけると、担当の看護師に電話でお知らせします。',
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
