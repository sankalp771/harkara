import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { Webhook } from 'standardwebhooks';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarkara, type Harkara, type HarkaraWorker } from '../src/index.js';
import { createPool } from './helpers/db.js';
import { migrateUp } from './helpers/migrate.js';
import { startReceiver, type ReceivedRequest, type Receiver } from './helpers/receiver.js';
import { truncateAll, waitUntil } from './helpers/seed.js';

/**
 * Phase 4 — end-to-end signing tests: real worker, real HTTP receiver,
 * official standardwebhooks verifier as the oracle on captured wire
 * traffic. Clauses: §4.1 (three headers, always), §4.3 (timestamp inside
 * the seal), §4.5 (rotation), §2.1 (id stable across attempts), plus the
 * T1 ruling (no active secret → refuse, never send unsigned).
 */

function makeSecret(): string {
  return `whsec_${randomBytes(24).toString('base64')}`;
}

function oracleHeaders(req: ReceivedRequest): Record<string, string> {
  return {
    'webhook-id': String(req.headers['webhook-id']),
    'webhook-timestamp': String(req.headers['webhook-timestamp']),
    'webhook-signature': String(req.headers['webhook-signature']),
  };
}

describe('phase 4 signing on the wire', () => {
  let pool: Pool | undefined;
  let receiver: Receiver | undefined;
  let harkara: Harkara;
  const workers: HarkaraWorker[] = [];

  async function addEndpoint(path: string, secrets: string[]): Promise<string> {
    const { rows } = await pool!.query<{ id: string }>(
      `INSERT INTO endpoints (url, event_types) VALUES ($1, '{}') RETURNING id`,
      [`${receiver!.url}${path}`],
    );
    for (const secret of secrets) {
      await pool!.query(`INSERT INTO endpoint_secrets (endpoint_id, secret) VALUES ($1, $2)`, [
        rows[0]!.id,
        secret,
      ]);
    }
    return rows[0]!.id;
  }

  function runWorker(): HarkaraWorker {
    const w = harkara.startWorker({ pollIntervalMs: 50, reaperIntervalMs: 60_000 });
    workers.push(w);
    return w;
  }

  beforeAll(async () => {
    pool = await createPool();
    await migrateUp();
    await truncateAll(pool);
    receiver = await startReceiver();
    harkara = createHarkara({ pool });
  });

  afterEach(async () => {
    while (workers.length > 0) await workers.pop()?.stop();
    await truncateAll(pool!);
    receiver!.requests.length = 0;
    receiver!.behave(() => ({ status: 200 }));
  });

  afterAll(async () => {
    await receiver?.close();
    await pool?.end();
  });

  it('§4.1 every delivery carries the three headers and the oracle accepts the wire bytes', async () => {
    const secret = makeSecret();
    await addEndpoint('/signed', [secret]);
    const { messageId } = await harkara.send({ type: 'invoice.paid', payload: { n: 1 } });

    runWorker();
    await receiver!.waitForRequests(1);
    const req = receiver!.requests[0]!;

    expect(req.headers['webhook-id']).toBe(messageId);
    expect(Number(req.headers['webhook-timestamp'])).toBeGreaterThan(Date.now() / 1000 - 300);
    expect(String(req.headers['webhook-signature'])).toMatch(/^v1,/);

    // The oracle judges the EXACT bytes that crossed the socket.
    const oracle = new Webhook(secret);
    expect(oracle.verify(req.body, oracleHeaders(req))).toEqual({ n: 1 });
  });

  it('§4.5 rotation: two active secrets, one header, both single-key receivers accept', async () => {
    const oldSecret = makeSecret();
    const newSecret = makeSecret();
    await addEndpoint('/rotating', [oldSecret, newSecret]);
    await harkara.send({ type: 'invoice.paid', payload: { rotating: true } });

    runWorker();
    await receiver!.waitForRequests(1);
    const req = receiver!.requests[0]!;

    expect(String(req.headers['webhook-signature']).split(' ')).toHaveLength(2);

    // Mid-rotation reality: one receiver still holds only the old secret,
    // another already holds only the new. The SAME request satisfies both.
    expect(new Webhook(oldSecret).verify(req.body, oracleHeaders(req))).toEqual({
      rotating: true,
    });
    expect(new Webhook(newSecret).verify(req.body, oracleHeaders(req))).toEqual({
      rotating: true,
    });
  });

  it('revocation: a revoked secret stops signing immediately and its holder now rejects', async () => {
    const oldSecret = makeSecret();
    const newSecret = makeSecret();
    const endpointId = await addEndpoint('/revoked', [oldSecret, newSecret]);
    await pool!.query(
      `UPDATE endpoint_secrets SET revoked_at = now() WHERE endpoint_id = $1 AND secret = $2`,
      [endpointId, oldSecret],
    );
    await harkara.send({ type: 'invoice.paid', payload: { post: 'rotation' } });

    runWorker();
    await receiver!.waitForRequests(1);
    const req = receiver!.requests[0]!;

    expect(String(req.headers['webhook-signature']).split(' ')).toHaveLength(1);
    expect(() => new Webhook(oldSecret).verify(req.body, oracleHeaders(req))).toThrow();
    expect(new Webhook(newSecret).verify(req.body, oracleHeaders(req))).toEqual({
      post: 'rotation',
    });
  });

  it('§4.3 editing is free, re-sealing is impossible: tampered wire traffic fails', async () => {
    const secret = makeSecret();
    await addEndpoint('/tamper', [secret]);
    await harkara.send({ type: 'invoice.paid', payload: { amount: 10 } });

    runWorker();
    await receiver!.waitForRequests(1);
    const req = receiver!.requests[0]!;
    const oracle = new Webhook(secret);

    // Freshened timestamp — the §4.3 replay move.
    const headers = oracleHeaders(req);
    const freshened = {
      ...headers,
      'webhook-timestamp': String(Number(headers['webhook-timestamp']) + 120),
    };
    expect(() => oracle.verify(req.body, freshened)).toThrow();

    // Edited body — the amount bump.
    expect(() => oracle.verify(req.body.replace('10', '99'), headers)).toThrow();
  });

  it('§2.1 retries keep the webhook-id, refresh the timestamp, and every attempt seals valid', async () => {
    const secret = makeSecret();
    await addEndpoint('/flaky', [secret]);
    receiver!.behave((req) =>
      req.path === '/flaky' && receiver!.requests.filter((r) => r.path === '/flaky').length === 1
        ? { status: 503 }
        : { status: 200 },
    );
    const { messageId } = await harkara.send({ type: 'invoice.paid', payload: { retry: true } });

    runWorker();
    // Attempt 2 happens after the interim 5s backoff.
    await receiver!.waitForRequests(2, 20_000);
    const [first, second] = receiver!.requests;

    expect(first!.headers['webhook-id']).toBe(messageId);
    expect(second!.headers['webhook-id']).toBe(messageId); // stable across attempts

    const t1 = Number(first!.headers['webhook-timestamp']);
    const t2 = Number(second!.headers['webhook-timestamp']);
    expect(t2).toBeGreaterThanOrEqual(t1); // fresh seal per attempt (T2)

    const oracle = new Webhook(secret);
    expect(oracle.verify(first!.body, oracleHeaders(first!))).toEqual({ retry: true });
    expect(oracle.verify(second!.body, oracleHeaders(second!))).toEqual({ retry: true });
  }, 30_000);

  it('T1: an endpoint with no active secret is refused — never delivered unsigned', async () => {
    const endpointId = await addEndpoint('/naked', []);
    await harkara.send({ type: 'invoice.paid', payload: { must: 'not arrive' } });

    runWorker();
    // The refusal is recorded as a failed attempt with no HTTP traffic.
    await waitUntil(async () => {
      const { rows } = await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM delivery_attempts da
         JOIN deliveries d ON d.id = da.delivery_id
         WHERE d.endpoint_id = $1 AND da.status_code IS NULL AND da.error ILIKE '%secret%'`,
        [endpointId],
      );
      return rows[0]!.n >= 1;
    });

    expect(receiver!.requests.filter((r) => r.path === '/naked')).toHaveLength(0);
    const { rows } = await pool!.query<{ status: string }>(
      `SELECT status FROM deliveries WHERE endpoint_id = $1`,
      [endpointId],
    );
    expect(rows[0]!.status).toBe('pending'); // interim retry until Phase 5 classifies
  });
});
