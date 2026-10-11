const REQUIRED = [
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER',
  'NURSE_PHONE_NUMBER', 'BUTTON_SHARED_SECRET',
];
const OPTIONAL = ['PATIENT_NAME', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_USER_ID'];
const KEYS = [...REQUIRED, ...OPTIONAL];

async function readSecret({ secretArn, region, signal }) {
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region, maxAttempts: 1 });
  try {
    return await client.send(new GetSecretValueCommand({
      SecretId: secretArn, VersionStage: 'AWSCURRENT',
    }), { abortSignal: signal });
  } finally {
    client.destroy();
  }
}

function validateSecret(response) {
  if (typeof response?.SecretString !== 'string') throw new Error();
  const value = JSON.parse(response.SecretString);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  for (const key of KEYS) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error();
  }
  if (REQUIRED.some(key => !value[key]?.trim())) throw new Error();
  if (Boolean(value.LINE_CHANNEL_ACCESS_TOKEN?.trim()) !== Boolean(value.LINE_USER_ID?.trim())) {
    throw new Error();
  }
  return Object.freeze(Object.fromEntries(KEYS.map(key => [key,
    key.startsWith('LINE_') && !value[key]?.trim() ? undefined : value[key],
  ])));
}

/** Cache a validated secret for this execution environment; failed loads can retry.
 * Selecting a secret reference disables all sensitive environment fallbacks.
 * Provider errors and malformed values never escape in diagnostics.
 */
export function createRuntimeConfigProvider({
  env = process.env, fetchSecret = readSecret, timeoutMs = 1500,
} = {}) {
  const snapshot = { ...env };
  const selected = Object.hasOwn(snapshot, 'CARE_ALERT_SECRET_ARN');
  const legacy = Object.freeze(Object.fromEntries(KEYS.map(key => [key, snapshot[key]])));
  let pending;
  return function getRuntimeConfig() {
    if (!selected) return Promise.resolve(legacy);
    if (pending) return pending;
    const match = /^arn:(aws|aws-cn|aws-us-gov):secretsmanager:([a-z0-9-]+):[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/.exec(snapshot.CARE_ALERT_SECRET_ARN ?? '');
    if (!match || (snapshot.AWS_REGION && snapshot.AWS_REGION !== match[2])) {
      return Promise.reject(new Error('Runtime configuration unavailable.'));
    }
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error()); }, timeoutMs);
    });
    pending = Promise.race([
      Promise.resolve().then(() => fetchSecret({
        secretArn: snapshot.CARE_ALERT_SECRET_ARN, region: match[2], signal: controller.signal,
      })), expired,
    ]).then(validateSecret).catch(() => {
      pending = undefined;
      throw new Error('Runtime configuration unavailable.');
    }).finally(() => clearTimeout(timer));
    return pending;
  };
}
