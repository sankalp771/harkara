import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createHarkara, type HarkaraWorker } from '../src/index.js';
import { createPool, getConnectionString } from './helpers/db.js';
import { migrateUp } from './helpers/migrate.js';
import { startReceiver, type Receiver } from './helpers/receiver.js';
import { seedDelivery, seedEndpoint, seedMessage, truncateAll, waitUntil } from './helpers/seed.js';

/**
 * §8.3 — recovery MAY duplicate, MUST NOT lose. A REAL worker process is
 * SIGKILLed mid-delivery (no cleanup, no shutdown hooks — the lock is
 * genuinely stranded), then a live worker's reaper must recover it.
 * A simulated "pretend we crashed" flag would be exactly the mock-shaped
 * hole the rules exist to block.
 */

const TSX = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs');
const CHILD = path.resolve('test', 'helpers', 'worker-child.ts');

function spawnWorkerChild(env: Record<string, string>): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, CHILD], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.on('error', reject);
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.includes('READY')) resolve(child);
    });
    setTimeout(() => reject(new Error('worker-child did not become READY')), 30_000);
  });
}

describe('phase 3 crash recovery (§8.3)', () => {
  let pool: Pool | undefined;
  let receiver: Receiver;
  let liveWorker: HarkaraWorker | undefined;

  beforeAll(async () => {
    pool = await createPool();
    await migrateUp();
    await truncateAll(pool);
    receiver = await startReceiver();
  });

  afterAll(async () => {
    await liveWorker?.stop();
    await receiver.close();
    await pool?.end();
  });

  it('kill -9 mid-delivery: redelivered, never lost', async () => {
    // Phase A: the receiver hangs, so the child is caught mid-attempt.
    receiver.behave(() => 'hang');
    const endpointId = await seedEndpoint(pool!, `${receiver.url}/crash`);
    const deliveryId = await seedDelivery(pool!, await seedMessage(pool!), endpointId);

    const child = await spawnWorkerChild({
      DATABASE_URL: await getConnectionString(),
      ATTEMPT_TIMEOUT_MS: '60000', // attempt must outlive the SIGKILL moment
    });

    // The request arriving at the receiver = the child is mid-delivery,
    // holding the claim.
    await receiver.waitForRequests(1);
    const { rows: mid } = await pool!.query<{ status: string; locked_by: string }>(
      `SELECT status, locked_by FROM deliveries WHERE id = $1`,
      [deliveryId],
    );
    expect(mid[0]!.status).toBe('delivering');
    expect(mid[0]!.locked_by).toBe('crash-child');

    // Phase B: the process dies for real. No shutdown path runs.
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));

    // The row still exists, still locked by a ghost — stranded, not lost.
    const { rows: stranded } = await pool!.query<{ status: string }>(
      `SELECT status FROM deliveries WHERE id = $1`,
      [deliveryId],
    );
    expect(stranded[0]!.status).toBe('delivering');

    // Phase C: receiver heals; a live worker with a short visibility
    // timeout reaps the stale lock and redelivers.
    receiver.behave(() => ({ status: 200 }));
    const harkara = createHarkara({ pool: pool! });
    liveWorker = harkara.startWorker({
      workerId: 'rescuer',
      pollIntervalMs: 50,
      reaperIntervalMs: 100,
      visibilityTimeoutMs: 1_500,
    });

    await waitUntil(
      async () => {
        const { rows } = await pool!.query<{ status: string }>(
          `SELECT status FROM deliveries WHERE id = $1`,
          [deliveryId],
        );
        return rows[0]!.status === 'delivered';
      },
      { timeoutMs: 30_000 },
    );

    // §8.3 both halves: duplicates allowed (the receiver saw the hung
    // attempt AND the successful one)...
    expect(receiver.requests.filter((r) => r.path === '/crash').length).toBeGreaterThanOrEqual(2);
    // ...loss forbidden (the delivery ended delivered, by the rescuer).
    const { rows: final } = await pool!.query<{ locked_by: string | null }>(
      `SELECT locked_by FROM deliveries WHERE id = $1`,
      [deliveryId],
    );
    expect(final[0]!.locked_by).toBe('rescuer');
  }, 60_000);
});
