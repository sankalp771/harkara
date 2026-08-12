import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from './helpers/db.js';
import { migrateDown, migrateUp } from './helpers/migrate.js';

/**
 * Phase 1 — schema tests, written from the clauses BEFORE the migration
 * (CLAUDE.md hard rule). Clauses covered: §1.3 (fan-out rows exist per
 * endpoint), §1a (event_types), §2.4 (idempotency key unique per tenant),
 * §4.5 (many secrets per endpoint), §6.1 (attempt forensics), §6.2 (replay
 * must be insertable), §8.1 (locked_at/locked_by).
 */

const HARKARA_TABLES = [
  'messages',
  'endpoints',
  'endpoint_secrets',
  'deliveries',
  'delivery_attempts',
];

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

async function tableNames(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [HARKARA_TABLES],
  );
  return rows.map((r) => r.table_name).sort();
}

async function newEndpoint(pool: Pool, url = 'https://example.com/hooks'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO endpoints (url, event_types) VALUES ($1, '{}') RETURNING id`,
    [url],
  );
  return rows[0]!.id;
}

async function newMessage(pool: Pool, eventType = 'invoice.paid'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages (event_type, payload) VALUES ($1, '{"n":1}') RETURNING id`,
    [eventType],
  );
  return rows[0]!.id;
}

