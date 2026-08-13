import { describe, expect, it } from 'vitest';
import { eventTypeMatches } from '../src/matching.js';

/**
 * §1a.1 — patterns are exact types or globs on dot-delimited segments.
 * `*` matches EXACTLY ONE segment; segment counts must match; no `**`.
 */

describe('§1a.1 event-type matching', () => {
  it('empty pattern list means all events', () => {
    expect(eventTypeMatches([], 'invoice.paid')).toBe(true);
    expect(eventTypeMatches([], 'anything')).toBe(true);
  });

  it('exact type matches only itself', () => {
    expect(eventTypeMatches(['invoice.paid'], 'invoice.paid')).toBe(true);
    expect(eventTypeMatches(['invoice.paid'], 'invoice.voided')).toBe(false);
    expect(eventTypeMatches(['invoice.paid'], 'invoice')).toBe(false);
  });

  it('* fills exactly one segment', () => {
    expect(eventTypeMatches(['invoice.*'], 'invoice.paid')).toBe(true);
    expect(eventTypeMatches(['invoice.*'], 'invoice')).toBe(false);
    expect(eventTypeMatches(['invoice.*'], 'invoice.payment.failed')).toBe(false);
    expect(eventTypeMatches(['*.paid'], 'invoice.paid')).toBe(true);
    expect(eventTypeMatches(['*'], 'invoice')).toBe(true);
    expect(eventTypeMatches(['*'], 'invoice.paid')).toBe(false);
  });

  it('any matching pattern in the list is enough (§1a.2 "iff any")', () => {
    expect(eventTypeMatches(['order.*', 'invoice.paid'], 'invoice.paid')).toBe(true);
    expect(eventTypeMatches(['order.*', 'user.*'], 'invoice.paid')).toBe(false);
  });

  it('patterns are not regex: no wildcard behavior from special chars', () => {
    expect(eventTypeMatches(['invoice.pai.'], 'invoice.paid')).toBe(false);
    expect(eventTypeMatches(['invoice.pa+d'], 'invoice.paid')).toBe(false);
  });
});
