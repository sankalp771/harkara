import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Phase 8 — §7 ordering (plan T1/T2).
 *
 * - deliveries.seq: creation order IS this sequence — created_at ties to
 *   the microsecond for siblings born in one transaction (§7.1's
 *   amendment: order by sequence, never by clock).
 * - ordering_key lives on messages as the API-level truth AND
 *   denormalized (write-once) on deliveries, so the claim guard is a
 *   self-join on deliveries served by one partial index — the hot path
 *   never joins messages.
 */

export const shorthands = undefined;

export function up(pgm: MigrationBuilder): void {
  pgm.addColumn('messages', {
    ordering_key: { type: 'text' },
  });
  pgm.addColumn('deliveries', {
    ordering_key: { type: 'text' },
    seq: { type: 'bigint', sequenceGenerated: { precedence: 'ALWAYS' }, notNull: true },
  });

  // The §7.1 guard probe: "does an older, still-live sibling exist for
  // this endpoint + key?" — one index-only range check per candidate.
  pgm.sql(`
    CREATE INDEX deliveries_ordering_guard
    ON deliveries (endpoint_id, ordering_key, seq)
    WHERE ordering_key IS NOT NULL AND status IN ('pending', 'delivering')
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('DROP INDEX deliveries_ordering_guard');
  pgm.dropColumn('deliveries', 'seq');
  pgm.dropColumn('deliveries', 'ordering_key');
  pgm.dropColumn('messages', 'ordering_key');
}
