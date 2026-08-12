import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

/**
 * One code path for local and CI (Phase 0 decision, see REBUILD_PLAN.md):
 * - CI sets DATABASE_URL to its Postgres service container.
 * - Locally, we spin a real Postgres via testcontainers (reused across
 *   runs so iteration stays fast). Docker Desktop must be running.
 *
 * Integration tests never mock Postgres — SKIP LOCKED, the reaper, and the
 * breaker are only proven on the real thing (CLAUDE.md).
 */

const POSTGRES_IMAGE = 'postgres:17';

let container: StartedPostgreSqlContainer | undefined;
let connectionString: string | undefined;

export async function getConnectionString(): Promise<string> {
  if (connectionString) return connectionString;

  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) {
    connectionString = fromEnv;
    return connectionString;
  }

  container = await new PostgreSqlContainer(POSTGRES_IMAGE).withReuse().start();
  connectionString = container.getConnectionUri();
  return connectionString;
}

export async function createPool(): Promise<Pool> {
  return new Pool({ connectionString: await getConnectionString() });
}
