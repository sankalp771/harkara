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
- [endpoints] the future endpoints/registration API must vet URLs (§9.1)
  at registration time for fast operator feedback — v1 has no
  registration API, so enforcement is delivery-time only (Phase 7 T5
  scope honesty; REBUILD_PLAN's "rejected at registration AND delivery"
  needs the API to exist first)

(idempotency key promoted to §2.4 on 2026-08-11 — ships in v1)

- [endpoints] firehose endpoints (one endpoint receiving events across all
  tenants) — rejected for v1 by §1a.4's strict tenant equality; would need
  its own contract clause and an explicit opt-in flag if ever wanted
- [secrets-api] creating a secret resets next_attempt_at = now for that
  endpoint's config-blocked deliveries — fix-triggers-resume (Phase 5
  rider 1: kills the up-to-1h resume-latency wart without multiplying
  refusal rows; lands with the future secrets/registration API)

(config-error bucket promoted to §3.2 on 2026-08-15 — Phase 5, ruled
never-dead with frozen schedule position; refusals × breaker ruled on
2026-08-15 — Phase 6 T1, refusals never feed the window; see Rejected)

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
- [docs] the probe-martyr pattern gets a NAMED paragraph in the Phase 9
  breaker docs — during a long outage one delivery absorbs the half-open
  probes and may die into the DLQ so the rest keep their budget (§5.3/T3);
  maintainer directive at Phase 6 approval
- [docs] the §9 docs must say 169.254.169.254 is blocked as a LINK-LOCAL
  RANGE member, never as a special-cased address — so the range check
  can't be "optimized" into an IP list (maintainer rider at Phase 7
  approval; the pure test pins a range neighbor for the same reason)
- [docs] the ordering docs need a named paragraph next to the
  probe-martyr: a config-parked elder (§3.2 never-dead) freezes its whole
  ordering key until a human fixes the config — deliberate (§7.1 as
  written; skipping ahead would break the promise for an operator
  mistake), support-ticket-shaped, and fix-triggers-resume is the latency
  remedy (maintainer rider at Phase 8 approval)

## Rejected (kept so we don't re-litigate)

- [breaker] config refusals feeding the failure-rate window (as failures
  OR as attempts) — rejected Phase 6 T1: the breaker measures the wire,
  refusals never touch it; feeding them in trips on operator mistakes and
  deadlocks the probe (a refusal can neither close nor reopen a circuit)
- [breaker] probe failures not incrementing attempt_count — rejected
  Phase 6 T3: creates a delivery that can never die and poisons the §6.1
  attempt diary; the probe-martyr dies visibly into the DLQ instead
- [breaker] cooldown memory across incidents — rejected Phase 6 T5: a
  recovered endpoint earns a clean slate on close; carrying doubled
  cooldowns across separate outages punishes past sins
