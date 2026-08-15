import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { getConnectionString } from './helpers/db.js';

/**
 * Phase 9 — T1: the host applies harkara's schema through ONE sanctioned
 * door, `runMigrations()`, and harkara keeps its own migration ledger
 * (`harkara_migrations`) so a host that also uses node-pg-migrate never
 * shares a history with us: their `migrate down` must not be able to
 * roll back OUR tables by position.
 */

const FRESH_DB = 'harkara_migrate_api';

describe('phase 9 runMigrations (public API)', () => {
  let adminUrl: string;
  let freshUrl: string;

  async function admin(sql: string): Promise<void> {
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    adminUrl = await getConnectionString();
    // A genuinely FRESH database: runMigrations must build everything
    // from nothing, exactly like a host app's first boot.
    await admin(`DROP DATABASE IF EXISTS ${FRESH_DB} (FORCE)`).catch(() => undefined);
    await admin(`DROP DATABASE IF EXISTS ${FRESH_DB}`).catch(() => undefined);
    await admin(`CREATE DATABASE ${FRESH_DB}`);
    const url = new URL(adminUrl);
    url.pathname = `/${FRESH_DB}`;
    freshUrl = url.toString();
  }, 60_000);

  afterAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${FRESH_DB}`).catch(() => undefined);
  });

  it('builds the full schema into harkara_migrations — never the default ledger', async () => {
    await runMigrations({ databaseUrl: freshUrl });

    const client = new Client({ connectionString: freshUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' ORDER BY table_name`,
      );
      const tables = rows.map((r) => r.table_name);
      for (const expected of [
        'messages',
        'endpoints',
        'endpoint_secrets',
        'deliveries',
        'delivery_attempts',
        'endpoint_breakers',
        'harkara_migrations',
      ]) {
        expect(tables).toContain(expected);
      }
      // The negative-space assertion that keeps T1 true: harkara NEVER
      // writes the host's default node-pg-migrate ledger.
      expect(tables).not.toContain('pgmigrations');

      // Idempotence: a second run applies nothing and throws nothing —
      // hosts call this on every boot.
      await runMigrations({ databaseUrl: freshUrl });
      const { rows: ledger } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM harkara_migrations`,
      );
      expect(ledger[0]!.n).toBe(5); // one row per migration, applied once
    } finally {
      await client.end();
    }
  }, 60_000);
});
