import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { attemptDelivery, type ClaimedDelivery } from './deliver.js';

export interface WorkerOptions {
  /** Global in-flight bound for this worker. Default 10. */
  concurrency?: number;
  /** Idle sleep between empty claim rounds. Default 500ms. */
  pollIntervalMs?: number;
  /** §3.1 per-attempt HTTP cap. Default 30s. */
  attemptTimeoutMs?: number;
  /** §8.1 — locks older than this are reaped back to pending. Default 60s. */
  visibilityTimeoutMs?: number;
  /** How often the in-loop reaper runs. Default 10s. */
  reaperIntervalMs?: number;
  /** Identifies this worker in locked_by. Default worker-<uuid>. */
  workerId?: string;
}

export interface HarkaraWorker {
  /** Graceful: stop claiming, finish in-flight attempts, then resolve. */
  stop(): Promise<void>;
}

interface ResolvedOptions {
  concurrency: number;
  pollIntervalMs: number;
  attemptTimeoutMs: number;
  visibilityTimeoutMs: number;
  reaperIntervalMs: number;
  workerId: string;
}

/**
 * Phase 3 — the worker: a SINGLE async loop (iterations are awaited, so
 * they cannot overlap by construction — no setInterval anywhere), claiming
 * via one UPDATE…SKIP LOCKED statement and reaping on locked_at (§8).
 */
export function startWorker(pool: Pool, options: WorkerOptions = {}): HarkaraWorker {
  const opts: ResolvedOptions = {
    concurrency: options.concurrency ?? 10,
    pollIntervalMs: options.pollIntervalMs ?? 500,
    attemptTimeoutMs: options.attemptTimeoutMs ?? 30_000,
    visibilityTimeoutMs: options.visibilityTimeoutMs ?? 60_000,
    reaperIntervalMs: options.reaperIntervalMs ?? 10_000,
    workerId: options.workerId ?? `worker-${randomUUID()}`,
  };
  // A lock must never expire while its attempt can still legally be running
  // — that would manufacture §8.3 duplicates on every slow response.
  if (opts.visibilityTimeoutMs < 2 * opts.attemptTimeoutMs) {
    throw new Error(
      'harkara.startWorker: visibilityTimeoutMs must be at least 2× attemptTimeoutMs',
    );
  }

  // Read through a function: stop() flips the flag from another closure
  // mid-await, which TS flow narrowing can't model on a direct read.
  let stopping = false;
  const isStopping = () => stopping;
  let wake: (() => void) | undefined;
  const inFlight = new Set<Promise<void>>();

  const loop = (async () => {
    let lastReap = 0;
    while (!isStopping()) {
      try {
        if (Date.now() - lastReap >= opts.reaperIntervalMs) {
          lastReap = Date.now();
          await reapStaleLocks(pool, opts.visibilityTimeoutMs);
        }

        const capacity = opts.concurrency - inFlight.size;
        let claimed: ClaimedDelivery[] = [];
        if (capacity > 0) {
          claimed = await claimBatch(pool, opts.workerId, capacity);
          claimed = await demoteCrowdedClaims(pool, claimed);
        }

        for (const delivery of claimed) {
          const attempt = attemptDelivery(pool, delivery, opts.attemptTimeoutMs)
            .catch(() => undefined) // recording failed — the reaper will recover the claim
            .finally(() => inFlight.delete(attempt));
          inFlight.add(attempt);
        }

        if (claimed.length === 0 && !isStopping()) {
          await sleep(opts.pollIntervalMs, (w) => (wake = w));
        }
      } catch {
        // Transient DB error in claim/reap: back off briefly, keep living.
        if (!isStopping()) await sleep(opts.pollIntervalMs, (w) => (wake = w));
      }
    }
    await Promise.allSettled([...inFlight]);
  })();

  return {
    async stop() {
      stopping = true;
      wake?.();
      await loop;
    },
  };
}

