/**
 * §1a.1 — event-type matching. A pattern is an exact type or a glob on
 * dot-delimited segments where `*` matches EXACTLY ONE segment. Segment
 * counts must match; there is no `**` in v1 (widening later is
 * backward-compatible, narrowing never is).
 *
 * Pure string comparison, deliberately not regex: pattern characters have
 * no special meaning except a segment that is exactly `*`.
 */
export function eventTypeMatches(patterns: readonly string[], eventType: string): boolean {
  // §1a.1: an empty list means all events.
  if (patterns.length === 0) return true;
  const typeSegments = eventType.split('.');
  return patterns.some((pattern) => {
    const patternSegments = pattern.split('.');
    if (patternSegments.length !== typeSegments.length) return false;
    return patternSegments.every((seg, i) => seg === '*' || seg === typeSegments[i]);
  });
}
