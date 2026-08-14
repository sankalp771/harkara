import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Phase 6 — §5.2/§5.3 circuit breaker state (plan T4/T5).
 *
 * Separate table, NOT columns on endpoints: endpoints is user
 * configuration, this row churns on every recorded attempt. Created
 * lazily on first outcome — a missing row means closed, so existing
 * endpoints (and every pre-Phase-6 test) need no backfill.
 *
 * The tumbling window lives in three columns (started_at + two
 * counters): trip checks are integer arithmetic on this row, never a
 * COUNT(*) over delivery_attempts on the hot path.
 */

export const shorthands = undefined;

export function up(pgm: MigrationBuilder): void {
  pgm.createTable('endpoint_breakers', {
    endpoint_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'endpoints',
      onDelete: 'CASCADE',
    },
    state: { type: 'text', notNull: true, default: 'closed' },
    window_started_at: { type: 'timestamptz' },
    window_attempts: { type: 'integer', notNull: true, default: 0 },
    window_failures: { type: 'integer', notNull: true, default: 0 },
    // Current cooldown (doubles on failed probes, capped); NULL when closed.
    cooldown_ms: { type: 'integer' },
    // When the incident began — kept across reopenings, cleared on close.
    opened_at: { type: 'timestamptz' },
    // When the next half-open probe becomes eligible.
    open_until: { type: 'timestamptz' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('endpoint_breakers', 'endpoint_breakers_state_check', {
    check: `state IN ('closed', 'open', 'half_open')`,
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('endpoint_breakers');
}
