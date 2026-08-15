import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createHarkara, type Harkara, type HarkaraWorker } from '../src/index.js';
import { createPool } from './helpers/db.js';
import { migrateUp } from './helpers/migrate.js';
import { startReceiver, type Receiver } from './helpers/receiver.js';
import { seedDelivery, seedEndpoint, seedMessage, truncateAll, waitUntil } from './helpers/seed.js';

/**
 * Phase 3 — worker loop tests, written from §5.1 (isolation, bounded
 * concurrency) and §3.1 (attempt timeout) BEFORE the implementation.
 * Real Postgres, real HTTP receiver — no mocked fetch.
 */

describe('phase 3 worker loop', () => {
  let pool: Pool | undefined;
  let receiver: Receiver;
  let harkara: Harkara;
  const workers: HarkaraWorker[] = [];

  beforeAll(async () => {
    pool = await createPool();
    await migrateUp();
    receiver = await startReceiver();
    harkara = createHarkara({ pool });
  });

  afterEach(async () => {
    while (workers.length > 0) await workers.pop()?.stop();
    receiver.behave(() => ({ status: 200 }));
    await truncateAll(pool!);
  });

  afterAll(async () => {
    await receiver.close();
    await pool?.end();
  });

  function startWorker(opts: Parameters<Harkara['startWorker']>[0] = {}): HarkaraWorker {
    const w = harkara.startWorker({
      pollIntervalMs: 50,
      reaperIntervalMs: 60_000,
      ssrf: { allowInsecureHttp: true, allowPrivateAddresses: true },
      ...opts,
    });
    workers.push(w);
    return w;
  }

  it('§5.1 one slow endpoint does not delay other endpoints (no head-of-line blocking)', async () => {
    receiver.behave((req) =>
      req.path === '/slow' ? { status: 200, delayMs: 3000 } : { status: 200 },
    );

    const slow = await seedEndpoint(pool!, `${receiver.url}/slow`);
    const slowMsg = await seedMessage(pool!);
    // The slow delivery is OLDEST — a FIFO worker would head-of-line block on it.
    await seedDelivery(pool!, slowMsg, slow, { nextAttemptAtMs: -60_000 });

    const fastIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = await seedEndpoint(pool!, `${receiver.url}/fast${String(i)}`);
      fastIds.push(await seedDelivery(pool!, await seedMessage(pool!), e));
    }

    const started = Date.now();
    startWorker({ concurrency: 10 });

    // All five fast deliveries complete while the slow one is still in flight.
    await waitUntil(async () => {
      const { rows } = await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM deliveries WHERE id = ANY($1) AND status = 'delivered'`,
        [fastIds],
      );
      return rows[0]!.n === 5;
    });
    const fastDone = Date.now() - started;
    expect(fastDone).toBeLessThan(2500); // slow endpoint sleeps 3000ms

    const { rows } = await pool!.query<{ status: string }>(
      `SELECT status FROM deliveries WHERE endpoint_id = $1`,
      [slow],
    );
    expect(rows[0]!.status).toBe('delivering'); // still in flight, not blocking
  }, 30_000);

  it('§5.1 per-endpoint concurrency is 1 GLOBALLY — even across two workers', async () => {
    receiver.behave(() => ({ status: 200, delayMs: 250 }));

    const serial = await seedEndpoint(pool!, `${receiver.url}/serial`);
    for (let i = 0; i < 3; i++) {
      await seedDelivery(pool!, await seedMessage(pool!), serial);
    }
    // Sibling endpoints prove parallelism still exists globally.
    for (let i = 0; i < 3; i++) {
      const e = await seedEndpoint(pool!, `${receiver.url}/par${String(i)}`);
      await seedDelivery(pool!, await seedMessage(pool!), e);
    }

    startWorker({ workerId: 'w-a', concurrency: 10 });
    startWorker({ workerId: 'w-b', concurrency: 10 });

    await waitUntil(async () => {
      const { rows } = await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM deliveries WHERE status = 'delivered'`,
      );
      return rows[0]!.n === 6;
    });

    // The invariant of the phase: never two simultaneous requests to one
    // endpoint, no matter how many workers or how much global capacity.
    expect(receiver.concurrentPeak('/serial')).toBe(1);
  }, 30_000);

  it('failure path (interim, pre-§3.2): 503 records the attempt and returns to pending', async () => {
    receiver.behave(() => ({ status: 503, body: 'nope' }));

    const e = await seedEndpoint(pool!, `${receiver.url}/fail`);
    const deliveryId = await seedDelivery(pool!, await seedMessage(pool!), e);

    startWorker({ concurrency: 2 });
    await waitUntil(async () => {
      const { rows } = await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM delivery_attempts WHERE delivery_id = $1`,
        [deliveryId],
      );
      return rows[0]!.n >= 1;
    });

    const { rows: att } = await pool!.query<{ status_code: number; response_body: string }>(
      `SELECT status_code, response_body FROM delivery_attempts WHERE delivery_id = $1 ORDER BY id LIMIT 1`,
      [deliveryId],
    );
    expect(att[0]!.status_code).toBe(503);
    expect(att[0]!.response_body).toBe('nope');

    await waitUntil(async () => {
      const { rows } = await pool!.query<{ status: string }>(
        `SELECT status FROM deliveries WHERE id = $1`,
        [deliveryId],
      );
      return rows[0]!.status === 'pending';
    });
    const { rows: d } = await pool!.query<{ attempt_count: number; future: boolean }>(
      `SELECT attempt_count, next_attempt_at > now() AS future FROM deliveries WHERE id = $1`,
      [deliveryId],
    );
    expect(d[0]!.attempt_count).toBeGreaterThanOrEqual(1);
    expect(d[0]!.future).toBe(true);
  }, 30_000);

  it('§3.1 attempt timeout: a hung receiver becomes a failed attempt, not a stuck worker', async () => {
    receiver.behave(() => 'hang');

    const e = await seedEndpoint(pool!, `${receiver.url}/hang`);
    const deliveryId = await seedDelivery(pool!, await seedMessage(pool!), e);

    startWorker({ concurrency: 2, attemptTimeoutMs: 500, visibilityTimeoutMs: 60_000 });

    await waitUntil(async () => {
      const { rows } = await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM delivery_attempts WHERE delivery_id = $1`,
        [deliveryId],
      );
      return rows[0]!.n >= 1;
    });

    const { rows } = await pool!.query<{ status_code: number | null; error: string | null }>(
      `SELECT status_code, error FROM delivery_attempts WHERE delivery_id = $1 ORDER BY id LIMIT 1`,
      [deliveryId],
    );
    expect(rows[0]!.status_code).toBeNull(); // no HTTP response happened
    expect(rows[0]!.error).toBeTruthy();
  }, 30_000);

  it('graceful stop: in-flight attempt finishes, nothing left mid-claim', async () => {
    receiver.behave(() => ({ status: 200, delayMs: 800 }));

    const e = await seedEndpoint(pool!, `${receiver.url}/slowok`);
    const deliveryId = await seedDelivery(pool!, await seedMessage(pool!), e);

    const worker = startWorker({ concurrency: 2 });
    await receiver.waitForRequests(1);
    await worker.stop(); // must wait out the 800ms response

    const { rows } = await pool!.query<{ status: string }>(
      `SELECT status FROM deliveries WHERE id = $1`,
      [deliveryId],
    );
    expect(rows[0]!.status).toBe('delivered');
    const { rows: stuck } = await pool!.query(
      `SELECT 1 FROM deliveries WHERE status = 'delivering'`,
    );
    expect(stuck).toHaveLength(0);
  }, 30_000);

  it('response bodies are stored truncated, never whole (CLAUDE.md)', async () => {
    receiver.behave(() => ({ status: 200, body: 'x'.repeat(100_000) }));

    const e = await seedEndpoint(pool!, `${receiver.url}/big`);
    const deliveryId = await seedDelivery(pool!, await seedMessage(pool!), e);

    startWorker({ concurrency: 2 });
    await waitUntil(async () => {
      const { rows } = await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM delivery_attempts WHERE delivery_id = $1`,
        [deliveryId],
      );
      return rows[0]!.n >= 1;
    });

    const { rows } = await pool!.query<{ len: number }>(
      `SELECT length(response_body)::int AS len FROM delivery_attempts WHERE delivery_id = $1`,
      [deliveryId],
    );
    expect(rows[0]!.len).toBeLessThanOrEqual(4096);
  }, 30_000);
});
