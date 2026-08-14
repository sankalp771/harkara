# Harkara — Backlog

One-liners only. Ideas that surface mid-session land here instead of
derailing the current phase. Promotion out of this file means: it gets a
SEMANTICS clause (if it changes the contract) or a REBUILD_PLAN phase
entry (if it's pure implementation), agreed tests, and only then code.

Format: `- [area] idea — why it might matter`

## Contract-adjacent (needs a SEMANTICS decision before any code)

- [dlq] prune API for dead deliveries — §6.1 now promises "parked until
  explicitly pruned"; the human-invoked prune itself lands with Phase 5
- [endpoints] deletion semantics undefined — deliveries.endpoint_id has no
  ON DELETE, so any endpoint with history can never be deleted (FK
  violation); probably right (history is forensic, §6.1) but then the API
  needs disable-not-delete — must be a written decision, not an FK accident

(idempotency key promoted to §2.4 on 2026-08-11 — ships in v1)

- [endpoints] firehose endpoints (one endpoint receiving events across all
  tenants) — rejected for v1 by §1a.4's strict tenant equality; would need
  its own contract clause and an explicit opt-in flag if ever wanted
- [secrets-api] creating a secret resets next_attempt_at = now for that
  endpoint's config-blocked deliveries — fix-triggers-resume (Phase 5
  rider 1: kills the up-to-1h resume-latency wart without multiplying
  refusal rows; lands with the future secrets/registration API)
- [P6] the breaker plan must explicitly rule whether config-refusal
  attempt rows feed the failure-rate window (Phase 5 rider 3 — possibly
  desirable, but decided, not emergent)

(config-error bucket promoted to §3.2 on 2026-08-15 — Phase 5, ruled
never-dead with frozen schedule position)

- [send] §2.4 key reuse with mismatched payload — today Harkara silently
  returns the original message; Stripe treats it as an explicit error,
  which catches real caller bugs (key derived from the wrong variable).
  Silent-return is a defensible v1 choice but it is a choice — re-litigate

## Implementation ideas (no contract change)

- [ops] `harkara doctor` — one command that checks migrations applied,
  index health, and worker liveness against the host's Postgres
- [observability] emit delivery lifecycle events (attempt, dead, breaker
  state change) via an EventEmitter so hosts can wire their own metrics
- [docs] serverless caveat — the worker loop assumes a long-lived process;
  document that Lambda-style hosts need a pinned worker or scheduled runner

## Rejected (kept so we don't re-litigate)

- (empty)
