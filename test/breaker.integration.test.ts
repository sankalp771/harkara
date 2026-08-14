import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarkara, type Harkara, type HarkaraWorker } from '../src/index.js';
import { createPool } from './helpers/db.js';
import { migrateUp } from './helpers/migrate.js';
import { startReceiver, type Receiver } from './helpers/receiver.js';
import { seedEndpoint, truncateAll, waitUntil } from './helpers/seed.js';

/**
 * Phase 6 — §5.2/§5.3 circuit breaker against real Postgres and a real
 * receiver. State is judged on the endpoint_breakers row and on the wire
 * (what the receiver actually saw), never on internals.
 */

interface BreakerRowSnapshot {
  state: string;
  window_attempts: number;
  window_failures: number;
  cooldown_ms: number | null;
  open_until_ms: number | null;
}

describe('phase 6 circuit breaker', () => {
  let pool: Pool | undefined;
  let receiver: Receiver | undefined;
  let harkara: Harkara;
  const workers: HarkaraWorker[] = [];

  // Tiny, jitter-proof breaker settings; individual tests override.
  const BREAKER = {
    windowMs: 60_000,
    minAttempts: 3,
    failureRate: 0.5,
    cooldownMs: 60_000, // stays open unless a test wants the probe
    maxCooldownMs: 120_000,
  };

  function runWorker(overrides: Record<string, unknown> = {}): HarkaraWorker {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    const w = harkara.startWorker({
      pollIntervalMs: 25,
      reaperIntervalMs: 60_000,
      retrySchedule: Array<number>(8).fill(100),
      breaker: BREAKER,
      ...overrides,
    } as any);
    workers.push(w);
    return w;
  }

  async function breakerRow(endpointId: string): Promise<BreakerRowSnapshot | undefined> {
    const { rows } = await pool!.query<BreakerRowSnapshot>(
      `SELECT state, window_attempts, window_failures, cooldown_ms,
              extract(epoch FROM open_until)::float8 * 1000 AS open_until_ms
       FROM endpoint_breakers WHERE endpoint_id = $1`,
      [endpointId],
    );
    return rows[0];
  }

  function hits(path: string): number {
    return receiver!.requests.filter((r) => r.path === path).length;
  }

  async function sendMany(type: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await harkara.send({ type, payload: { i } });
    }
  }

  async function statuses(endpointId: string): Promise<Record<string, number>> {
    const { rows } = await pool!.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM deliveries WHERE endpoint_id = $1 GROUP BY status`,
      [endpointId],
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
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

  it('§5.2 opens on failure RATE, never backlog size — 50 healthy deliveries trip nothing, 3 failures do', async () => {
    receiver!.behave((req) => (req.path === '/sick' ? { status: 503 } : { status: 200 }));
    const healthyId = await seedEndpoint(pool!, `${receiver!.url}/healthy`, ['healthy.*']);
    const sickId = await seedEndpoint(pool!, `${receiver!.url}/sick`, ['sick.*']);
    await sendMany('healthy.load', 50);
    await sendMany('sick.event', 3);

    runWorker();

    // The sick endpoint trips at the floor (3 attempts, 100% failure)…
    await waitUntil(async () => (await breakerRow(sickId))?.state === 'open');
    // …while 50 successes leave the healthy endpoint's breaker closed:
    // volume is not evidence of sickness.
    await waitUntil(async () => (await statuses(healthyId)).delivered === 50);
    const healthy = await breakerRow(healthyId);
    expect(healthy?.state ?? 'closed').toBe('closed');
    expect(healthy?.window_failures ?? 0).toBe(0);

    // Open means PAUSED, not failed and not dropped (§5.2): the sick
    // deliveries wait as pending, and the wire goes quiet.
    const sickHitsAtTrip = hits('/sick');
    await new Promise((r) => setTimeout(r, 400));
    expect(hits('/sick')).toBe(sickHitsAtTrip);
    const sick = await statuses(sickId);
    expect(sick.pending ?? 0).toBe(3);
    expect(sick.dead ?? 0).toBe(0);
  }, 25_000);

  it('§5.2 volume floor: failures below minAttempts never trip — one failure is not a rate', async () => {
    receiver!.behave(() => ({ status: 503 }));
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/floor`, ['floor.*']);
    await sendMany('floor.event', 1);

    // Schedule [100]: two attempts total, then dead — 2 failures < floor 5.
    runWorker({ retrySchedule: [100], breaker: { ...BREAKER, minAttempts: 5 } });
    await waitUntil(async () => (await statuses(endpointId)).dead === 1);

    const row = await breakerRow(endpointId);
    expect(row?.state).toBe('closed');
    expect(row?.window_failures).toBe(2);
  }, 20_000);

  it('§5.2 half-open sends exactly ONE probe — the backlog does not stampede a recovering endpoint', async () => {
    receiver!.behave(() => ({ status: 503 }));
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/probe`, ['probe.*']);
    await sendMany('probe.event', 6);

    runWorker({ concurrency: 10, breaker: { ...BREAKER, cooldownMs: 600 } });
    await waitUntil(async () => (await breakerRow(endpointId))?.state === 'open');
    const atTrip = hits('/probe');

    // The endpoint recovers, but answers slowly — the probe stays in
    // flight for 400ms while 6 deliveries are pending and hungry.
    receiver!.behave(() => ({ status: 200, delayMs: 400 }));
    await waitUntil(async () => hits('/probe') > atTrip, { timeoutMs: 10_000 });
    expect(hits('/probe')).toBe(atTrip + 1); // the probe, alone
    await new Promise((r) => setTimeout(r, 200)); // probe still in flight
    expect(hits('/probe')).toBe(atTrip + 1); // still alone

    // Probe succeeds → close → drain; serialization is load-bearing
    // (§5.2): never more than one request in flight, even while draining.
    await waitUntil(async () => (await statuses(endpointId)).delivered === 6);
    expect(receiver!.concurrentPeak('/probe')).toBe(1);
  }, 25_000);

  it('§5.2 probe success closes with a clean slate: window reset, cooldown back to base', async () => {
    receiver!.behave(() => ({ status: 503 }));
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/drain`, ['drain.*']);
    await sendMany('drain.event', 8);

    runWorker({ breaker: { ...BREAKER, cooldownMs: 300 } });
    await waitUntil(async () => (await breakerRow(endpointId))?.state === 'open');

    receiver!.behave(() => ({ status: 200 }));
    await waitUntil(async () => (await statuses(endpointId)).delivered === 8);

    const row = await breakerRow(endpointId);
    expect(row?.state).toBe('closed');
    expect(row?.window_failures).toBe(0);
    expect(row?.cooldown_ms).toBeNull();
    expect(receiver!.concurrentPeak('/drain')).toBe(1);
  }, 25_000);

  it('§5.2 every failed probe doubles the cooldown, capped', async () => {
    receiver!.behave(() => ({ status: 503 }));
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/double`, ['double.*']);
    await sendMany('double.event', 1);

    runWorker({
      retrySchedule: Array<number>(12).fill(100),
      breaker: { ...BREAKER, cooldownMs: 400, maxCooldownMs: 1_600 },
    });

    // Trip at 3 failures of the single delivery, base cooldown stamped.
    await waitUntil(async () => (await breakerRow(endpointId))?.state === 'open');
    expect((await breakerRow(endpointId))?.cooldown_ms).toBe(400);

    // Probe 1 fails → 800; probe 2 fails → 1600; probe 3 fails → still
    // 1600 (the cap). Probes are attempts 4/5/6 of the same delivery (T3).
    await waitUntil(async () => (await breakerRow(endpointId))?.cooldown_ms === 800);
    const openUntilAt800 = (await breakerRow(endpointId))?.open_until_ms ?? 0;
    await waitUntil(async () => (await breakerRow(endpointId))?.cooldown_ms === 1_600);
    await waitUntil(async () => {
      const { rows } = await pool!.query<{ attempt_count: number }>(
        `SELECT attempt_count FROM deliveries WHERE endpoint_id = $1`,
        [endpointId],
      );
      return (rows[0]?.attempt_count ?? 0) >= 6;
    });
    const row = await breakerRow(endpointId);
    expect(row?.cooldown_ms).toBe(1_600); // capped, not 3_200
    expect(row?.open_until_ms ?? 0).toBeGreaterThan(openUntilAt800); // but the clock still moved
  }, 25_000);

  it("§5.3 open suspends retry clocks: an outage doesn't burn a message's budget", async () => {
    receiver!.behave(() => ({ status: 503 }));
    const endpointId = await seedEndpoint(pool!, `${receiver!.url}/suspend`, ['suspend.*']);
    await sendMany('suspend.event', 3);

    runWorker({
      retrySchedule: Array<number>(10).fill(100),
      breaker: { ...BREAKER, cooldownMs: 2_500 },
    });
    await waitUntil(async () => (await breakerRow(endpointId))?.state === 'open');

    const frozen = async () =>
      (
        await pool!.query<{ id: string; attempt_count: number; status: string }>(
          `SELECT id, attempt_count, status FROM deliveries WHERE endpoint_id = $1 ORDER BY id`,
          [endpointId],
        )
      ).rows;
    const before = await frozen();
    const hitsBefore = hits('/suspend');

    // Ten would-be 100ms schedule periods pass. Nothing moves: no
    // attempts, no budget burned, everything still pending.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await frozen()).toEqual(before);
    expect(hits('/suspend')).toBe(hitsBefore);
    for (const d of before) expect(d.status).toBe('pending');

    // Recovery: probe (the one exception, T3) then drain — with nearly
    // the whole schedule left. Max would be 11 attempts; ≤4 proves §5.3.
    receiver!.behave(() => ({ status: 200 }));
    await waitUntil(async () => (await statuses(endpointId)).delivered === 3, {
      timeoutMs: 15_000,
    });
    for (const d of await frozen()) expect(d.attempt_count).toBeLessThanOrEqual(4);
  }, 30_000);

  it('T1: config refusals never feed the breaker — no wire, no evidence', async () => {
    // Endpoint with NO secret: every claim is refused before any request
    // (§3.2/§4.1). minAttempts 1 means a single WIRE failure would trip —
    // so staying closed proves refusals aren't fed in.
    const { rows } = await pool!.query<{ id: string }>(
      `INSERT INTO endpoints (url, event_types) VALUES ($1, '{"refuse.*"}') RETURNING id`,
      [`${receiver!.url}/refuse`],
    );
    const endpointId = rows[0]!.id;
    await sendMany('refuse.event', 1);

    runWorker({ retrySchedule: [100], breaker: { ...BREAKER, minAttempts: 1 } });

    // Wait for at least two recorded refusals (attempt_number NULL rows).
    await waitUntil(async () => {
      const { rows: attempts } = await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM delivery_attempts a
         JOIN deliveries d ON d.id = a.delivery_id
         WHERE d.endpoint_id = $1 AND a.attempt_number IS NULL`,
        [endpointId],
      );
      return attempts[0]!.n >= 2;
    });

    expect(await breakerRow(endpointId)).toBeUndefined(); // no row = closed (T5)
    expect(hits('/refuse')).toBe(0);
    expect((await statuses(endpointId)).pending).toBe(1); // still waiting, not dead
  }, 20_000);

  it("§5.1 isolation: one endpoint's open breaker never delays another's deliveries", async () => {
    receiver!.behave((req) => (req.path === '/iso-a' ? { status: 503 } : { status: 200 }));
    const aId = await seedEndpoint(pool!, `${receiver!.url}/iso-a`, ['iso.a']);
    const bId = await seedEndpoint(pool!, `${receiver!.url}/iso-b`, ['iso.b']);
    await sendMany('iso.a', 3);

    runWorker();
    await waitUntil(async () => (await breakerRow(aId))?.state === 'open');

    // With A's circuit open, B's traffic flows at full speed.
    await sendMany('iso.b', 10);
    await waitUntil(async () => (await statuses(bId)).delivered === 10);
    expect((await breakerRow(bId))?.state ?? 'closed').toBe('closed');
    expect((await statuses(aId)).pending).toBe(3); // A still parked, not dead
  }, 25_000);
});
