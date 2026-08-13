import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createHarkara, type Harkara, type HarkaraWorker } from '../src/index.js';
import { createPool } from './helpers/db.js';
import { migrateUp } from './helpers/migrate.js';
import { startReceiver, type Receiver } from './helpers/receiver.js';
import { seedDelivery, seedEndpoint, seedMessage, truncateAll, waitUntil } from './helpers/seed.js';

/**
 * Phase 3 — reaper tests from §8.1–8.2. The whole point: recovery keys on
 * locked_at (when work STARTED), never created_at (when the row was born).
 */

describe('phase 3 reaper', () => {
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
    await truncateAll(pool!);
  });

  afterAll(async () => {
    await receiver.close();
    await pool?.end();
  });

  it('§8.1 stale lock is returned to pending and actually redelivered', async () => {
    receiver.behave(() => ({ status: 200 }));
    const e = await seedEndpoint(pool!, `${receiver.url}/reap`);
    // A crashed worker's leftovers: delivering, locked long ago.
    const deliveryId = await seedDelivery(pool!, await seedMessage(pool!), e, {
      status: 'delivering',
      lockedAtMs: -10_000,
      lockedBy: 'w-dead',
    });

    const w = harkara.startWorker({
      pollIntervalMs: 50,
      reaperIntervalMs: 100,
      attemptTimeoutMs: 1_000,
      visibilityTimeoutMs: 2_000,
    });
    workers.push(w);

    await waitUntil(async () => {
      const { rows } = await pool!.query<{ status: string }>(
        `SELECT status FROM deliveries WHERE id = $1`,
        [deliveryId],
      );
      return rows[0]!.status === 'delivered';
    });

    // The lock changed hands: redelivered by the live worker, not the ghost.
    const { rows } = await pool!.query<{ locked_by: string | null }>(
      `SELECT locked_by FROM deliveries WHERE id = $1`,
      [deliveryId],
    );
    expect(rows[0]!.locked_by).not.toBe('w-dead');
  }, 30_000);

  it('§8.2 the created_at bug, inverted: freshly-claimed OLD row is left alone', async () => {
    receiver.behave(() => ({ status: 200 }));
    const e = await seedEndpoint(pool!, `${receiver.url}/fresh`);

    // Row born an hour ago but claimed JUST NOW by a live (fake) worker.
    // A created_at-keyed reaper would steal it — the old repo's bug.
    const freshClaim = await seedDelivery(pool!, await seedMessage(pool!), e, {
      status: 'delivering',
      lockedAtMs: -100, // locked 100ms ago — fresh
      lockedBy: 'w-alive-elsewhere',
      createdAtMs: -3_600_000, // born an hour ago — ancient
    });
    // Sibling with a genuinely stale lock, same age — MUST be reclaimed.
    const e2 = await seedEndpoint(pool!, `${receiver.url}/stale`);
    const staleClaim = await seedDelivery(pool!, await seedMessage(pool!), e2, {
      status: 'delivering',
      lockedAtMs: -30_000,
      lockedBy: 'w-dead',
      createdAtMs: -3_600_000,
    });

    const w = harkara.startWorker({
      pollIntervalMs: 50,
      reaperIntervalMs: 100,
      attemptTimeoutMs: 2_000,
      visibilityTimeoutMs: 5_000,
    });
    workers.push(w);

    // The stale one gets reaped and delivered...
    await waitUntil(async () => {
      const { rows } = await pool!.query<{ status: string }>(
        `SELECT status FROM deliveries WHERE id = $1`,
        [staleClaim],
      );
      return rows[0]!.status === 'delivered';
    });

    // ...while the fresh claim on the ancient row is untouched: same status,
    // same owner. Row age is not staleness (§8.2).
    const { rows } = await pool!.query<{ status: string; locked_by: string }>(
      `SELECT status, locked_by FROM deliveries WHERE id = $1`,
      [freshClaim],
    );
    expect(rows[0]!.status).toBe('delivering');
    expect(rows[0]!.locked_by).toBe('w-alive-elsewhere');
  }, 30_000);
});
