import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarkara, type Harkara, type HarkaraWorker } from '../src/index.js';
import { createPool } from './helpers/db.js';
import { migrateUp } from './helpers/migrate.js';
import { seedEndpoint, truncateAll, waitUntil } from './helpers/seed.js';

/**
 * Phase 9 — §2.2/§2.3 pinned with the DOCS SNIPPET's own logic: the
 * dedup example the docs tell receivers to paste is TESTED code, not
 * sample code. Sender guarantees ≥1 delivery (§2.1 stable webhook-id),
 * receiver collapses N deliveries to 1 processing, both still 2xx —
 * together: effectively-once.
 */

describe('phase 9 receiver dedup (the §2.3 copy-paste example)', () => {
  let pool: Pool | undefined;
  let harkara: Harkara;
  let server: Server | undefined;
  let receiverUrl: string;
  const workers: HarkaraWorker[] = [];
  const processed: Record<string, unknown>[] = [];
  let responses = 0;

  beforeAll(async () => {
    pool = await createPool();
    await migrateUp();
    await truncateAll(pool);
    harkara = createHarkara({ pool });

    // The RECEIVER's side of the deal: its own dedup table in its own
    // database (here the same PG instance for convenience — this is
    // consumer schema, not harkara schema).
    await pool.query(`DROP TABLE IF EXISTS processed_webhooks`);
    await pool.query(
      `CREATE TABLE processed_webhooks (
         webhook_id text PRIMARY KEY,
         processed_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    // ——— the docs snippet, verbatim logic (docs/guides/receivers.md) ———
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        void (async () => {
          const webhookId = String(req.headers['webhook-id']);
          const { rows } = await pool!.query(
            `INSERT INTO processed_webhooks (webhook_id) VALUES ($1)
             ON CONFLICT (webhook_id) DO NOTHING
             RETURNING webhook_id`,
            [webhookId],
          );
          if (rows.length === 1) {
            // First time we've seen this id — process the event.
            processed.push(JSON.parse(body) as Record<string, unknown>);
          }
          // Duplicate or not: 2xx. A non-2xx would send a correctly
          // collapsed duplicate to the DLQ and feed the breaker (§3.1).
          res.statusCode = 200;
          res.end();
          responses += 1;
        })();
      });
    });
    // ————————————————————————————————————————————————————————————————
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    receiverUrl = `http://127.0.0.1:${String(address.port)}`;
  }, 60_000);

  afterAll(async () => {
    while (workers.length > 0) await workers.pop()?.stop();
    await new Promise<void>((resolve) => {
      if (server) {
        server.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
    await pool?.query(`DROP TABLE IF EXISTS processed_webhooks`);
    if (pool) await truncateAll(pool);
    await pool?.end();
  });

  it('N deliveries with one webhook-id collapse to ONE processing, all answered 2xx', async () => {
    const endpointId = await seedEndpoint(pool!, `${receiverUrl}/hook`, ['dedup.*']);
    await harkara.send({ type: 'dedup.event', payload: { order: 42 } });

    const worker = harkara.startWorker({
      pollIntervalMs: 25,
      reaperIntervalMs: 60_000,
      ssrf: { allowInsecureHttp: true, allowPrivateAddresses: true },
    });
    workers.push(worker);

    await waitUntil(async () => {
      const { rows } = await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM deliveries WHERE endpoint_id = $1 AND status = 'delivered'`,
        [endpointId],
      );
      return rows[0]!.n === 1;
    });

    // §1.2's crash window, reproduced deliberately: the worker delivered
    // but "crashed" before recording success — recovery MUST resend
    // (§8.3: duplicates allowed, loss never). Flip the row back to
    // pending; the same webhook-id goes out again.
    await pool!.query(
      `UPDATE deliveries SET status = 'pending', locked_at = NULL, locked_by = NULL,
              next_attempt_at = now(), attempt_count = 0
       WHERE endpoint_id = $1`,
      [endpointId],
    );
    await waitUntil(() => Promise.resolve(responses >= 2));
    await waitUntil(async () => {
      const { rows } = await pool!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM deliveries WHERE endpoint_id = $1 AND status = 'delivered'`,
        [endpointId],
      );
      return rows[0]!.n === 1;
    });

    // Two requests on the wire, both 2xx (the resend is 'delivered', not
    // dead) — and exactly ONE processing. Effectively-once (§2.3).
    expect(responses).toBe(2);
    expect(processed).toEqual([{ order: 42 }]);
    const { rows: dedup } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM processed_webhooks`,
    );
    expect(dedup[0]!.n).toBe(1);
  }, 30_000);
});
