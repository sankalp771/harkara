import { describe, expect, it } from 'vitest';
import {
  classify,
  configDelayMs,
  DEFAULT_RETRY_SCHEDULE,
  nextDelayMs,
  parseRetryAfter,
} from '../src/retry.js';

/**
 * Phase 5 — pure retry logic from §3.2/§3.3. Classification is a table;
 * jitter/cap/exhaustion are bounds — no clocks, no DB.
 */

describe('§3.2 classification', () => {
  it('2xx is success', () => {
    expect(classify(200, 'http')).toBe('success');
    expect(classify(204, 'http')).toBe('success');
    expect(classify(299, 'http')).toBe('success');
  });

  it('5xx, 429, timeouts, connection errors are retryable', () => {
    expect(classify(500, 'http')).toBe('retryable');
    expect(classify(503, 'http')).toBe('retryable');
    expect(classify(599, 'http')).toBe('retryable');
    expect(classify(429, 'http')).toBe('retryable');
    expect(classify(null, 'network')).toBe('retryable'); // timeout / conn error
  });

  it('other 4xx and ALL 3xx are non-retryable — equally wrong tomorrow', () => {
    expect(classify(400, 'http')).toBe('nonRetryable');
    expect(classify(404, 'http')).toBe('nonRetryable');
    expect(classify(410, 'http')).toBe('nonRetryable');
    expect(classify(301, 'http')).toBe('nonRetryable'); // redirects are not followed (§9.2)
    expect(classify(302, 'http')).toBe('nonRetryable');
  });

  it('config refusals are their own bucket (§3.2 third class)', () => {
    expect(classify(null, 'config')).toBe('configError');
  });
});

describe('§3.3 schedule, jitter, cap', () => {
  const SCHEDULE = [10_000, 30_000, 120_000] as const;

  it('default schedule is 10s → 30s → 2m → 10m → 1h', () => {
    expect([...DEFAULT_RETRY_SCHEDULE]).toEqual([10_000, 30_000, 120_000, 600_000, 3_600_000]);
  });

  it('delay for failure N is schedule[N-1] with ±20% jitter, and jitter actually varies', () => {
    const samples = Array.from({ length: 200 }, () => nextDelayMs(1, SCHEDULE));
    for (const s of samples) {
      expect(s).not.toBe('dead');
      expect(s as number).toBeGreaterThanOrEqual(8_000);
      expect(s as number).toBeLessThanOrEqual(12_000);
    }
    expect(new Set(samples).size).toBeGreaterThan(1); // §3.3: jitter exists

    const third = nextDelayMs(3, SCHEDULE);
    expect(third as number).toBeGreaterThanOrEqual(96_000);
    expect(third as number).toBeLessThanOrEqual(144_000);
  });

  it('exhausting the schedule is dead — schedule.length + 1 total attempts', () => {
    expect(nextDelayMs(SCHEDULE.length + 1, SCHEDULE)).toBe('dead');
    expect(nextDelayMs(99, SCHEDULE)).toBe('dead');
    expect(nextDelayMs(SCHEDULE.length, SCHEDULE)).not.toBe('dead');
  });

  it('Retry-After is used verbatim (no jitter), capped at the max step', () => {
    expect(nextDelayMs(1, SCHEDULE, 2_000)).toBe(2_000);
    // hostile / oversized value → the cap is the max schedule step
    expect(nextDelayMs(1, SCHEDULE, 999_999_999)).toBe(120_000);
    // Retry-After cannot resurrect an exhausted schedule
    expect(nextDelayMs(SCHEDULE.length + 1, SCHEDULE, 1_000)).toBe('dead');
  });

  it('config errors wait at the max step and never exhaust', () => {
    for (let i = 0; i < 50; i++) {
      const d = configDelayMs(SCHEDULE);
      expect(d).toBeGreaterThanOrEqual(96_000);
      expect(d).toBeLessThanOrEqual(144_000);
    }
  });
});

describe('Retry-After parsing', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('2')).toBe(2_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('parses HTTP-dates as a delta from now, clamped at 0', () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const parsed = parseRetryAfter(future);
    expect(parsed).not.toBeNull();
    expect(parsed!).toBeGreaterThan(3_000);
    expect(parsed!).toBeLessThanOrEqual(5_500);

    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });

  it('garbage and absence are null (fall back to the schedule)', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('-5')).toBeNull();
  });
});
