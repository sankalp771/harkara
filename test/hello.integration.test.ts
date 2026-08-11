import { runner } from 'node-pg-migrate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, getConnectionString } from './helpers/db.js';

/**
 * Phase 0 gate (REBUILD_PLAN.md): CI runs green on a hello-world test that
 * talks to REAL Postgres. Proves the whole cage — vitest, the DB helper,
 * and node-pg-migrate wiring — before any product code exists.
 */

describe('phase 0 scaffolding', () => {
  let pool: Pool | undefined;

  beforeAll(async () => {
    pool = await createPool();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('talks to a real Postgres', async () => {
    const { rows } = await pool!.query<{ sum: number; version: string }>(
      'SELECT 1 + 1 AS sum, version() AS version',
    );
    expect(rows[0]?.sum).toBe(2);
    expect(rows[0]?.version).toContain('PostgreSQL');
  });

  it('node-pg-migrate is wired: up runs clean on the empty migrations dir', async () => {
    const databaseUrl = await getConnectionString();

    const applied = await runner({
      databaseUrl,
      dir: 'migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => undefined,
    });
    expect(applied).toEqual([]);

    // The runner must have created its bookkeeping table, and it is empty —
    // Phase 1 owns the first real migration.
    const { rows } = await pool!.query('SELECT count(*)::int AS n FROM pgmigrations');
    expect(rows[0]?.n).toBe(0);

    // Running up again is a no-op, not an error.
    const again = await runner({
      databaseUrl,
      dir: 'migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => undefined,
    });
    expect(again).toEqual([]);
  });
});
