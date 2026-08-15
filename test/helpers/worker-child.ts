import { Pool } from 'pg';
import { createHarkara } from '../../src/index.js';

/**
 * Standalone worker process for the §8.3 crash test. The parent spawns
 * this with `node` (Node 22 strips types natively), waits for READY, and
 * SIGKILLs it mid-delivery — a REAL dead process with a REAL stranded
 * lock, not a simulated crash flag (maintainer directive).
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write('worker-child: DATABASE_URL is required\n');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
const harkara = createHarkara({ pool });

harkara.startWorker({
  workerId: 'crash-child',
  pollIntervalMs: 100,
  attemptTimeoutMs: Number(process.env.ATTEMPT_TIMEOUT_MS ?? 30_000),
  visibilityTimeoutMs: Number(process.env.VISIBILITY_TIMEOUT_MS ?? 60_000),
  ssrf: { allowInsecureHttp: true, allowPrivateAddresses: true },
});

process.stdout.write('READY\n');
// Keep running until killed. No graceful anything — that's the point.
