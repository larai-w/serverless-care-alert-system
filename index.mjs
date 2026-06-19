import twilio from 'twilio';
import https from 'https';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  NURSE_PHONE_NUMBER,
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_USER_ID,
} = process.env;

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

function sendLineMessage(message) {
  return new Promise((resolve, reject) => {
    if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_USER_ID) {
      return reject(new Error('Required LINE environment variables are not set.'));
    }

    const body = JSON.stringify({
      to: LINE_USER_ID,
      messages: [{ type: 'text', text: message }],
    });

    const options = {
      hostname: 'api.line.me',
      path: '/v2/bot/message/push',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`LINE API error: ${res.statusCode} ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

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

export const handler = async (event) => {
  console.log('Received event:', JSON.stringify(event, null, 2));

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
        await callNurse('患者さんからナースコールが届いています。すぐに確認してください。');
        return buildAlexaResponse('看護師に連絡しました。もうしばらくお待ちください。');
      } catch (err) {
        console.error('Failed to call nurse:', err);
        return buildAlexaResponse('申し訳ありません。看護師への連絡に失敗しました。もう一度お試しください。');
      }
    }

    if (intentName === 'LineMessageIntent') {
      const message = event.request.intent?.slots?.message?.value;
      if (!message) {
        return buildAlexaResponse('送信するメッセージが聞き取れませんでした。もう一度お試しください。');
      }
      try {
        await sendLineMessage(message);
        return buildAlexaResponse('LINEでメッセージを送信しました。');
      } catch (err) {
        console.error('Failed to send LINE message:', err);
        return buildAlexaResponse('申し訳ありません。LINEへの送信に失敗しました。もう一度お試しください。');
      }
    }

    if (intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent') {
      return buildAlexaResponse('ナースコールシステムを終了します。');
    }

    if (intentName === 'AMAZON.HelpIntent') {
      return buildAlexaResponse(
        '「看護師を呼んで」と話しかけると、担当の看護師に電話でお知らせします。「LINEで」に続けてメッセージを言うと、LINEでメッセージを送ることもできます。',
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
