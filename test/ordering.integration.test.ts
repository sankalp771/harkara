import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createHarkara,
  type Harkara,
  type HarkaraWorker,
  type WorkerOptions,
} from '../src/index.js';
import { createPool } from './helpers/db.js';
import { migrateUp } from './helpers/migrate.js';
import { startReceiver, type Receiver } from './helpers/receiver.js';
import { seedEndpoint, truncateAll, waitUntil } from './helpers/seed.js';

/**
 * Phase 8 — §7 ordering, proven only against real Postgres: the guard is
 * a claim-query clause, so the receiver's observed order IS the oracle.
 */

describe('phase 8 ordering', () => {
  let pool: Pool | undefined;
  let receiver: Receiver | undefined;
  let harkara: Harkara;
  const workers: HarkaraWorker[] = [];

  function runWorker(overrides: Partial<WorkerOptions> = {}): HarkaraWorker {
    const w = harkara.startWorker({
      pollIntervalMs: 25,
      reaperIntervalMs: 60_000,
      retrySchedule: [5_000], // sick elders wait, healthy traffic flows
      ssrf: { allowInsecureHttp: true, allowPrivateAddresses: true },
      ...overrides,
    });
    workers.push(w);
    return w;
  }

  /** Parsed bodies seen on a path, in arrival order. */
  function seen(path: string): Record<string, unknown>[] {
    return receiver!.requests
      .filter((r) => r.path === path)
      .map((r) => JSON.parse(r.body) as Record<string, unknown>);
  }

  async function deliveredCount(endpointId: string): Promise<number> {
    const { rows } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM deliveries WHERE endpoint_id = $1 AND status = 'delivered'`,
      [endpointId],
    );
    return rows[0]!.n;
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

  it('§7.1 one key delivers in exact send order', async () => {
    receiver!.behave(() => ({ status: 200, delayMs: 15 }));
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/inorder`, ['inorder.*']);
    for (let i = 0; i < 8; i++) {
      await harkara.send({ type: 'inorder.event', payload: { i }, orderingKey: 'K' });
    }

    runWorker({ concurrency: 10 });
    await waitUntil(async () => (await deliveredCount(endpointId)) === 8);

    expect(seen('/inorder').map((b) => b.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  }, 25_000);

  it('§7.1 siblings born in ONE transaction deliver in send() call order (T1: sequence, not clock)', async () => {
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/same-tx`, ['sametx.*']);

    // Same caller transaction — identical created_at to the microsecond;
    // only the sequence can order these.
    const client: PoolClient = await pool!.connect();
    try {
      await client.query('BEGIN');
      await harkara.send(
        { type: 'sametx.event', payload: { call: 1 }, orderingKey: 'TX' },
        { tx: client },
      );
      await harkara.send(
        { type: 'sametx.event', payload: { call: 2 }, orderingKey: 'TX' },
        { tx: client },
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    runWorker();
    await waitUntil(async () => (await deliveredCount(endpointId)) === 2);
    expect(seen('/same-tx').map((b) => b.call)).toEqual([1, 2]);
  }, 20_000);

  it('§7.1 a younger sibling never jumps a retrying elder — and blocking is per-KEY, not per-endpoint', async () => {
    receiver!.behave((req) =>
      req.body.includes('"who":"sick"') ? { status: 503 } : { status: 200 },
    );
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/jump`, ['jump.*']);

    await harkara.send({ type: 'jump.event', payload: { who: 'sick' }, orderingKey: 'J' });
    await harkara.send({ type: 'jump.event', payload: { who: 'blocked' }, orderingKey: 'J' });
    await harkara.send({ type: 'jump.event', payload: { who: 'free-nokey' } });
    await harkara.send({ type: 'jump.event', payload: { who: 'free-otherkey' }, orderingKey: 'L' });

    runWorker();

    // The elder fails once into its 5s backoff; the unkeyed and other-key
    // messages flow around it while its own younger sibling waits.
    await waitUntil(async () => (await deliveredCount(endpointId)) === 2);
    await new Promise((r) => setTimeout(r, 600));

    const whos = seen('/jump').map((b) => b.who);
    expect(whos).toContain('sick'); // elder was attempted
    expect(whos).toContain('free-nokey');
    expect(whos).toContain('free-otherkey');
    expect(whos).not.toContain('blocked'); // §7.1: zero queue-jumping
    const { rows } = await pool!.query<{ status: string }>(
      `SELECT d.status FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE m.payload LIKE '%blocked%'`,
    );
    expect(rows[0]!.status).toBe('pending');
  }, 20_000);

  it('§7.2 death unblocks: the younger waits only as long as the elder lives', async () => {
    receiver!.behave((req) =>
      req.body.includes('"who":"sick"') ? { status: 404 } : { status: 200 },
    );
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/death`, ['death.*']);

    await harkara.send({ type: 'death.event', payload: { who: 'sick' }, orderingKey: 'D' });
    await harkara.send({ type: 'death.event', payload: { who: 'younger' }, orderingKey: 'D' });

    runWorker();
    await waitUntil(async () => (await deliveredCount(endpointId)) === 1);

    // Elder attempted first (the guard held while it lived), now dead;
    // the younger delivered only after the death.
    expect(seen('/death').map((b) => b.who)).toEqual(['sick', 'younger']);
    const { rows } = await pool!.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM deliveries WHERE endpoint_id = $1 GROUP BY status`,
      [endpointId],
    );
    expect(Object.fromEntries(rows.map((r) => [r.status, r.n]))).toEqual({
      dead: 1,
      delivered: 1,
    });
  }, 20_000);

  it('§7.2 replay is out-of-order vs the past and re-enters at the BACK of its key (T4)', async () => {
    receiver!.behave((req) =>
      req.body.includes('"who":"sick"') ? { status: 404 } : { status: 200 },
    );
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/replayed`, ['replayed.*']);

    await harkara.send({ type: 'replayed.event', payload: { who: 'sick' }, orderingKey: 'R' });
    await harkara.send({ type: 'replayed.event', payload: { who: 'younger' }, orderingKey: 'R' });

    runWorker();
    await waitUntil(async () => (await deliveredCount(endpointId)) === 1);

    // Heal, replay the corpse: it delivers AFTER the younger (out of
    // order by construction) on a fresh row carrying the key with a
    // HIGHER seq than every sibling — the back of the queue.
    receiver!.behave(() => ({ status: 200 }));
    const { rows: dead } = await pool!.query<{ id: string }>(
      `SELECT id FROM deliveries WHERE endpoint_id = $1 AND status = 'dead'`,
      [endpointId],
    );
    const { replayed } = await harkara.replay({ deliveryId: dead[0]!.id });
    expect(replayed).toBe(1);
    await waitUntil(async () => (await deliveredCount(endpointId)) === 2);

    expect(seen('/replayed').map((b) => b.who)).toEqual(['sick', 'younger', 'sick']);
    const { rows: seqs } = await pool!.query<{ ordering_key: string | null; seq: string }>(
      `SELECT ordering_key, seq FROM deliveries WHERE endpoint_id = $1 AND status <> 'dead'
       ORDER BY seq`,
      [endpointId],
    );
    expect(seqs.every((r) => r.ordering_key === 'R')).toBe(true);
    const { rows: fresh } = await pool!.query<{ max_is_replay: boolean }>(
      `SELECT (SELECT max(seq) FROM deliveries WHERE endpoint_id = $1) =
              (SELECT max(seq) FROM deliveries WHERE endpoint_id = $1 AND status = 'delivered'
               AND created_at = (SELECT max(created_at) FROM deliveries WHERE endpoint_id = $1))
              AS max_is_replay`,
      [endpointId],
    );
    expect(fresh[0]!.max_is_replay).toBe(true);
  }, 20_000);

  it('§7.1 unkeyed messages never block each other', async () => {
    receiver!.behave((req) =>
      req.body.includes('"who":"sick"') ? { status: 503 } : { status: 200 },
    );
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/nulls`, ['nulls.*']);

    await harkara.send({ type: 'nulls.event', payload: { who: 'sick' } }); // no key
    await harkara.send({ type: 'nulls.event', payload: { who: 'younger' } }); // no key

    runWorker();
    // The younger delivers while the elder sits in its 5s backoff:
    // NULL keys carry no ordering promise at all.
    await waitUntil(async () => (await deliveredCount(endpointId)) === 1);
    expect(seen('/nulls').map((b) => b.who)).toContain('younger');
  }, 20_000);

  it('§7.1 blocking is per-endpoint: a key blocked on A flows on B', async () => {
    receiver!.behave((req) =>
      req.path === '/xa' && req.body.includes('"i":1') ? { status: 503 } : { status: 200 },
    );
    const aId = await seedEndpoint(pool!, `${receiver!.url}/xa`, ['xkey.*']);
    const bId = await seedEndpoint(pool!, `${receiver!.url}/xb`, ['xkey.*']);

    // Both messages fan out to BOTH endpoints, same key.
    await harkara.send({ type: 'xkey.event', payload: { i: 1 }, orderingKey: 'X' });
    await harkara.send({ type: 'xkey.event', payload: { i: 2 }, orderingKey: 'X' });

    runWorker();
    // B delivers both, in order; A's elder retries and blocks A's younger.
    await waitUntil(async () => (await deliveredCount(bId)) === 2);
    expect(seen('/xb').map((b) => b.i)).toEqual([1, 2]);
    await new Promise((r) => setTimeout(r, 400));
    expect(seen('/xa').filter((b) => b.i === 2)).toHaveLength(0);
    expect(await deliveredCount(aId)).toBe(0);
  }, 20_000);

  it('§7.1-scope, pinned: two overlapping acceptances have no defined mutual order — an uncommitted elder does not block', async () => {
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/scope`, ['scope.*']);

    // Connection A: elder inserted (lower seq) but NOT committed — its
    // acceptance has not happened, so the guard cannot and must not see it.
    const clientA: PoolClient = await pool!.connect();
    try {
      await clientA.query('BEGIN');
      await harkara.send(
        { type: 'scope.event', payload: { who: 'elder' }, orderingKey: 'S' },
        { tx: clientA },
      );

      // Connection B (autocommit): younger, higher seq, accepted NOW.
      await harkara.send({ type: 'scope.event', payload: { who: 'younger' }, orderingKey: 'S' });

      runWorker();
      // The younger delivers while the elder is still invisible…
      await waitUntil(async () => (await deliveredCount(endpointId)) === 1);
      expect(seen('/scope').map((b) => b.who)).toEqual(['younger']);

      // …then the elder commits (acceptance), becomes visible, delivers.
      await clientA.query('COMMIT');
    } finally {
      clientA.release();
    }
    await waitUntil(async () => (await deliveredCount(endpointId)) === 2);
    expect(seen('/scope').map((b) => b.who)).toEqual(['younger', 'elder']);

    // The pinned scope: the LOWER seq delivered LATER, and that is the
    // contract working as amended — order is only promised between
    // acceptances that do not overlap (§7.1).
    const { rows } = await pool!.query<{ who: string; seq: string }>(
      `SELECT m.payload::jsonb->>'who' AS who, d.seq::text AS seq
       FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.endpoint_id = $1 ORDER BY d.seq`,
      [endpointId],
    );
    expect(rows.map((r) => r.who)).toEqual(['elder', 'younger']);
  }, 20_000);
});
