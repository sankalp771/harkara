/**
 * §3.2/§3.3 — failure classification and the retry schedule. Pure
 * functions: the executor supplies outcomes and clocks, this module
 * supplies decisions.
 */

export type Outcome = 'success' | 'retryable' | 'nonRetryable' | 'configError';

export type AttemptKind =
  | 'http' // got a status code
  | 'network' // timeout or connection error — no status
  | 'config'; // refused before any request was sent (§3.2 config class)

/** §3.3 default: 10s → 30s → 2m → 10m → 1h (ms). */
export const DEFAULT_RETRY_SCHEDULE: readonly number[] = [
  10_000, 30_000, 120_000, 600_000, 3_600_000,
];

/** ±20% uniform jitter (§3.3) — prevents synchronized retry storms. */
function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

function maxStep(schedule: readonly number[]): number {
  return Math.max(...schedule);
}

/** §3.2 — the classification table. */
export function classify(statusCode: number | null, kind: AttemptKind): Outcome {
  if (kind === 'config') return 'configError';
  if (kind === 'network') return 'retryable'; // timeouts, connection errors
  if (statusCode !== null && statusCode >= 200 && statusCode < 300) return 'success';
  if (statusCode !== null && (statusCode >= 500 || statusCode === 429)) return 'retryable';
  // Everything else — the rest of 4xx AND all 3xx (redirects are not
  // followed, §9.2) — is equally wrong tomorrow.
  return 'nonRetryable';
}

/**
 * Delay before the next attempt after `failedAttempts` total real
 * failures, or 'dead' when the schedule is exhausted (§3.3:
 * schedule.length + 1 total attempts). Retry-After (§3.2, 429/503) is
 * used verbatim — the receiver named its price, no jitter — but capped
 * at the maximum backoff step; it cannot resurrect an exhausted schedule.
 */
export function nextDelayMs(
  failedAttempts: number,
  schedule: readonly number[],
  retryAfterMs?: number | null,
): number | 'dead' {
  const step = schedule[failedAttempts - 1];
  if (step === undefined) return 'dead'; // schedule exhausted
  if (retryAfterMs != null) return Math.min(retryAfterMs, maxStep(schedule));
  return jitter(step);
}

/**
 * §3.2 config class: wait at the maximum backoff step, never advance
 * toward dead — fixing configuration is a human act, and killing the
 * delivery for the operator's mistake would punish the receiver.
 */
export function configDelayMs(schedule: readonly number[]): number {
  return jitter(maxStep(schedule));
}

/** Retry-After: delta-seconds or HTTP-date → ms from now; null = absent/garbage. */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // HTTP-dates always contain letters (month name, GMT). Anything else —
  // '-5' and friends — is garbage, not a date Date.parse should improvise on.
  if (!/[a-z]/i.test(trimmed)) return null;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}
