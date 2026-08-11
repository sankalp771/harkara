# Harkara — Backlog

One-liners only. Ideas that surface mid-session land here instead of
derailing the current phase. Promotion out of this file means: it gets a
SEMANTICS clause (if it changes the contract) or a REBUILD_PLAN phase
entry (if it's pure implementation), agreed tests, and only then code.

Format: `- [area] idea — why it might matter`

## Contract-adjacent (needs a SEMANTICS decision before any code)

- [dlq] prune API for dead deliveries — §6.1 now promises "parked until
  explicitly pruned"; the human-invoked prune itself lands with Phase 5

(idempotency key promoted to §2.4 on 2026-08-11 — ships in v1)

## Implementation ideas (no contract change)

- [ops] `harkara doctor` — one command that checks migrations applied,
  index health, and worker liveness against the host's Postgres
- [observability] emit delivery lifecycle events (attempt, dead, breaker
  state change) via an EventEmitter so hosts can wire their own metrics
- [docs] serverless caveat — the worker loop assumes a long-lived process;
  document that Lambda-style hosts need a pinned worker or scheduled runner

## Rejected (kept so we don't re-litigate)

- (empty)
