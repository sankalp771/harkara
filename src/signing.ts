import { createHmac } from 'node:crypto';

/**
 * §4.1–4.5 — Standard Webhooks signing. No proprietary scheme: the test
 * suite's acceptance authority is the official `standardwebhooks`
 * verifier (CLAUDE.md oracle rule). If it rejects us, we are wrong.
 */

export interface WebhookHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

/**
 * Build the three §4.1 headers for one attempt.
 *
 * Signed content is `{id}.{timestamp}.{payload}` (§4.2) — payload being
 * the exact stored bytes frozen at send time. The timestamp is the
 * attempt's own clock (T2: fresh seal per attempt; the id stays stable
 * per §2.1). One signature per active secret, space-separated (§4.5):
 * during rotation a receiver holding EITHER secret accepts.
 */
export function webhookHeaders(
  messageId: string,
  payload: string,
  secrets: readonly string[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): WebhookHeaders {
  if (secrets.length === 0) {
    throw new Error('harkara: cannot sign without at least one active secret (§4.1)');
  }
  const timestamp = String(nowSeconds);
  const signedContent = `${messageId}.${timestamp}.${payload}`;
  const signatures = secrets.map(
    (secret) =>
      `v1,${createHmac('sha256', decodeSecret(secret)).update(signedContent).digest('base64')}`,
  );
  return {
    'webhook-id': messageId,
    'webhook-timestamp': timestamp,
    'webhook-signature': signatures.join(' '),
  };
}

/**
 * §4.5 secrets are `whsec_` + base64. The HMAC key is the DECODED bytes —
 * keying on the ASCII of the whole string is the classic interop bug that
 * verifies against itself and nobody else.
 */
function decodeSecret(secret: string): Buffer {
  if (!secret.startsWith('whsec_')) {
    throw new Error("harkara: endpoint secret must start with 'whsec_' (§4.5)");
  }
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  if (key.length === 0) {
    throw new Error('harkara: endpoint secret decodes to an empty key');
  }
  return key;
}
