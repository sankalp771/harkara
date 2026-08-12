import { runner } from 'node-pg-migrate';
import { getConnectionString } from './db.js';

/**
 * One place that knows how to drive node-pg-migrate in tests. All schema
 * changes go through migrations (CLAUDE.md) — no test ever loads a .sql
 * file or creates harkara tables by hand.
 */

const silent = () => undefined;

export async function migrateUp(): Promise<string[]> {
  const applied = await runner({
    databaseUrl: await getConnectionString(),
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: silent,
  });
  return applied.map((m) => m.name);
}

export async function migrateDown(count = Infinity): Promise<string[]> {
  const reverted = await runner({
    databaseUrl: await getConnectionString(),
    dir: 'migrations',
    direction: 'down',
    migrationsTable: 'pgmigrations',
    count,
    log: silent,
  });
  return reverted.map((m) => m.name);
}
