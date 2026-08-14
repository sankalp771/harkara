import { createHmac, randomBytes } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';
import { webhookHeaders } from '../src/signing.js';

/**
 * Phase 4 — signing unit tests. THE ORACLE RULE (CLAUDE.md): Harkara's
 * signatures are verified by the official standardwebhooks package,
 * never by our own verifier. If the oracle rejects us, we are wrong.
 */

function makeSecret(): string {
  return `whsec_${randomBytes(24).toString('base64')}`;
}

const PAYLOAD = '{"invoice":42,"total":"19.99"}';
const MSG_ID = '0192a1b2-0000-7000-8000-4242deadbeef';

function headersFor(secrets: string[], nowSeconds?: number) {
  return webhookHeaders(MSG_ID, PAYLOAD, secrets, nowSeconds);
}

describe('§4.2 signing vs the official oracle', () => {
  it('the oracle accepts what Harkara signs', () => {
    const secret = makeSecret();
    const headers = headersFor([secret]);

    expect(headers['webhook-id']).toBe(MSG_ID);
    expect(headers['webhook-signature']).toMatch(/^v1,/);

    const oracle = new Webhook(secret);
    // verify() throws on a bad seal; returning the parsed payload = accepted.
    expect(oracle.verify(PAYLOAD, headers)).toEqual(JSON.parse(PAYLOAD));
  });

  it('a tampered payload fails against the oracle', () => {
    const secret = makeSecret();
    const headers = headersFor([secret]);
    const oracle = new Webhook(secret);
    expect(() => oracle.verify('{"invoice":42,"total":"99.99"}', headers)).toThrow();
  });

  it('§4.5 two active secrets: one header, two signatures, EITHER key verifies', () => {
    const oldSecret = makeSecret();
    const newSecret = makeSecret();
    const headers = headersFor([oldSecret, newSecret]);

    const signatures = headers['webhook-signature'].split(' ');
    expect(signatures).toHaveLength(2);
    for (const sig of signatures) expect(sig).toMatch(/^v1,/);

    // The receiver mid-rotation holds ONE of the two. Both worlds verify.
    expect(new Webhook(oldSecret).verify(PAYLOAD, headers)).toEqual(JSON.parse(PAYLOAD));
    expect(new Webhook(newSecret).verify(PAYLOAD, headers)).toEqual(JSON.parse(PAYLOAD));
  });

  it('§4.3 the timestamp is inside the seal: editing it breaks verification', () => {
    const secret = makeSecret();
    const headers = headersFor([secret]);
    const oracle = new Webhook(secret);

    const freshened = {
      ...headers,
      'webhook-timestamp': String(Number(headers['webhook-timestamp']) + 60),
    };
    expect(() => oracle.verify(PAYLOAD, freshened)).toThrow();
  });

  it('malformed secrets throw before anything is signed', () => {
    expect(() => headersFor(['no-prefix-at-all'])).toThrow(/whsec_/);
    expect(() => headersFor(['whsec_'])).toThrow(); // empty key
    expect(() => headersFor([])).toThrow(); // no secrets is a caller bug here
  });

  it('the HMAC key is the base64-DECODED bytes, not the ASCII of the string', () => {
    // Interop pin: an implementation that keys HMAC on the raw ASCII of
    // the whsec_ string verifies against itself and nobody else. The
    // oracle decodes — so only the decoded-key signature passes it.
    const keyBytes = randomBytes(24);
    const secret = `whsec_${keyBytes.toString('base64')}`;
    const now = 1_700_000_000;
    const headers = headersFor([secret], now);

    const signedContent = `${MSG_ID}.${String(now)}.${PAYLOAD}`;
    const expected = `v1,${createHmac('sha256', keyBytes).update(signedContent).digest('base64')}`;
    expect(headers['webhook-signature']).toBe(expected);
  });
});
