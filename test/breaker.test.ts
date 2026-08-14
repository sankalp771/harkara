import { describe, expect, it } from 'vitest';
import {
  applyOutcome,
  DEFAULT_BREAKER,
  type BreakerConfig,
  type BreakerRow,
} from '../src/breaker.js';

/**
 * Phase 6 — pure breaker transitions from §5.2/§5.3. The executor
 * supplies outcomes and clocks; this module supplies decisions — same
 * pattern as retry.ts.
 */

const CFG: BreakerConfig = {
  windowMs: 60_000,
  minAttempts: 3,
  failureRate: 0.5,
  cooldownMs: 400,
  maxCooldownMs: 1_600,
};

const NOW = 1_000_000;

function closedRow(overrides: Partial<BreakerRow> = {}): BreakerRow {
  return {
    state: 'closed',
    windowStartedAt: null,
    windowAttempts: 0,
    windowFailures: 0,
    cooldownMs: null,
    openedAt: null,
    openUntil: null,
    ...overrides,
  };
}

function feed(row: BreakerRow, outcomes: boolean[], cfg = CFG, startAt = NOW): BreakerRow {
  let r = row;
  outcomes.forEach((isFailure, i) => {
    r = applyOutcome(r, isFailure, cfg, startAt + i);
  });
  return r;
}

describe('§5.2 trip: failure rate over a window, with a volume floor', () => {
  it('defaults are the ratified contract values', () => {
    expect(DEFAULT_BREAKER).toEqual({
      windowMs: 60_000,
      minAttempts: 5,
      failureRate: 0.5,
      cooldownMs: 30_000,
      maxCooldownMs: 600_000,
    });
  });

  it('below the volume floor nothing trips — one failure is 100% but not a rate', () => {
    const one = applyOutcome(closedRow(), true, CFG, NOW);
    expect(one.state).toBe('closed');
    expect(one.windowAttempts).toBe(1);
    expect(one.windowFailures).toBe(1);

    const two = feed(closedRow(), [true, true]);
    expect(two.state).toBe('closed'); // floor is 3
  });

  it('trips at the floor when the rate is met, and stamps the cooldown', () => {
    const tripped = feed(closedRow(), [true, true, true]);
    expect(tripped.state).toBe('open');
    expect(tripped.cooldownMs).toBe(CFG.cooldownMs);
    expect(tripped.openedAt).toBe(NOW + 2);
    expect(tripped.openUntil).toBe(NOW + 2 + CFG.cooldownMs);
  });

  it('does not trip below the rate even with volume — backlog of successes keeps it closed', () => {
    // 7 successes then 3 failures: 3/10 = 30% < 50%.
    const row = feed(closedRow(), [...Array<boolean>(7).fill(false), true, true, true]);
    expect(row.state).toBe('closed');
    expect(row.windowAttempts).toBe(10);
    expect(row.windowFailures).toBe(3);
  });

  it('non-retryable failures count too — §3.1 defines failure, not the retry table (T2)', () => {
    // The caller maps ANY non-2xx to isFailure=true; this pins that the
    // transition itself has no second taxonomy: 3 failures = trip,
    // whatever their §3.2 classification was.
    const tripped = feed(closedRow(), [true, true, true]);
    expect(tripped.state).toBe('open');
  });

  it('a stale window rolls before counting — old failures do not haunt the rate', () => {
    const two = feed(closedRow(), [true, true]); // 2/2, floor not met
    // Third failure arrives one window later: counters restart at 1/1.
    const rolled = applyOutcome(two, true, CFG, NOW + CFG.windowMs + 1);
    expect(rolled.state).toBe('closed');
    expect(rolled.windowAttempts).toBe(1);
    expect(rolled.windowFailures).toBe(1);
    expect(rolled.windowStartedAt).toBe(NOW + CFG.windowMs + 1);
  });
});

describe('§5.2 half-open probe outcomes', () => {
  const open = feed(closedRow(), [true, true, true]);
  const halfOpen: BreakerRow = { ...open, state: 'half_open' };

  it('probe success closes, resets the window AND the cooldown — clean slate', () => {
    const closed = applyOutcome(halfOpen, false, CFG, NOW + 10_000);
    expect(closed.state).toBe('closed');
    expect(closed.windowAttempts).toBe(0);
    expect(closed.windowFailures).toBe(0);
    expect(closed.windowStartedAt).toBeNull();
    expect(closed.cooldownMs).toBeNull();
    expect(closed.openedAt).toBeNull();
    expect(closed.openUntil).toBeNull();
  });

  it('probe failure reopens with a doubled cooldown and a moved open_until', () => {
    const reopened = applyOutcome(halfOpen, true, CFG, NOW + 10_000);
    expect(reopened.state).toBe('open');
    expect(reopened.cooldownMs).toBe(800);
    expect(reopened.openUntil).toBe(NOW + 10_000 + 800);
    // openedAt keeps the start of the INCIDENT, not of this reopening.
    expect(reopened.openedAt).toBe(open.openedAt);
  });

  it('doubling caps at maxCooldownMs', () => {
    let row = halfOpen;
    for (let i = 0; i < 5; i++) {
      row = applyOutcome(row, true, CFG, NOW + 20_000 + i);
      expect(row.state).toBe('open');
      row = { ...row, state: 'half_open' }; // the claim query's flip
    }
    expect(row.cooldownMs).toBe(CFG.maxCooldownMs); // 400→800→1600, capped
  });
});

describe('defensive: outcomes recorded under open never change state', () => {
  it('a straggler outcome while open updates counters only', () => {
    const open = feed(closedRow(), [true, true, true]);
    const afterSuccess = applyOutcome(open, false, CFG, NOW + 100);
    expect(afterSuccess.state).toBe('open');
    expect(afterSuccess.openUntil).toBe(open.openUntil);
    const afterFailure = applyOutcome(open, true, CFG, NOW + 100);
    expect(afterFailure.state).toBe('open');
    expect(afterFailure.cooldownMs).toBe(open.cooldownMs); // no doubling outside a probe
  });
});
