import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

/** Direct-SQL seeding for worker tests — precise control over row state
 * (locked_at, created_at, next_attempt_at) that no public API should offer. */

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE delivery_attempts, deliveries, endpoint_breakers, endpoint_secrets, endpoints, messages',
  );
}

export async function seedEndpoint(
  pool: Pool,
  url: string,
  eventTypes: string[] = [],
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO endpoints (url, event_types) VALUES ($1, $2) RETURNING id`,
    [url, eventTypes],
  );
  // §4.1 (Phase 4, T1 ruling): endpoints without an active secret are
  // refused delivery — every delivery-test endpoint needs one.
  await pool.query(`INSERT INTO endpoint_secrets (endpoint_id, secret) VALUES ($1, $2)`, [
    rows[0]!.id,
    `whsec_${randomBytes(24).toString('base64')}`,
  ]);
  return rows[0]!.id;
}

export async function seedMessage(pool: Pool, eventType = 'load.test'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO messages (event_type, payload) VALUES ($1, '{"seed":true}') RETURNING id`,
    [eventType],
  );
  return rows[0]!.id;
}

export async function seedDelivery(
  pool: Pool,
  messageId: string,
  endpointId: string,
  opts: {
    status?: string;
    /** offset in ms relative to now() */
    nextAttemptAtMs?: number;
    lockedAtMs?: number;
    lockedBy?: string;
    createdAtMs?: number;
  } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO deliveries (message_id, endpoint_id, status, next_attempt_at, locked_at, locked_by, created_at)
     VALUES (
       $1, $2, $3,
       now() + ($4::int * interval '1 ms'),
       CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5::int * interval '1 ms') END,
       $6,
       now() + (COALESCE($7::int, 0) * interval '1 ms')
     )
     RETURNING id`,
    [
      messageId,
      endpointId,
      opts.status ?? 'pending',
      opts.nextAttemptAtMs ?? 0,
      opts.lockedAtMs ?? null,
      opts.lockedBy ?? null,
      opts.createdAtMs ?? null,
    ],
  );
  return rows[0]!.id;
}

export async function waitUntil(
  predicate: () => Promise<boolean>,
  { timeoutMs = 15_000, intervalMs = 100 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitUntil: condition not met in time');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
