import type { Pool } from 'pg';
import { webhookHeaders } from './signing.js';

/** §6.1 — response bodies are stored truncated, never whole (CLAUDE.md). */
const RESPONSE_BODY_CAP = 4096;

/** T2 (Phase 3 plan): interim uniform retry until Phase 5's schedule. */
const INTERIM_RETRY_DELAY_MS = 5_000;

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
 * delivery's next state in a single transaction. Phase 3 sends unsigned
 * requests (T3) — Phase 4 layers the Standard Webhooks headers on here.
 */
export async function attemptDelivery(
  pool: Pool,
  delivery: ClaimedDelivery,
  attemptTimeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let errorText: string | null = null;

  try {
    // T1 ruling: an endpoint with no active secret is REFUSED — §4.1 says
    // every delivery carries the signature headers, no exceptions, so the
    // fallback is a recorded failure, never an unsigned request.
    if (delivery.secrets.length === 0) {
      throw new Error('no active secret for endpoint — refusing to deliver unsigned (§4.1)');
    }
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
  } catch (err) {
    errorText =
      err instanceof Error
        ? err.cause instanceof Error
          ? `${err.message}: ${err.cause.message}`
          : err.message
        : String(err);
  }
  const latencyMs = Date.now() - startedAt;

  // §3.1 — success iff 2xx within the timeout. Everything else fails.
  const succeeded = statusCode !== null && statusCode >= 200 && statusCode < 300;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO delivery_attempts
         (delivery_id, attempt_number, status_code, error, response_body, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [delivery.id, delivery.attemptCount + 1, statusCode, errorText, responseBody, latencyMs],
    );
    if (succeeded) {
      // locked_at clears (the lock is over) but locked_by stays: it is the
      // provenance record of WHICH worker completed the delivery.
      await client.query(
        `UPDATE deliveries
         SET status = 'delivered', locked_at = NULL,
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
        [delivery.id, INTERIM_RETRY_DELAY_MS],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
