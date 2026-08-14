import type { Pool } from 'pg';
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
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
