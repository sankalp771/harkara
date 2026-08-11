# Harkara — Backlog

One-liners only. Ideas that surface mid-session land here instead of
derailing the current phase. Promotion out of this file means: it gets a
SEMANTICS clause (if it changes the contract) or a REBUILD_PLAN phase
entry (if it's pure implementation), agreed tests, and only then code.

Format: `- [area] idea — why it might matter`

## Contract-adjacent (needs a SEMANTICS decision before any code)

- [send] optional caller-supplied idempotency key on `send()` — the non-tx
  path lets an app retry a failed `send()` and create a second message with
  a new webhook-id that receiver dedup can't catch
- [dlq] retention/pruning API for dead deliveries — §6.1 says "never
  deleted", which is honest but unbounded; a human-invoked prune with an
  age floor keeps the promise's spirit without eating the host's disk

## Implementation ideas (no contract change)

- [ops] `harkara doctor` — one command that checks migrations applied,
  index health, and worker liveness against the host's Postgres
- [observability] emit delivery lifecycle events (attempt, dead, breaker
  state change) via an EventEmitter so hosts can wire their own metrics
- [docs] serverless caveat — the worker loop assumes a long-lived process;
  document that Lambda-style hosts need a pinned worker or scheduled runner

## Rejected (kept so we don't re-litigate)

- (empty)
