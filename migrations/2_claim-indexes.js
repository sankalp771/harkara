/**
 * Phase 3 — indexes shaped like the claim query actually reads.
 *
 * The worker claims per-endpoint (LATERAL "oldest pending for THIS
 * endpoint" + "is THIS endpoint busy") — both are endpoint_id lookups,
 * which Phase 1's (next_attempt_at) index cannot serve: every claim was
 * a sequential scan per endpoint. Replaced with two partial indexes that
 * mirror the two predicates.
 */

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export function up(pgm) {
  // LATERAL: oldest due pending delivery for one endpoint.
  pgm.sql(`
    CREATE INDEX deliveries_pending_by_endpoint
    ON deliveries (endpoint_id, next_attempt_at)
    WHERE status = 'pending'
  `);
  // NOT EXISTS: is this endpoint currently delivering (§5.1 serialization).
  pgm.sql(`
    CREATE INDEX deliveries_delivering_by_endpoint
    ON deliveries (endpoint_id)
    WHERE status = 'delivering'
  `);
  // Superseded: the claim path no longer scans by next_attempt_at alone.
  pgm.sql(`DROP INDEX deliveries_claimable`);
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`
    CREATE INDEX deliveries_claimable
    ON deliveries (next_attempt_at)
    WHERE status = 'pending'
  `);
  pgm.sql(`DROP INDEX deliveries_delivering_by_endpoint`);
  pgm.sql(`DROP INDEX deliveries_pending_by_endpoint`);
}
