import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createHarkara, type Harkara } from '../src/index.js';
import { createPool, getConnectionString } from './helpers/db.js';
import { migrateUp } from './helpers/migrate.js';

/**
 * Phase 2 — send() tests, written from the clauses BEFORE the
 * implementation. Clauses: §1.3 (persist-then-resolve, caller-tx join),
 * §1a.2 (fan-out in the same tx), §1a.4 (tenant-strict matching),
 * §2.1 (stable id), §2.4 (idempotency key).
 */

async function addEndpoint(
  pool: Pool,
  opts: { url?: string; eventTypes?: string[]; tenantId?: string | null } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO endpoints (url, event_types, tenant_id) VALUES ($1, $2, $3) RETURNING id`,
    [opts.url ?? 'https://example.com/hook', opts.eventTypes ?? [], opts.tenantId ?? null],
  );
  return rows[0]!.id;
}

async function deliveryEndpoints(pool: Pool, messageId: string): Promise<string[]> {
  const { rows } = await pool.query<{ endpoint_id: string }>(
    `SELECT endpoint_id FROM deliveries WHERE message_id = $1`,
    [messageId],
  );
  return rows.map((r) => r.endpoint_id).sort();
}

describe('phase 2 send()', () => {
  let pool: Pool | undefined;
  let observer: Pool | undefined; // second connection pool — the outside world
  let harkara: Harkara;

  beforeAll(async () => {
    pool = await createPool();
    await migrateUp();
    // Each test creates its own endpoints; clear whatever earlier suites left.
    await pool.query(
      'TRUNCATE delivery_attempts, deliveries, endpoint_secrets, endpoints, messages',
    );
    observer = new Pool({ connectionString: await getConnectionString() });
    harkara = createHarkara({ pool });
  });

  afterAll(async () => {
    await observer?.end();
    await pool?.end();
  });

  it('§1.3 without tx: persisted and visible to the world before the promise resolves', async () => {
    const endpointId = await addEndpoint(pool!, { eventTypes: ['order.created'] });

    const { messageId, duplicate } = await harkara.send({
      type: 'order.created',
      payload: { orderId: 42 },
    });

    expect(duplicate).toBe(false);
    // Visible from a DIFFERENT connection => durably committed, not just
    // uncommitted local state (persist-then-resolve).
    const { rows } = await observer!.query(
      `SELECT event_type, payload FROM messages WHERE id = $1`,
      [messageId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe('order.created');
    expect(await deliveryEndpoints(observer!, messageId)).toEqual([endpointId]);
  });

  it('§1.3 caller tx rolled back: nothing exists — the event was never accepted', async () => {
    await addEndpoint(pool!, { eventTypes: ['order.cancelled'] });

    const client: PoolClient = await pool!.connect();
    let messageId: string;
    try {
      await client.query('BEGIN');
      ({ messageId } = await harkara.send(
        { type: 'order.cancelled', payload: { orderId: 7 } },
        { tx: client },
      ));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const { rows } = await pool!.query(`SELECT 1 FROM messages WHERE id = $1`, [messageId!]);
    expect(rows).toHaveLength(0);
    const { rows: dels } = await pool!.query(`SELECT 1 FROM deliveries WHERE message_id = $1`, [
      messageId!,
    ]);
    expect(dels).toHaveLength(0);
  });

  it('§1.3 caller tx: invisible before THEIR commit, visible after — send() joins, never acks', async () => {
    await addEndpoint(pool!, { eventTypes: ['user.updated'] });

    const client: PoolClient = await pool!.connect();
    try {
      await client.query('BEGIN');
      const { messageId } = await harkara.send(
        { type: 'user.updated', payload: { userId: 1 } },
        { tx: client },
      );

      // send() has resolved, but acceptance belongs to the caller's COMMIT:
      // the outside world must see nothing yet.
      const before = await observer!.query(`SELECT 1 FROM messages WHERE id = $1`, [messageId]);
      expect(before.rows).toHaveLength(0);

      await client.query('COMMIT');

      const after = await observer!.query(`SELECT 1 FROM messages WHERE id = $1`, [messageId]);
      expect(after.rows).toHaveLength(1);
    } finally {
      client.release();
    }
  });

  it('§1a.2 fan-out: one delivery per matching endpoint, in the same tx', async () => {
    const exact = await addEndpoint(pool!, { eventTypes: ['invoice.paid'] });
    const glob = await addEndpoint(pool!, { eventTypes: ['invoice.*'] });
    const catchAll = await addEndpoint(pool!, { eventTypes: [] });
    await addEndpoint(pool!, { eventTypes: ['user.*'] }); // non-matching

    const { messageId } = await harkara.send({ type: 'invoice.paid', payload: {} });

    expect(await deliveryEndpoints(pool!, messageId)).toEqual([exact, glob, catchAll].sort());
  });

  it('§1a.4 tenant-strict: no cross-tenant fan-out in either direction', async () => {
    const mine = await addEndpoint(pool!, { tenantId: 't-acme', eventTypes: [] });
    await addEndpoint(pool!, { tenantId: 't-other', eventTypes: [] }); // other tenant
    await addEndpoint(pool!, { tenantId: null, eventTypes: [] }); // single-tenant NULL

    // Tenant message reaches only its own tenant's endpoints — not other
    // tenants, and not NULL endpoints (no firehose, §1a.4).
    const { messageId } = await harkara.send({
      type: 'invoice.paid',
      payload: {},
      tenantId: 't-acme',
    });
    expect(await deliveryEndpoints(pool!, messageId)).toEqual([mine]);

    // And a NULL-tenant message must not leak into any tenant's endpoints.
    const { messageId: nullMsg } = await harkara.send({ type: 'invoice.paid', payload: {} });
    const nullTargets = await deliveryEndpoints(pool!, nullMsg);
    expect(nullTargets).not.toContain(mine);
  });

  it('§2.4 idempotency: same key returns the SAME messageId, creates nothing new', async () => {
    await addEndpoint(pool!, { eventTypes: ['payment.settled'] });

    const first = await harkara.send({
      type: 'payment.settled',
      payload: { amount: 100 },
      idempotencyKey: 'settle-100',
    });
    const before = await pool!.query<{ n: number }>(`SELECT count(*)::int AS n FROM deliveries`);

    const second = await harkara.send({
      type: 'payment.settled',
      payload: { amount: 100 },
      idempotencyKey: 'settle-100',
    });

    expect(second.messageId).toBe(first.messageId); // same webhook-id (§2.1)
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    const msgs = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE idempotency_key = 'settle-100'`,
    );
    expect(msgs.rows[0]!.n).toBe(1);
    const after = await pool!.query<{ n: number }>(`SELECT count(*)::int AS n FROM deliveries`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n); // no new fan-out
  });

  it('§2.1/§4.2 prep: stored payload is byte-identical to the serialization at send time', async () => {
    const payload = { b: 2, a: 1, nested: { z: [3, 2, 1] }, s: 'héllo…' };
    const { messageId } = await harkara.send({ type: 'audit.logged', payload });

    const { rows } = await pool!.query<{ payload: string }>(
      `SELECT payload FROM messages WHERE id = $1`,
      [messageId],
    );
    expect(rows[0]!.payload).toBe(JSON.stringify(payload));
  });

  it('rejects before touching the DB: unserializable payload persists nothing', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const before = await pool!.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages`);
    await expect(harkara.send({ type: 'boom', payload: circular })).rejects.toThrow();
    const after = await pool!.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('rejects an empty event type', async () => {
    await expect(harkara.send({ type: '', payload: {} })).rejects.toThrow();
    await expect(harkara.send({ type: '   ', payload: {} })).rejects.toThrow();
  });
});
