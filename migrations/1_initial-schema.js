/**
 * Phase 1 — the five tables (REBUILD_PLAN.md Phase 1; SEMANTICS §1.3, §1a,
 * §2.4, §4.5, §6.1, §6.2, §8.1).
 *
 * The two load-bearing details:
 * - deliveries has a PARTIAL unique index on (message_id, endpoint_id)
 *   WHERE status <> 'dead' and NO table-level unique constraint. The real
 *   invariant is "one LIVE delivery per pair" — dead rows are history, and
 *   a hard constraint would block §6.2 replay forever (the old repo's bug).
 * - messages' idempotency index is NULLS NOT DISTINCT: single-tenant rows
 *   have tenant_id NULL, and plain UNIQUE treats NULL ≠ NULL, which would
 *   let duplicate keys through exactly where §2.4 must stop them.
 */

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export function up(pgm) {
  pgm.createTable('messages', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'text' },
    event_type: { type: 'text', notNull: true },
    // Serialized bytes, not JSONB: §4.2 signs the raw body, and JSONB
    // normalization could change bytes between attempts.
    payload: { type: 'text', notNull: true },
    idempotency_key: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.sql(`
    CREATE UNIQUE INDEX messages_tenant_idempotency_key
    ON messages (tenant_id, idempotency_key) NULLS NOT DISTINCT
    WHERE idempotency_key IS NOT NULL
  `);

  pgm.createTable('endpoints', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tenant_id: { type: 'text' },
    // Untrusted input aimed at our own HTTP client (§9). Deliberately NOT
    // unique: two tenants may point at the same receiver.
    url: { type: 'text', notNull: true },
    // §1a.1 event-type patterns; empty array = all events.
    event_types: { type: 'text[]', notNull: true, default: pgm.func(`'{}'::text[]`) },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('endpoint_secrets', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    endpoint_id: {
      type: 'uuid',
      notNull: true,
      references: 'endpoints',
      onDelete: 'CASCADE',
    },
    secret: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // Active = revoked_at IS NULL. Many active at once during §4.5 rotation.
    revoked_at: { type: 'timestamptz' },
  });

  pgm.createTable('deliveries', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    message_id: { type: 'uuid', notNull: true, references: 'messages' },
    endpoint_id: { type: 'uuid', notNull: true, references: 'endpoints' },
    status: { type: 'text', notNull: true, default: 'pending' },
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    next_attempt_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // §8.1 — the reaper recovers on locked_at (when work STARTED), never
    // created_at (when the row was born).
    locked_at: { type: 'timestamptz' },
    locked_by: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('deliveries', 'deliveries_status_check', {
    check: `status IN ('pending', 'delivering', 'delivered', 'dead')`,
  });

  pgm.sql(`
    CREATE UNIQUE INDEX deliveries_live_message_endpoint
    ON deliveries (message_id, endpoint_id)
    WHERE status <> 'dead'
  `);

  // Phase 3's claim query scans only what is claimable.
  pgm.sql(`
    CREATE INDEX deliveries_claimable
    ON deliveries (next_attempt_at)
    WHERE status = 'pending'
  `);

  pgm.createTable('delivery_attempts', {
    id: { type: 'bigint', primaryKey: true, sequenceGenerated: { precedence: 'ALWAYS' } },
    delivery_id: {
      type: 'uuid',
      notNull: true,
      references: 'deliveries',
      onDelete: 'CASCADE',
    },
    attempt_number: { type: 'integer', notNull: true },
    // NULL = no HTTP response (timeout, connection refused, DNS failure).
    status_code: { type: 'integer' },
    error: { type: 'text' },
    // Stored pre-truncated; never the full body (CLAUDE.md).
    response_body: { type: 'text' },
    latency_ms: { type: 'integer' },
    attempted_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('delivery_attempts', 'delivery_id');
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export function down(pgm) {
  pgm.dropTable('delivery_attempts');
  pgm.dropTable('deliveries');
  pgm.dropTable('endpoint_secrets');
  pgm.dropTable('endpoints');
  pgm.dropTable('messages');
}
