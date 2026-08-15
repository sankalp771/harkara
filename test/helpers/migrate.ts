import { runner } from 'node-pg-migrate';
import { MIGRATIONS_TABLE, runMigrations } from '../../src/migrate.js';
import { getConnectionString } from './db.js';

/**
 * One place that knows how to drive node-pg-migrate in tests. Up goes
 * through the PUBLIC runMigrations (Phase 9 T1: the shipped path IS the
 * tested path — same ledger table, same dir resolution); down stays a
 * test-only concern via the raw runner.
 */

const silent = () => undefined;

export async function migrateUp(): Promise<string[]> {
  return runMigrations({ databaseUrl: await getConnectionString() });
}

export async function migrateDown(count = Infinity): Promise<string[]> {
  const reverted = await runner({
    databaseUrl: await getConnectionString(),
    dir: 'migrations',
    direction: 'down',
    migrationsTable: MIGRATIONS_TABLE,
    count,
    log: silent,
  });
  return reverted.map((m) => m.name);
}
