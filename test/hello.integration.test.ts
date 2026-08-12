import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from './helpers/db.js';
import { migrateUp } from './helpers/migrate.js';

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

  it('node-pg-migrate is wired: up is idempotent', async () => {
    await migrateUp();
    // Running up again applies nothing and does not throw.
    const again = await migrateUp();
    expect(again).toEqual([]);
  });
});