describe('phase 1 schema', () => {
  let pool: Pool | undefined;

  beforeAll(async () => {
    pool = await createPool();
    await migrateUp();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('migration cycle: up → down leaves nothing → up again is clean', async () => {
    expect(await tableNames(pool!)).toEqual([...HARKARA_TABLES].sort());

    await migrateDown();
    expect(await tableNames(pool!)).toEqual([]);

    await migrateUp();
    expect(await tableNames(pool!)).toEqual([...HARKARA_TABLES].sort());
  });

  it('§6.2 replay-insert: dead rows never block a fresh delivery', async () => {
    const messageId = await newMessage(pool!);
    const endpointId = await newEndpoint(pool!);

    const insertDelivery = (status = 'pending') =>
      pool!.query<{ id: string }>(
        `INSERT INTO deliveries (message_id, endpoint_id, status)
         VALUES ($1, $2, $3) RETURNING id`,
        [messageId, endpointId, status],
      );

    const first = await insertDelivery();

    // Exactly one LIVE delivery per (message, endpoint): duplicate rejected.
    await expect(insertDelivery()).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

    // The old repo's bug: once dead, a hard unique constraint blocked replay
    // forever. The partial index must allow a fresh row after death.
    await pool!.query(`UPDATE deliveries SET status = 'dead' WHERE id = $1`, [
      first.rows[0]!.id,
    ]);
    const replay = await insertDelivery();
    expect(replay.rows[0]!.id).not.toBe(first.rows[0]!.id);

    // Any number of dead rows may coexist (multiple exhausted replays).
    await pool!.query(`UPDATE deliveries SET status = 'dead' WHERE id = $1`, [
      replay.rows[0]!.id,
    ]);
    await expect(insertDelivery('dead')).resolves.toBeDefined();

    const { rows } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM deliveries WHERE message_id = $1 AND endpoint_id = $2`,
      [messageId, endpointId],
    );
    expect(rows[0]!.n).toBe(3);
  });

  it('§2.4 idempotency key is unique per tenant, ON CONFLICT behaves', async () => {
    const insert = (tenant: string | null, key: string) =>
      pool!.query(
        `INSERT INTO messages (tenant_id, event_type, payload, idempotency_key)
         VALUES ($1, 'order.created', '{}', $2)
         ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
         DO NOTHING`,
        [tenant, key],
      );

    // Same tenant + same key → second insert is a no-op, one row survives.
    await insert('t1', 'k-1');
    await insert('t1', 'k-1');
    const { rows: t1 } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE tenant_id = 't1' AND idempotency_key = 'k-1'`,
    );
    expect(t1[0]!.n).toBe(1);

    // Single-tenant callers have tenant_id NULL. Plain UNIQUE treats
    // NULL ≠ NULL and would let duplicates through — NULLS NOT DISTINCT
    // must close that hole.
    await insert(null, 'k-2');
    await insert(null, 'k-2');
    const { rows: nt } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE tenant_id IS NULL AND idempotency_key = 'k-2'`,
    );
    expect(nt[0]!.n).toBe(1);

    // Without ON CONFLICT the duplicate is a hard unique violation.
    await expect(
      pool!.query(
        `INSERT INTO messages (tenant_id, event_type, payload, idempotency_key)
         VALUES ('t1', 'order.created', '{}', 'k-1')`,
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

    // Different tenants may reuse the same key freely.
    await insert('t2', 'k-1');
    const { rows: t2 } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE idempotency_key = 'k-1'`,
    );
    expect(t2[0]!.n).toBe(2);
  });

  it('endpoints: no global UNIQUE(url) — two tenants, one receiver', async () => {
    const a = await newEndpoint(pool!, 'https://shared.example.com/hook');
    const b = await newEndpoint(pool!, 'https://shared.example.com/hook');
    expect(a).not.toBe(b);
  });

  it('§4.5 endpoint_secrets: many secrets per endpoint, active = not revoked', async () => {
    const endpointId = await newEndpoint(pool!);
    await pool!.query(
      `INSERT INTO endpoint_secrets (endpoint_id, secret) VALUES ($1, 'whsec_old'), ($1, 'whsec_new')`,
      [endpointId],
    );
    await pool!.query(
      `UPDATE endpoint_secrets SET revoked_at = now() WHERE endpoint_id = $1 AND secret = 'whsec_old'`,
      [endpointId],
    );
    const { rows } = await pool!.query<{ secret: string }>(
      `SELECT secret FROM endpoint_secrets WHERE endpoint_id = $1 AND revoked_at IS NULL`,
      [endpointId],
    );
    expect(rows.map((r) => r.secret)).toEqual(['whsec_new']);
  });

  it('§8.1 deliveries carry locked_at/locked_by for the reaper', async () => {
    const messageId = await newMessage(pool!);
    const endpointId = await newEndpoint(pool!);
    await pool!.query(
      `INSERT INTO deliveries (message_id, endpoint_id) VALUES ($1, $2)`,
      [messageId, endpointId],
    );

    const { rowCount } = await pool!.query(
      `UPDATE deliveries SET locked_at = now(), locked_by = 'worker-1'
       WHERE message_id = $1 AND endpoint_id = $2 AND locked_at IS NULL`,
      [messageId, endpointId],
    );
    expect(rowCount).toBe(1);
  });

  it('deliveries.status is constrained to the four states', async () => {
    const messageId = await newMessage(pool!);
    const endpointId = await newEndpoint(pool!);
    await expect(
      pool!.query(
        `INSERT INTO deliveries (message_id, endpoint_id, status) VALUES ($1, $2, 'exploded')`,
        [messageId, endpointId],
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('§6.1 delivery_attempts records the forensic trail', async () => {
    const messageId = await newMessage(pool!);
    const endpointId = await newEndpoint(pool!);
    const { rows } = await pool!.query<{ id: string }>(
      `INSERT INTO deliveries (message_id, endpoint_id) VALUES ($1, $2) RETURNING id`,
      [messageId, endpointId],
    );
    await pool!.query(
      `INSERT INTO delivery_attempts (delivery_id, attempt_number, status_code, response_body, latency_ms)
       VALUES ($1, 1, 503, 'Service Unavailable', 412)`,
      [rows[0]!.id],
    );
    // NULL status_code = timeout / connection error, allowed by design.
    await pool!.query(
      `INSERT INTO delivery_attempts (delivery_id, attempt_number, status_code, error)
       VALUES ($1, 2, NULL, 'ETIMEDOUT')`,
      [rows[0]!.id],
    );
    const { rows: attempts } = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM delivery_attempts WHERE delivery_id = $1`,
      [rows[0]!.id],
    );
    expect(attempts[0]!.n).toBe(2);
  });
});
