/**
 * Phase 5 — the DLQ learns when things died, and refusal rows drop the
 * NOT NULL on attempt_number.
 *
 * dead_at: §6.3's time-range replay ("our server was down Tuesday
 * 2-4pm") filters on when deliveries DIED, which no column recorded.
 *
 * attempt_number NULL (rider 2): §3.2 config refusals are recorded for
 * forensics but are refusals, not numbered attempts — five fake
 * "attempt 1" rows before the real attempt 1 would poison the §6.1
 * diary.
 */

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`ALTER TABLE deliveries ADD COLUMN dead_at TIMESTAMPTZ`);
  pgm.sql(`
    CREATE INDEX deliveries_dead_by_endpoint
    ON deliveries (endpoint_id, dead_at)
    WHERE status = 'dead'
  `);
  pgm.sql(`
    CREATE INDEX deliveries_dead_by_time
    ON deliveries (dead_at)
    WHERE status = 'dead'
  `);
  pgm.sql(`ALTER TABLE delivery_attempts ALTER COLUMN attempt_number DROP NOT NULL`);
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`ALTER TABLE delivery_attempts ALTER COLUMN attempt_number SET NOT NULL`);
  pgm.sql(`DROP INDEX deliveries_dead_by_time`);
  pgm.sql(`DROP INDEX deliveries_dead_by_endpoint`);
  pgm.sql(`ALTER TABLE deliveries DROP COLUMN dead_at`);
}
