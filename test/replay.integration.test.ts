import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { Webhook } from 'standardwebhooks';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarkara, type Harkara, type HarkaraWorker } from '../src/index.js';
import { createPool } from './helpers/db.js';
import { migrateUp } from './helpers/migrate.js';
import { startReceiver, type Receiver } from './helpers/receiver.js';
import { truncateAll, waitUntil } from './helpers/seed.js';

/**
 * Phase 5 — §6.2/§6.3 replay. Replay is a human/API decision, NEVER
 * automatic; it creates a FRESH delivery for the same message (same
 * webhook-id — receiver dedup still applies) with a fresh seal.
 */

describe('phase 5 replay', () => {
  let pool: Pool | undefined;
  let receiver: Receiver | undefined;
  let harkara: Harkara;
  const workers: HarkaraWorker[] = [];

  async function addEndpoint(path: string, secret: string): Promise<string> {
    const { rows } = await pool!.query<{ id: string }>(
      `INSERT INTO endpoints (url, event_types) VALUES ($1, '{}') RETURNING id`,
      [`${receiver!.url}${path}`],
    );
    await pool!.query(`INSERT INTO endpoint_secrets (endpoint_id, secret) VALUES ($1, $2)`, [
      rows[0]!.id,
      secret,
    ]);
    return rows[0]!.id;
  }

  function makeSecret(): string {
    return `whsec_${randomBytes(24).toString('base64')}`;
  }

  function runWorker(): HarkaraWorker {
    const w = harkara.startWorker({
      pollIntervalMs: 25,
      reaperIntervalMs: 60_000,
      retrySchedule: [100],
      ssrf: { allowInsecureHttp: true, allowPrivateAddresses: true },
    });
    workers.push(w);
    return w;
  }

  async function killDelivery(endpointId: string): Promise<{ deliveryId: string }> {
    // Fastest honest route to a dead row: the receiver 404s (§3.2
    // non-retryable), the worker does the killing.
    await waitUntil(async () => {
      const { rows } = await pool!.query<{ status: string }>(
        `SELECT status FROM deliveries WHERE endpoint_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [endpointId],
      );
      return rows[0]?.status === 'dead';
    });
    const { rows } = await pool!.query<{ id: string }>(
      `SELECT id FROM deliveries WHERE endpoint_id = $1 AND status = 'dead'
       ORDER BY created_at DESC LIMIT 1`,
      [endpointId],
    );
    return { deliveryId: rows[0]!.id };
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

  it('§6.2 per-delivery replay: same webhook-id, fresh seal, dead row untouched', async () => {
    const secret = makeSecret();
    receiver!.behave(() => ({ status: 404 }));
    const endpointId = await addEndpoint('/resurrect', secret);
    const { messageId } = await harkara.send({ type: 'invoice.paid', payload: { again: true } });

    runWorker();
    const { deliveryId } = await killDelivery(endpointId);

    receiver!.behave(() => ({ status: 200 }));
    const { replayed } = await harkara.replay({ deliveryId });
    expect(replayed).toBe(1);

    await waitUntil(async () => {
      const { rows } = await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM deliveries WHERE endpoint_id = $1 AND status = 'delivered'`,
        [endpointId],
      );
      return rows[0]!.n === 1;
    });

    // Fresh delivery row; the corpse is parked, not resurrected (§6.1).
    const { rows: all } = await pool!.query<{ id: string; status: string }>(
      `SELECT id, status FROM deliveries WHERE endpoint_id = $1`,
      [endpointId],
    );
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === deliveryId)!.status).toBe('dead');

    // Same webhook-id on the wire (receiver dedup collapses it, §2.2);
    // fresh timestamp; the new seal verifies against the oracle.
    const [original, replayedReq] = receiver!.requests;
    expect(original!.headers['webhook-id']).toBe(messageId);
    expect(replayedReq!.headers['webhook-id']).toBe(messageId);
    expect(Number(replayedReq!.headers['webhook-timestamp'])).toBeGreaterThanOrEqual(
      Number(original!.headers['webhook-timestamp']),
    );
    expect(
      new Webhook(secret).verify(replayedReq!.body, {
        'webhook-id': String(replayedReq!.headers['webhook-id']),
        'webhook-timestamp': String(replayedReq!.headers['webhook-timestamp']),
        'webhook-signature': String(replayedReq!.headers['webhook-signature']),
      }),
    ).toEqual({ again: true });
  }, 20_000);

  it('replaying a live delivery throws, an empty filter throws', async () => {
    const endpointId = await addEndpoint('/alive', makeSecret());
    await harkara.send({ type: 'invoice.paid', payload: {} });
    const { rows } = await pool!.query<{ id: string }>(
      `SELECT id FROM deliveries WHERE endpoint_id = $1`,
      [endpointId],
    );

    await expect(harkara.replay({ deliveryId: rows[0]!.id })).rejects.toThrow(/dead/);
    await expect(harkara.replay({})).rejects.toThrow();
  });

  it('§6.3 per-endpoint replay resurrects every dead delivery of that endpoint', async () => {
    receiver!.behave(() => ({ status: 410 }));
    const endpointId = await addEndpoint('/mass-grave', makeSecret());
    await harkara.send({ type: 'invoice.paid', payload: { i: 1 } });
    await harkara.send({ type: 'invoice.paid', payload: { i: 2 } });
    await harkara.send({ type: 'invoice.paid', payload: { i: 3 } });

    runWorker();
    await waitUntil(async () => {
      const { rows } = await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM deliveries WHERE endpoint_id = $1 AND status = 'dead'`,
        [endpointId],
      );
      return rows[0]!.n === 3;
    });

    receiver!.behave(() => ({ status: 200 }));
    const { replayed } = await harkara.replay({ endpointId });
    expect(replayed).toBe(3);

    await waitUntil(async () => {
      const { rows } = await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM deliveries WHERE endpoint_id = $1 AND status = 'delivered'`,
        [endpointId],
      );
      return rows[0]!.n === 3;
    });
  }, 20_000);

  it("§6.3 time-range replay: the 'down Tuesday 2-4pm' case picks only the bracketed dead", async () => {
    receiver!.behave(() => ({ status: 404 }));
    const endpointId = await addEndpoint('/tuesday', makeSecret());
    const m1 = await harkara.send({ type: 'invoice.paid', payload: { hour: 1 } });
    const m2 = await harkara.send({ type: 'invoice.paid', payload: { hour: 2 } });
    const m3 = await harkara.send({ type: 'invoice.paid', payload: { hour: 3 } });

    runWorker();
    await waitUntil(async () => {
      const { rows } = await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM deliveries WHERE endpoint_id = $1 AND status = 'dead'`,
        [endpointId],
      );
      return rows[0]!.n === 3;
    });
    while (workers.length > 0) await workers.pop()?.stop();

    // Stagger the times of death: 3h, 2h, 1h ago.
    for (const [messageId, hoursAgo] of [
      [m1.messageId, 3],
      [m2.messageId, 2],
      [m3.messageId, 1],
    ] as const) {
      await pool!.query(
        `UPDATE deliveries SET dead_at = now() - ($2::int * interval '1 hour')
         WHERE message_id = $1`,
        [messageId, hoursAgo],
      );
    }

    receiver!.behave(() => ({ status: 200 }));
    const { replayed } = await harkara.replay({
      endpointId,
      diedAfter: new Date(Date.now() - 2.5 * 3_600_000),
      diedBefore: new Date(Date.now() - 1.5 * 3_600_000),
    });
    expect(replayed).toBe(1);

    // Only the middle message got a fresh delivery.
    const { rows } = await pool!.query<{ message_id: string }>(
      `SELECT message_id FROM deliveries WHERE endpoint_id = $1 AND status = 'pending'`,
      [endpointId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message_id).toBe(m2.messageId);
  }, 20_000);

  it('§6.2 replay is NEVER automatic: dead rows + running worker + time = zero traffic', async () => {
    receiver!.behave(() => ({ status: 404 }));
    const endpointId = await addEndpoint('/stays-dead', makeSecret());
    await harkara.send({ type: 'invoice.paid', payload: {} });

    runWorker(); // schedule [100] — many periods will pass
    await killDelivery(endpointId);
    const requestsAtDeath = receiver!.requests.length;

    receiver!.behave(() => ({ status: 200 })); // even a healthy receiver
    await new Promise((r) => setTimeout(r, 1_000));

    expect(receiver!.requests).toHaveLength(requestsAtDeath);
    const { rows } = await pool!.query<{ status: string }>(
      `SELECT status FROM deliveries WHERE endpoint_id = $1`,
      [endpointId],
    );
    expect(rows[0]!.status).toBe('dead');
  }, 20_000);

  it('replay respects the live-delivery arbiter: an existing live row blocks silently', async () => {
    receiver!.behave(() => ({ status: 404 }));
    const endpointId = await addEndpoint('/collision', makeSecret());
    await harkara.send({ type: 'invoice.paid', payload: {} });

    runWorker();
    const { deliveryId } = await killDelivery(endpointId);
    while (workers.length > 0) await workers.pop()?.stop();

    // First replay creates the live row…
    receiver!.behave(() => ({ status: 200 }));
    const first = await harkara.replay({ deliveryId });
    expect(first.replayed).toBe(1);

    // …the second replay of the same corpse hits the partial unique
    // index (one LIVE delivery per message+endpoint) and backs off.
    const second = await harkara.replay({ deliveryId });
    expect(second.replayed).toBe(0);
  }, 20_000);
});