/**
 * The claim: mark-and-lock in ONE statement — no gap between "selected"
 * and "locked" for a sibling worker to slip through.
 *
 * Locking discipline (learned from a real 195-in-10k double-claim):
 * - The LATERAL locks the DELIVERY row (`FOR UPDATE SKIP LOCKED`). Under
 *   READ COMMITTED a concurrent claimer's stale snapshot still sees the
 *   row as pending, but the row lock forces re-evaluation on the newest
 *   version ('delivering' → qual fails → skipped). Locking only the
 *   endpoint left EvalPlanQual free to re-apply a stale IN-set to the
 *   same delivery twice.
 * - `FOR UPDATE OF e SKIP LOCKED` on the ENDPOINT row serializes
 *   overlapping claims per endpoint (§5.1).
 * - NOT EXISTS(status='delivering') keeps the endpoint serialized for the
 *   whole attempt; its residual stale-snapshot race (two claims of
 *   DIFFERENT deliveries of one endpoint in the same millisecond) is
 *   closed by demoteCrowdedClaims below.
 * - the LATERAL LIMIT 1 takes at most one delivery per endpoint per batch
 *   (DISTINCT ON cannot be combined with FOR UPDATE).
 */
async function claimBatch(pool: Pool, workerId: string, limit: number): Promise<ClaimedDelivery[]> {
  const { rows } = await pool.query<{
    id: string;
    message_id: string;
    endpoint_id: string;
    attempt_count: number;
    url: string;
    payload: string;
  }>(
    `WITH claimed AS (
       UPDATE deliveries SET status = 'delivering', locked_at = now(), locked_by = $1
       WHERE id IN (
         SELECT picked.id
         FROM endpoints e
         JOIN LATERAL (
           SELECT d.id
           FROM deliveries d
           WHERE d.endpoint_id = e.id
             AND d.status = 'pending'
             AND d.next_attempt_at <= now()
           ORDER BY d.next_attempt_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         ) picked ON true
         WHERE NOT EXISTS (
           SELECT 1 FROM deliveries busy
           WHERE busy.endpoint_id = e.id AND busy.status = 'delivering'
         )
         ORDER BY e.id
         LIMIT $2
         FOR UPDATE OF e SKIP LOCKED
       )
       RETURNING id, message_id, endpoint_id, attempt_count
     )
     SELECT c.id, c.message_id, c.endpoint_id, c.attempt_count, e.url, m.payload
     FROM claimed c
     JOIN endpoints e ON e.id = c.endpoint_id
     JOIN messages m ON m.id = c.message_id`,
    [workerId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    messageId: r.message_id,
    endpointId: r.endpoint_id,
    attemptCount: r.attempt_count,
    url: r.url,
    payload: r.payload,
  }));
}

/**
 * Post-claim exclusivity check, run on a FRESH snapshot: if any sibling
 * row for the same endpoint is also 'delivering', demote OUR claim back to
 * pending before dispatching. Two overlapping claimers may both demote
 * (wasted claim, retried next round) but can never both dispatch — at
 * least one of the two verify passes always sees the other's committed
 * claim. This closes the §5.1 race that claim-time snapshots cannot.
 */
async function demoteCrowdedClaims(
  pool: Pool,
  claimed: ClaimedDelivery[],
): Promise<ClaimedDelivery[]> {
  if (claimed.length === 0) return claimed;
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE deliveries SET status = 'pending', locked_at = NULL, locked_by = NULL
     WHERE id = ANY($1::uuid[])
       AND EXISTS (
         SELECT 1 FROM deliveries other
         WHERE other.endpoint_id = deliveries.endpoint_id
           AND other.id <> deliveries.id
           AND other.status = 'delivering'
       )
     RETURNING id`,
    [claimed.map((c) => c.id)],
  );
  if (rows.length === 0) return claimed;
  const demoted = new Set(rows.map((r) => r.id));
  return claimed.filter((c) => !demoted.has(c.id));
}

/**
 * §8.1–8.2 — the reaper, keyed on locked_at (when work STARTED) and ONLY
 * locked_at. created_at never appears here: recovering on row age is the
 * old repo's double-delivery bug.
 */
async function reapStaleLocks(pool: Pool, visibilityTimeoutMs: number): Promise<void> {
  await pool.query(
    `UPDATE deliveries
     SET status = 'pending', locked_at = NULL, locked_by = NULL
     WHERE status = 'delivering'
       AND locked_at < now() - ($1::int * interval '1 ms')`,
    [visibilityTimeoutMs],
  );
}

function sleep(ms: number, registerWake: (wake: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    registerWake(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
