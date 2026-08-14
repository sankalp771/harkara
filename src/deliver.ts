import type { Pool, PoolClient } from 'pg';
import { applyOutcome, type BreakerConfig, type BreakerRow, type BreakerState } from './breaker.js';
import {
  classify,
  configDelayMs,
  nextDelayMs,
  parseRetryAfter,
  type AttemptKind,
} from './retry.js';
import { webhookHeaders } from './signing.js';

/** §6.1 — response bodies are stored truncated, never whole (CLAUDE.md). */
const RESPONSE_BODY_CAP = 4096;

export interface ClaimedDelivery {
  id: string;
  messageId: string;
  endpointId: string;
  attemptCount: number;
  url: string;
  payload: string;
  /** Active (unrevoked) signing secrets, oldest first (§4.5). */
  secrets: string[];
}

/**
 * One delivery attempt: real HTTP POST, then record the attempt and the
 * delivery's next state (§3.2 classification, §3.3 schedule) in a single
 * transaction.
 */
export async function attemptDelivery(
  pool: Pool,
  delivery: ClaimedDelivery,
  attemptTimeoutMs: number,
  retrySchedule: readonly number[],
  breaker: BreakerConfig,
): Promise<void> {
  const startedAt = Date.now();
  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let errorText: string | null = null;
  let retryAfterMs: number | null = null;
  let kind: AttemptKind = 'http';

  if (delivery.secrets.length === 0) {
    // §3.2 config class / §4.1 T1 ruling: no secret → no request, ever.
    // Recorded as a refusal, never sent unsigned.
    kind = 'config';
    errorText = 'no active secret for endpoint — refusing to deliver unsigned (§4.1)';
  } else {
    try {
      const response = await fetch(delivery.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...webhookHeaders(delivery.messageId, delivery.payload, delivery.secrets),
        },
        body: delivery.payload,
        signal: AbortSignal.timeout(attemptTimeoutMs),
        redirect: 'manual', // hardened properly in Phase 7 (§9.2)
      });
      statusCode = response.status;
      responseBody = (await response.text()).slice(0, RESPONSE_BODY_CAP);
      if (statusCode === 429 || statusCode === 503) {
        // §3.2 — the receiver names its price (capped later by nextDelayMs).
        retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      }
    } catch (err) {
      kind = 'network';
      errorText =
        err instanceof Error
          ? err.cause instanceof Error
            ? `${err.message}: ${err.cause.message}`
            : err.message
          : String(err);
    }
  }
  const latencyMs = Date.now() - startedAt;
  const outcome = classify(statusCode, kind);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Rider 2: refusals are refusals, not numbered attempts — NULL keeps
    // the §6.1 diary honest (no fake "attempt 1" rows before the real one).
    const attemptNumber = outcome === 'configError' ? null : delivery.attemptCount + 1;
    await client.query(
      `INSERT INTO delivery_attempts
         (delivery_id, attempt_number, status_code, error, response_body, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [delivery.id, attemptNumber, statusCode, errorText, responseBody, latencyMs],
    );

    if (outcome === 'success') {
      // locked_at clears (the lock is over) but locked_by stays: it is the
      // provenance record of WHICH worker completed the delivery.
      await client.query(
        `UPDATE deliveries
         SET status = 'delivered', locked_at = NULL,
             attempt_count = attempt_count + 1
         WHERE id = $1`,
        [delivery.id],
      );
    } else if (outcome === 'configError') {
      // §3.2 config class: wait at the max step, schedule position frozen
      // (attempt_count untouched) — never marches toward dead.
      await client.query(
        `UPDATE deliveries
         SET status = 'pending', locked_at = NULL, locked_by = NULL,
             next_attempt_at = now() + ($2::int * interval '1 ms')
         WHERE id = $1`,
        [delivery.id, configDelayMs(retrySchedule)],
      );
    } else {
      const delay =
        outcome === 'nonRetryable'
          ? 'dead'
          : nextDelayMs(delivery.attemptCount + 1, retrySchedule, retryAfterMs);
      if (delay === 'dead') {
        // §3.2/§6.1 — parked, never deleted; dead_at feeds §6.3 replay.
        await client.query(
          `UPDATE deliveries
           SET status = 'dead', dead_at = now(), locked_at = NULL, locked_by = NULL,
               attempt_count = attempt_count + 1
           WHERE id = $1`,
          [delivery.id],
        );
      } else {
        await client.query(
          `UPDATE deliveries
           SET status = 'pending', locked_at = NULL, locked_by = NULL,
               attempt_count = attempt_count + 1,
               next_attempt_at = now() + ($2::int * interval '1 ms')
           WHERE id = $1`,
          [delivery.id, delay],
        );
      }
    }

    // §5.2 — fold this outcome into the breaker, in the SAME transaction
    // as the attempt row and the delivery's next state: breaker state can
    // never disagree with the outcome that caused it. Config refusals
    // never reach here (T1): no wire, no evidence.
    if (outcome !== 'configError') {
      await recordBreakerOutcome(client, delivery.endpointId, outcome !== 'success', breaker);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Ensure the breaker row (lazy — missing means closed), lock it, apply
 * the pure transition, write it back. Deadlock-free with the claim path
 * by Phase 3's argument: claims never wait (SKIP LOCKED everywhere), so
 * no wait cycle can close through this row lock.
 */
async function recordBreakerOutcome(
  client: PoolClient,
  endpointId: string,
  isFailure: boolean,
  cfg: BreakerConfig,
): Promise<void> {
  await client.query(
    `INSERT INTO endpoint_breakers (endpoint_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [endpointId],
  );
  const { rows } = await client.query<{
    state: BreakerState;
    window_started_ms: number | null;
    window_attempts: number;
    window_failures: number;
    cooldown_ms: number | null;
    opened_ms: number | null;
    open_until_ms: number | null;
  }>(
    `SELECT state,
            extract(epoch FROM window_started_at)::float8 * 1000 AS window_started_ms,
            window_attempts, window_failures, cooldown_ms,
            extract(epoch FROM opened_at)::float8 * 1000 AS opened_ms,
            extract(epoch FROM open_until)::float8 * 1000 AS open_until_ms
     FROM endpoint_breakers WHERE endpoint_id = $1
     FOR UPDATE`,
    [endpointId],
  );
  const r = rows[0];
  if (r === undefined) return; // row vanished (endpoint deleted mid-flight)

  const before: BreakerRow = {
    state: r.state,
    windowStartedAt: r.window_started_ms,
    windowAttempts: r.window_attempts,
    windowFailures: r.window_failures,
    cooldownMs: r.cooldown_ms,
    openedAt: r.opened_ms,
    openUntil: r.open_until_ms,
  };
  const after = applyOutcome(before, isFailure, cfg, Date.now());

  await client.query(
    `UPDATE endpoint_breakers
     SET state = $2,
         window_started_at = to_timestamp($3::float8 / 1000.0),
         window_attempts = $4, window_failures = $5, cooldown_ms = $6,
         opened_at = to_timestamp($7::float8 / 1000.0),
         open_until = to_timestamp($8::float8 / 1000.0),
         updated_at = now()
     WHERE endpoint_id = $1`,
    [
      endpointId,
      after.state,
      after.windowStartedAt,
      after.windowAttempts,
      after.windowFailures,
      after.cooldownMs,
      after.openedAt,
      after.openUntil,
    ],
  );
}
