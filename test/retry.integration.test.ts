import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarkara, type Harkara, type HarkaraWorker, type WorkerOptions } from '../src/index.js';
import { createPool } from './helpers/db.js';
import { migrateUp } from './helpers/migrate.js';
import { startReceiver, type Receiver } from './helpers/receiver.js';
import { truncateAll, waitUntil } from './helpers/seed.js';

/**
 * Phase 5 — §3.2/§3.3 against a real worker and receiver. Tiny schedules
 * keep wall-clock sane; jitter-tolerant windows, never exact equality.
 */

describe('phase 5 retries and the DLQ', () => {
  let pool: Pool | undefined;
  let receiver: Receiver | undefined;
  let harkara: Harkara;
  const workers: HarkaraWorker[] = [];

  async function addEndpoint(path: string, withSecret = true): Promise<string> {
    const { rows } = await pool!.query<{ id: string }>(
      `INSERT INTO endpoints (url, event_types) VALUES ($1, '{}') RETURNING id`,
      [`${receiver!.url}${path}`],
    );
    if (withSecret) {
      await pool!.query(`INSERT INTO endpoint_secrets (endpoint_id, secret) VALUES ($1, $2)`, [
        rows[0]!.id,
        `whsec_${randomBytes(24).toString('base64')}`,
      ]);
    }
    return rows[0]!.id;
  }

  function runWorker(opts: WorkerOptions = {}): HarkaraWorker {
    const w = harkara.startWorker({ pollIntervalMs: 25, reaperIntervalMs: 60_000, ...opts });
    workers.push(w);
    return w;
  }

  async function deliveryOf(endpointId: string) {
    const { rows } = await pool!.query<{
      id: string;
      status: string;
      attempt_count: number;
      dead_at: string | null;
    }>(`SELECT id, status, attempt_count, dead_at FROM deliveries WHERE endpoint_id = $1`, [
      endpointId,
    ]);
    return rows[0];
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

  it('§3.2 a 404 goes straight to dead: one request, no second chance', async () => {
    receiver!.behave(() => ({ status: 404, body: 'nobody home' }));
    const endpointId = await addEndpoint('/gone');
    await harkara.send({ type: 'invoice.paid', payload: { n: 1 } });

    runWorker({ retrySchedule: [100, 200] });
    await waitUntil(async () => (await deliveryOf(endpointId))?.status === 'dead');

    // Parked with the full forensic trail (§6.1), after exactly one attempt.
    const d = (await deliveryOf(endpointId))!;
    expect(d.attempt_count).toBe(1);
    expect(d.dead_at).not.toBeNull();
    expect(receiver!.requests).toHaveLength(1);

    const { rows: attempts } = await pool!.query<{
      attempt_number: number;
      status_code: number;
      response_body: string;
    }>(`SELECT attempt_number, status_code, response_body FROM delivery_attempts`);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!).toMatchObject({
      attempt_number: 1,
      status_code: 404,
      response_body: 'nobody home',
    });
  });

  it('§3.2/§3.3 a 503 follows the schedule to exhaustion: N+1 attempts, then dead', async () => {
    receiver!.behave(() => ({ status: 503 }));
    const endpointId = await addEndpoint('/down');
    await harkara.send({ type: 'invoice.paid', payload: {} });

    runWorker({ retrySchedule: [200, 400] });
    await waitUntil(async () => (await deliveryOf(endpointId))?.status === 'dead', {
      timeoutMs: 20_000,
    });

    expect(receiver!.requests).toHaveLength(3); // initial + 2 retries
    const d = (await deliveryOf(endpointId))!;
    expect(d.attempt_count).toBe(3);
    expect(d.dead_at).not.toBeNull();

    // Gaps respect the schedule (±20% jitter → lower bounds 160/320ms).
    const [t1, t2, t3] = receiver!.requests.map((r) => r.arrivedAt);
    expect(t2! - t1!).toBeGreaterThanOrEqual(160);
    expect(t3! - t2!).toBeGreaterThanOrEqual(320);
  }, 30_000);

  it('§3.2 Retry-After on 429 overrides the schedule, verbatim', async () => {
    let first = true;
    receiver!.behave(() => {
      if (first) {
        first = false;
        return { status: 429, body: 'slow down', headers: { 'retry-after': '1' } };
      }
      return { status: 200 };
    });
    const endpointId = await addEndpoint('/limited');
    await harkara.send({ type: 'invoice.paid', payload: {} });

    // Schedule says 100ms; the receiver says 1s. The receiver wins.
    runWorker({ retrySchedule: [100, 60_000] });
    await waitUntil(async () => (await deliveryOf(endpointId))?.status === 'delivered', {
      timeoutMs: 15_000,
    });

    const [t1, t2] = receiver!.requests.map((r) => r.arrivedAt);
    expect(t2! - t1!).toBeGreaterThanOrEqual(900);
  }, 20_000);

  it('§3.2 Retry-After on 503 is honored the same way (maintenance-window reality)', async () => {
    let first = true;
    receiver!.behave(() => {
      if (first) {
        first = false;
        return { status: 503, body: 'maintenance', headers: { 'retry-after': '1' } };
      }
      return { status: 200 };
    });
    const endpointId = await addEndpoint('/maintenance');
    await harkara.send({ type: 'invoice.paid', payload: {} });

    runWorker({ retrySchedule: [100, 60_000] });
    await waitUntil(async () => (await deliveryOf(endpointId))?.status === 'delivered', {
      timeoutMs: 15_000,
    });

    const [t1, t2] = receiver!.requests.map((r) => r.arrivedAt);
    expect(t2! - t1!).toBeGreaterThanOrEqual(900);
  }, 20_000);

  it('§3.2 a hostile Retry-After is capped at the maximum backoff step', async () => {
    let first = true;
    receiver!.behave(() => {
      if (first) {
        first = false;
        return { status: 503, headers: { 'retry-after': '9999' } };
      }
      return { status: 200 };
    });
    const endpointId = await addEndpoint('/hostile');
    await harkara.send({ type: 'invoice.paid', payload: {} });

    // Max step 400ms — a 9999s demand must not stall the delivery.
    runWorker({ retrySchedule: [200, 400] });
    await waitUntil(async () => (await deliveryOf(endpointId))?.status === 'delivered', {
      timeoutMs: 10_000,
    });
    const [t1, t2] = receiver!.requests.map((r) => r.arrivedAt);
    expect(t2! - t1!).toBeLessThan(5_000);
  }, 15_000);

  it('§3.3 default schedule: first retry lands in the 10s ± 20% window', async () => {
    receiver!.behave(() => ({ status: 503 }));
    const endpointId = await addEndpoint('/default-sched');
    await harkara.send({ type: 'invoice.paid', payload: {} });

    runWorker(); // default schedule
    await waitUntil(async () => ((await deliveryOf(endpointId))?.attempt_count ?? 0) >= 1);

    const { rows } = await pool!.query<{ delay_ms: number }>(
      `SELECT extract(epoch FROM (next_attempt_at - now())) * 1000 AS delay_ms
       FROM deliveries WHERE endpoint_id = $1`,
      [endpointId],
    );
    // 10s ± 20%, minus the beat between scheduling and this query.
    expect(rows[0]!.delay_ms).toBeGreaterThan(7_000);
    expect(rows[0]!.delay_ms).toBeLessThan(12_500);
  });

  it('§3.2 config bucket: refusals never march toward dead, and fixing config resumes', async () => {
    const endpointId = await addEndpoint('/unconfigured', false); // NO secret
    await harkara.send({ type: 'invoice.paid', payload: { later: true } });

    // Max step 200ms → refusal checks come fast. More refusals than the
    // schedule has steps: misclassification would mean dead by now.
    runWorker({ retrySchedule: [100, 200] });
    await waitUntil(async () => {
      const { rows } = await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM delivery_attempts WHERE attempt_number IS NULL`,
      );
      return rows[0]!.n >= 4;
    });

    const d = (await deliveryOf(endpointId))!;
    expect(d.status).toBe('pending'); // never dead (§3.2 config class)
    expect(d.attempt_count).toBe(0); // schedule position frozen
    expect(receiver!.requests).toHaveLength(0); // zero HTTP, ever

    // Refusal rows are refusals, not numbered attempts (rider 2).
    const { rows: refusals } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM delivery_attempts
       WHERE attempt_number IS NOT NULL`,
    );
    expect(refusals[0]!.n).toBe(0);

    // The operator fixes the config → delivery resumes and succeeds,
    // and the REAL attempt is attempt 1 — no fake numbering before it.
    await pool!.query(`INSERT INTO endpoint_secrets (endpoint_id, secret) VALUES ($1, $2)`, [
      endpointId,
      `whsec_${randomBytes(24).toString('base64')}`,
    ]);
    await waitUntil(async () => (await deliveryOf(endpointId))?.status === 'delivered', {
      timeoutMs: 10_000,
    });
    const { rows: real } = await pool!.query<{ attempt_number: number }>(
      `SELECT attempt_number FROM delivery_attempts WHERE attempt_number IS NOT NULL`,
    );
    expect(real).toHaveLength(1);
    expect(real[0]!.attempt_number).toBe(1);
  }, 20_000);

  it('§3.2 timeouts are retryable: they follow the schedule, not instant death', async () => {
    receiver!.behave(() => 'hang');
    const endpointId = await addEndpoint('/tarpit');
    await harkara.send({ type: 'invoice.paid', payload: {} });

    runWorker({ retrySchedule: [200], attemptTimeoutMs: 300, visibilityTimeoutMs: 60_000 });
    await waitUntil(async () => (await deliveryOf(endpointId))?.status === 'dead', {
      timeoutMs: 15_000,
    });

    // Schedule [200] → 2 total attempts (initial + 1 retry), THEN dead.
    expect(receiver!.requests).toHaveLength(2);
    const { rows } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM delivery_attempts WHERE status_code IS NULL AND error IS NOT NULL`,
    );
    expect(rows[0]!.n).toBe(2);
  }, 20_000);
});
