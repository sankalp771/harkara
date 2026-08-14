/**
 * §5.2/§5.3 — circuit breaker transitions. Pure functions, the retry.ts
 * pattern: the executor supplies outcomes and clocks, this module
 * supplies decisions. The caller decides what counts as a failure
 * (any non-2xx real attempt, §3.1) and NEVER calls this for config
 * refusals — they carry no evidence about the wire (T1).
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerConfig {
  /** Failure-rate window (tumbling: counters reset when it goes stale). */
  windowMs: number;
  /** Volume floor — below this many attempts, a rate is not a rate. */
  minAttempts: number;
  /** Trip threshold in (0, 1]. */
  failureRate: number;
  /** Base open cooldown; each failed probe doubles it… */
  cooldownMs: number;
  /** …capped here. */
  maxCooldownMs: number;
}

/** Ratified defaults (Phase 6 plan). */
export const DEFAULT_BREAKER: BreakerConfig = {
  windowMs: 60_000,
  minAttempts: 5,
  failureRate: 0.5,
  cooldownMs: 30_000,
  maxCooldownMs: 600_000,
};

/** Mirror of an endpoint_breakers row; all timestamps in ms epoch. */
export interface BreakerRow {
  state: BreakerState;
  windowStartedAt: number | null;
  windowAttempts: number;
  windowFailures: number;
  cooldownMs: number | null;
  openedAt: number | null;
  openUntil: number | null;
}

/**
 * Fold one recorded outcome into the breaker row.
 *
 * - closed: roll the window if stale, count the attempt, trip when both
 *   the volume floor and the rate are met.
 * - half_open: this outcome IS the probe (per-endpoint in-flight is 1 by
 *   §5.1, so nothing else can record under half_open). Success closes
 *   with a clean slate — window reset AND cooldown back to base (§5.2).
 *   Failure reopens with a doubled, capped cooldown; openedAt keeps the
 *   start of the incident.
 * - open: defensively counters-only. No path should record here (claims
 *   are excluded while open), but a straggler must never flip state.
 */
export function applyOutcome(
  row: BreakerRow,
  isFailure: boolean,
  cfg: BreakerConfig,
  nowMs: number,
): BreakerRow {
  if (row.state === 'half_open') {
    if (!isFailure) {
      return {
        state: 'closed',
        windowStartedAt: null,
        windowAttempts: 0,
        windowFailures: 0,
        cooldownMs: null,
        openedAt: null,
        openUntil: null,
      };
    }
    const doubled = Math.min((row.cooldownMs ?? cfg.cooldownMs) * 2, cfg.maxCooldownMs);
    return {
      ...row,
      state: 'open',
      cooldownMs: doubled,
      openUntil: nowMs + doubled,
    };
  }

  const stale = row.windowStartedAt === null || nowMs - row.windowStartedAt > cfg.windowMs;
  const counted: BreakerRow = {
    ...row,
    windowStartedAt: stale ? nowMs : row.windowStartedAt,
    windowAttempts: (stale ? 0 : row.windowAttempts) + 1,
    windowFailures: (stale ? 0 : row.windowFailures) + (isFailure ? 1 : 0),
  };

  if (row.state === 'open') return counted; // stragglers never flip state

  // Only a FAILURE can trip. A success can meet the volume floor while
  // stale failures still dominate the rate (found live: replaying after
  // an endpoint recovered tripped the breaker mid-drain) — but a breaker
  // must never open on the news that the endpoint is healthy.
  const trips =
    isFailure &&
    counted.windowAttempts >= cfg.minAttempts &&
    counted.windowFailures / counted.windowAttempts >= cfg.failureRate;
  if (!trips) return counted;
  return {
    ...counted,
    state: 'open',
    cooldownMs: cfg.cooldownMs,
    openedAt: nowMs,
    openUntil: nowMs + cfg.cooldownMs,
  };
}
