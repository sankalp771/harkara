import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

/**
 * Phase 9 T1 — the one sanctioned door for applying harkara's schema.
 *
 * Harkara keeps its OWN migration ledger (`harkara_migrations`), never
 * node-pg-migrate's default table: the host app plausibly uses
 * node-pg-migrate for its own schema, and a shared ledger would let
 * either side's `migrate down` roll back the other's tables by
 * position. Separate table = separate history = neither side can
 * corrupt the other's sense of "what has been applied".
 *
 * Safe to call on every boot: an up-to-date ledger applies nothing.
 */

export const MIGRATIONS_TABLE = 'harkara_migrations';

export interface RunMigrationsOptions {
  /** Connection string of the host's Postgres. */
  databaseUrl: string;
  /** Optional logger for migration progress; silent by default. */
  log?: (msg: string) => void;
}

/** @returns names of the migrations applied by THIS call ([] when up to date). */
export async function runMigrations(options: RunMigrationsOptions): Promise<string[]> {
  // Resolves to <repo>/migrations (TS) in development and to
  // <package>/dist/migrations (compiled JS) when installed from npm —
  // the same relative hop in both worlds.
  const dir = fileURLToPath(new URL('../migrations', import.meta.url));
  const applied = await runner({
    databaseUrl: options.databaseUrl,
    dir,
    direction: 'up',
    migrationsTable: MIGRATIONS_TABLE,
    log: options.log ?? (() => undefined),
  });
  return applied.map((m) => m.name);
}
