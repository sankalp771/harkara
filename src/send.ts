import type { Pool, ClientBase } from 'pg';
import { eventTypeMatches } from './matching.js';

export interface SendEvent {
  /** Event type, e.g. `invoice.paid` — what §1a matching runs against. */
  type: string;
  /** JSON-serialized exactly once, at send time; stored as the bytes that
   * will later be signed (§4.2). Must be JSON-serializable. */
  payload: unknown;
  /** Omitted = single-tenant (stored as NULL). Matching is tenant-strict
   * (§1a.4). */
  tenantId?: string;
  /** §2.4 — a resend with the same key returns the original message. */
  idempotencyKey?: string;
  /** §7 — messages sharing a key deliver to each endpoint in acceptance
   * order (best-effort; §7.2 names the breaks). Omitted = unordered. */
  orderingKey?: string;
}

export interface SendOptions {
  /**
   * The caller's own client, mid-transaction (§1.3): every insert joins
   * THEIR transaction and harkara issues no BEGIN/COMMIT of its own.
   * Acceptance happens at the caller's COMMIT.
   */
  tx?: ClientBase;
}

export interface SendResult {
  /** The stable webhook-id (§2.1) — identical on every retry attempt. */
  messageId: string;
  /** True when §2.4 deduplicated: no new message, no new deliveries. */
  duplicate: boolean;
}

/**
 * §1.3 — the transactional outbox. Persist-then-resolve: without a caller
 * tx, the returned promise resolves strictly after COMMIT; a rejected
 * promise means not-accepted and the caller may safely resend.
 */
export async function send(
  pool: Pool,
  event: SendEvent,
  options?: SendOptions,
): Promise<SendResult> {
  if (event.type.trim() === '') {
    throw new Error('harkara.send: event.type must be a non-empty string');
  }
  // Serialize before touching the database — an unserializable payload
  // must reject with zero rows written. (TS types JSON.stringify as always
  // returning string, but undefined/function payloads yield undefined.)
  const payload = JSON.stringify(event.payload) as string | undefined;
  if (payload === undefined) {
    throw new Error('harkara.send: event.payload is not JSON-serializable');
  }

  const tenantId = event.tenantId ?? null;
  const idempotencyKey = event.idempotencyKey ?? null;
  const orderingKey = event.orderingKey ?? null;

  if (options?.tx) {
    // Caller's transaction: no BEGIN, no COMMIT, no acknowledgment of our
    // own — acceptance is their COMMIT (§1.3).
    return insertMessageAndFanOut(
      options.tx,
      event.type,
      payload,
      tenantId,
      idempotencyKey,
      orderingKey,
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await insertMessageAndFanOut(
      client,
      event.type,
      payload,
      tenantId,
      idempotencyKey,
      orderingKey,
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // If the connection itself died, ROLLBACK throws too — swallow it so
    // the caller sees the ORIGINAL failure, not the rollback's echo.
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function insertMessageAndFanOut(
  client: ClientBase,
  eventType: string,
  payload: string,
  tenantId: string | null,
  idempotencyKey: string | null,
  orderingKey: string | null,
): Promise<SendResult> {
  // Arbiter = the NULLS NOT DISTINCT partial index from Phase 1, so
  // single-tenant (NULL) callers get real §2.4 dedup too.
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO messages (tenant_id, event_type, payload, idempotency_key, ordering_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [tenantId, eventType, payload, idempotencyKey, orderingKey],
  );

  const insertedRow = inserted.rows[0];
  if (!insertedRow) {
    // §2.4 hit: return the previously accepted message — same webhook-id,
    // and no new fan-out (its deliveries already exist).
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM messages
       WHERE tenant_id IS NOT DISTINCT FROM $1 AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    const existingRow = existing.rows[0];
    if (!existingRow) {
      throw new Error('harkara.send: idempotency conflict raised but no existing message found');
    }
    return { messageId: existingRow.id, duplicate: true };
  }

  const messageId = insertedRow.id;

  // §1a.4 tenant-strict candidates (NULL = NULL via IS NOT DISTINCT FROM),
  // §1a.1 pattern matching in one tested pure function.
  const candidates = await client.query<{ id: string; event_types: string[] }>(
    `SELECT id, event_types FROM endpoints WHERE tenant_id IS NOT DISTINCT FROM $1`,
    [tenantId],
  );
  const matching = candidates.rows
    .filter((e) => eventTypeMatches(e.event_types, eventType))
    .map((e) => e.id);

  // §1a.2 — one delivery per matching endpoint, same transaction as the
  // message insert. Same crash-atomicity as the caller's own data.
  if (matching.length > 0) {
    // ordering_key rides along as a write-once copy (§7/T2): the claim
    // guard reads it without ever joining messages.
    await client.query(
      `INSERT INTO deliveries (message_id, endpoint_id, ordering_key)
       SELECT $1, unnest($2::uuid[]), $3`,
      [messageId, matching, orderingKey],
    );
  }

  return { messageId, duplicate: false };
}
