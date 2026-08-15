import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pinnedRequest, type Resolver } from '../src/egress.js';
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
 * Phase 7 — §9 egress guard against a real worker, real receiver, real
 * Postgres. The SSRF tests run with the opt-ins OFF (the default);
 * everything else in the suite runs with them on, which is itself the
 * regression proof that the opt-ins restore delivery.
 */

describe('phase 7 SSRF guard', () => {
  let pool: Pool | undefined;
  let receiver: Receiver | undefined;
  let harkara: Harkara;
  const workers: HarkaraWorker[] = [];

  const OPEN = { allowInsecureHttp: true, allowPrivateAddresses: true };

  function runWorker(overrides: Partial<WorkerOptions> = {}): HarkaraWorker {
    const w = harkara.startWorker({
      pollIntervalMs: 25,
      reaperIntervalMs: 60_000,
      retrySchedule: [100],
      ssrf: OPEN,
      ...overrides,
    });
    workers.push(w);
    return w;
  }

  function hits(path: string): number {
    return receiver!.requests.filter((r) => r.path === path).length;
  }

  async function refusalRows(
    endpointId: string,
  ): Promise<{ attempt_number: number | null; error: string | null }[]> {
    const { rows } = await pool!.query<{ attempt_number: number | null; error: string | null }>(
      `SELECT a.attempt_number, a.error FROM delivery_attempts a
       JOIN deliveries d ON d.id = a.delivery_id
       WHERE d.endpoint_id = $1 ORDER BY a.id`,
      [endpointId],
    );
    return rows;
  }

  async function deliveryState(endpointId: string): Promise<{ status: string; n: number }[]> {
    const { rows } = await pool!.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM deliveries WHERE endpoint_id = $1 GROUP BY status`,
      [endpointId],
    );
    return rows;
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

  it('§9.1 metadata endpoint refused at delivery: config refusal, never dead, breaker-invisible', async () => {
    const endpointId = await seedEndpoint(pool!, 'http://169.254.169.254/latest/meta-data', [
      'meta.*',
    ]);
    await harkara.send({ type: 'meta.event', payload: { secret: 'not for AWS' } });

    // allowInsecureHttp ON isolates ADDRESS vetting from scheme vetting.
    runWorker({ ssrf: { allowInsecureHttp: true, allowPrivateAddresses: false } });

    await waitUntil(async () => (await refusalRows(endpointId)).length >= 2);
    const rows = await refusalRows(endpointId);
    for (const row of rows) {
      expect(row.attempt_number).toBeNull(); // refusals, not numbered attempts
      expect(row.error).toMatch(/§9\.1/);
      expect(row.error).toMatch(/169\.254\.169\.254/);
    }

    // §3.2 config bucket: parked pending, schedule frozen, never dead…
    const state = await deliveryState(endpointId);
    expect(state.find((s) => s.status === 'dead')).toBeUndefined();
    expect(state.find((s) => s.status === 'delivered')).toBeUndefined();
    const { rows: counts } = await pool!.query<{ attempt_count: number }>(
      `SELECT attempt_count FROM deliveries WHERE endpoint_id = $1`,
      [endpointId],
    );
    expect(counts[0]!.attempt_count).toBe(0);
    // …and invisible to the breaker (Phase 6 T1: no wire, no evidence).
    const { rows: breaker } = await pool!.query(
      `SELECT 1 FROM endpoint_breakers WHERE endpoint_id = $1`,
      [endpointId],
    );
    expect(breaker).toHaveLength(0);
  }, 20_000);

  it('§9.3 https required by default: plain http refused even with private addresses allowed', async () => {
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/needs-https`, ['scheme.*']);
    await harkara.send({ type: 'scheme.event', payload: {} });

    runWorker({ ssrf: { allowInsecureHttp: false, allowPrivateAddresses: true } });

    await waitUntil(async () => (await refusalRows(endpointId)).length >= 1);
    const rows = await refusalRows(endpointId);
    expect(rows[0]!.attempt_number).toBeNull();
    expect(rows[0]!.error).toMatch(/§9\.3/);
    expect(hits('/needs-https')).toBe(0); // nothing ever touched the wire
    expect((await deliveryState(endpointId)).find((s) => s.status === 'dead')).toBeUndefined();
  }, 20_000);

  it('§9.3 both opt-ins restore delivery to a local plain-http receiver', async () => {
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/local-dev`, ['local.*']);
    await harkara.send({ type: 'local.event', payload: {} });

    runWorker(); // OPEN: both opt-ins on

    await waitUntil(async () => {
      const state = await deliveryState(endpointId);
      return state.find((s) => s.status === 'delivered')?.n === 1;
    });
    expect(hits('/local-dev')).toBe(1);
  }, 20_000);

  it('§9.2 the pin is structural: one resolution, the socket gets the vetted address', async () => {
    // A hostname that CANNOT resolve through real DNS (.invalid), with an
    // injected resolver: call 1 says 127.0.0.1 (the receiver), any later
    // call would say a poison address. The request succeeding proves the
    // socket used OUR vetted answer; the counter proves there was no
    // second lookup for a rebinder to win.
    let calls = 0;
    const resolver: Resolver = () => {
      calls += 1;
      return Promise.resolve(
        calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '192.0.2.1', family: 4 }],
      );
    };
    const port = new URL(receiver!.url).port;
    const result = await pinnedRequest(`http://rebind-victim.invalid:${port}/rebind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"probe":true}',
      timeoutMs: 3_000,
      byteCap: 4_096,
      ssrf: OPEN,
      resolver,
    });

    expect(result.kind).toBe('http');
    if (result.kind === 'http') expect(result.statusCode).toBe(200);
    expect(calls).toBe(1); // resolved exactly once — no TOCTOU window exists
    expect(hits('/rebind')).toBe(1);
    // The Host header carried the HOSTNAME, not the pinned IP.
    const req = receiver!.requests.find((r) => r.path === '/rebind');
    expect(req!.headers.host).toBe(`rebind-victim.invalid:${port}`);
  }, 20_000);

  it('§9.2 byte cap is enforced DURING the streamed read — the socket dies at the cap', async () => {
    receiver!.behave(() => ({ status: 200, drip: { chunkBytes: 1_024, intervalMs: 25 } }));
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/firehose`, ['fire.*']);
    await harkara.send({ type: 'fire.event', payload: {} });

    runWorker();

    // T4: the 200 status decides — a capped body is still delivered.
    await waitUntil(async () => {
      const state = await deliveryState(endpointId);
      return state.find((s) => s.status === 'delivered')?.n === 1;
    });
    const { rows } = await pool!.query<{ response_body: string; latency_ms: number }>(
      `SELECT a.response_body, a.latency_ms FROM delivery_attempts a
       JOIN deliveries d ON d.id = a.delivery_id WHERE d.endpoint_id = $1`,
      [endpointId],
    );
    expect(rows[0]!.response_body.length).toBeLessThanOrEqual(4_096);
    // Killed by the BYTE cap (~100ms of dripping), nowhere near the 30s
    // time cap — proof we stopped reading, not just storing.
    expect(rows[0]!.latency_ms).toBeLessThan(5_000);
    await waitUntil(() =>
      Promise.resolve(receiver!.requests.some((r) => r.path === '/firehose' && r.aborted === true)),
    );
  }, 20_000);

  it('§9.2 slow-drip body is killed by the total-time cap; the 200 still decides', async () => {
    receiver!.behave(() => ({ status: 200, drip: { chunkBytes: 1, intervalMs: 200 } }));
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/drip`, ['drip.*']);
    await harkara.send({ type: 'drip.event', payload: {} });

    runWorker({ attemptTimeoutMs: 1_000, visibilityTimeoutMs: 2_000 });

    await waitUntil(async () => {
      const state = await deliveryState(endpointId);
      return state.find((s) => s.status === 'delivered')?.n === 1;
    });
    const { rows } = await pool!.query<{ latency_ms: number }>(
      `SELECT a.latency_ms FROM delivery_attempts a
       JOIN deliveries d ON d.id = a.delivery_id WHERE d.endpoint_id = $1`,
      [endpointId],
    );
    // The attempt ended at the time cap (±scheduling slack), not never.
    expect(rows[0]!.latency_ms).toBeGreaterThanOrEqual(800);
    expect(rows[0]!.latency_ms).toBeLessThan(3_000);
  }, 20_000);

  it('§3.2 boundary: timeout BEFORE the status line stays a retryable network failure', async () => {
    receiver!.behave(() => 'hang');
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/hang`, ['hang.*']);
    await harkara.send({ type: 'hang.event', payload: {} });

    runWorker({
      attemptTimeoutMs: 500,
      visibilityTimeoutMs: 1_000,
      retrySchedule: [100, 60_000],
    });

    // A real, NUMBERED attempt (not a refusal), no status code, and the
    // delivery marches on the schedule instead of parking or dying.
    await waitUntil(async () => (await refusalRows(endpointId)).length >= 1);
    const { rows } = await pool!.query<{
      attempt_number: number | null;
      status_code: number | null;
    }>(
      `SELECT a.attempt_number, a.status_code FROM delivery_attempts a
       JOIN deliveries d ON d.id = a.delivery_id WHERE d.endpoint_id = $1 ORDER BY a.id`,
      [endpointId],
    );
    expect(rows[0]!.attempt_number).toBe(1);
    expect(rows[0]!.status_code).toBeNull();
    await waitUntil(async () => {
      const { rows: d } = await pool!.query<{ attempt_count: number }>(
        `SELECT attempt_count FROM deliveries WHERE endpoint_id = $1`,
        [endpointId],
      );
      return d[0]!.attempt_count >= 1;
    });
  }, 20_000);
});
