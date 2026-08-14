import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createHarkara, type HarkaraWorker } from '../src/index.js';
import { createPool } from './helpers/db.js';
import { migrateUp } from './helpers/migrate.js';
import { startReceiver, type Receiver } from './helpers/receiver.js';
import { truncateAll, waitUntil } from './helpers/seed.js';

/**
 * Phase 3 — the REBUILD_PLAN load test: two workers, 10k deliveries,
 * ZERO double-claims. Healthy run = no failures and no reaps, so any
 * excess HTTP request or duplicate attempt row IS a double-claim.
 */

const ENDPOINTS = 100;
const MESSAGES = 100; // × fan-out to all 100 endpoints = 10 000 deliveries
const TOTAL = ENDPOINTS * MESSAGES;

describe('phase 3 throughput: two workers, 10k deliveries, zero double-claims', () => {
  let pool: Pool | undefined;
  let receiver: Receiver;
  const workers: HarkaraWorker[] = [];

  beforeAll(async () => {
    pool = await createPool();
    await migrateUp();
    await truncateAll(pool);
    receiver = await startReceiver();
  });

  afterAll(async () => {
    while (workers.length > 0) await workers.pop()?.stop();
    await receiver.close();
    await pool?.end();
  });

  it('delivers all 10k exactly once across two competing workers', async () => {
    receiver.behave(() => ({ status: 200 }));

    // Bulk-seed in SQL: 100 endpoints, 100 messages, full cross-join fan-out.
    await pool!.query(
      `INSERT INTO endpoints (url, event_types)
       SELECT $1 || '/e' || i, '{}' FROM generate_series(1, $2::int) i`,
      [receiver.url, ENDPOINTS],
    );
    // §4.1/T1 (Phase 4): unsecreted endpoints are refused delivery.
    // Deterministic core-SQL secret (no pgcrypto needed) — load test, not
    // a crypto test; the oracle tests own signature correctness.
    await pool!.query(
      `INSERT INTO endpoint_secrets (endpoint_id, secret)
       SELECT id, 'whsec_' || encode(convert_to('throughput-load-secret', 'UTF8'), 'base64')
       FROM endpoints`,
    );
    await pool!.query(
      `INSERT INTO messages (event_type, payload)
       SELECT 'load.test', '{"i":' || i || '}' FROM generate_series(1, $1::int) i`,
      [MESSAGES],
    );
    await pool!.query(
      `INSERT INTO deliveries (message_id, endpoint_id)
       SELECT m.id, e.id FROM messages m CROSS JOIN endpoints e`,
    );

    const harkara = createHarkara({ pool: pool! });
    workers.push(
      harkara.startWorker({ workerId: 'w-1', concurrency: 25, pollIntervalMs: 20 }),
      harkara.startWorker({ workerId: 'w-2', concurrency: 25, pollIntervalMs: 20 }),
    );

    await waitUntil(
      async () => {
        const { rows } = await pool!.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM deliveries WHERE status = 'delivered'`,
        );
        return rows[0]!.n === TOTAL;
      },
      { timeoutMs: 150_000, intervalMs: 500 },
    );

    // Exactly one HTTP request per delivery — an extra request is a
    // double-claim wearing a trench coat.
    expect(receiver.requests.length).toBe(TOTAL);

    // Exactly one attempt row per delivery, and both workers participated.
    const { rows: dupes } = await pool!.query(
      `SELECT delivery_id FROM delivery_attempts GROUP BY delivery_id HAVING count(*) > 1`,
    );
    expect(dupes).toHaveLength(0);
    const { rows: attempts } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM delivery_attempts`,
    );
    expect(attempts[0]!.n).toBe(TOTAL);
    // Stronger than a count: the exact set. If any OTHER worker id shows
    // up here, a worker leaked out of another test file and claimed our
    // rows — the id itself names the culprit.
    const { rows: claimers } = await pool!.query<{ locked_by: string }>(
      `SELECT DISTINCT locked_by FROM deliveries ORDER BY locked_by`,
    );
    expect(claimers.map((r) => r.locked_by)).toEqual(['w-1', 'w-2']);
  }, 180_000);
});
