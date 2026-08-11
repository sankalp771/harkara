# LAWL Rebuild Plan

Companion to `SEMANTICS.md`. Every phase lists: the clauses it implements,
the tests that prove them, and the explain-back gate. A phase is DONE when
its tests pass in CI against real Postgres AND you can explain the design
out loud without looking.

Rule of the whole build: **tests are written from the clauses BEFORE the
implementation.** Agent output quality is capped by CI quality — the tests
are the cage the agent works inside.

Workflow per phase: one Claude Code session, Plan Mode first (Shift+Tab
twice), point it at the phase section + the named clauses, approve the plan,
let it implement against the pre-written tests. New ideas mid-session go to
`BACKLOG.md`, not into the session.

---

## Phase 0 — Scaffolding (half a day)

No product code. Skeleton only:
- TypeScript strict, single package `lawl`, `src/` + `test/`
- vitest + testcontainers (or docker-compose Postgres) for integration tests
- `node-pg-migrate` wired: `lawl` never runs raw schema.sql at boot
- GitHub Actions CI: lint, typecheck, migrate, full test suite vs real
  Postgres service container. CI red = nothing merges. This is the
  foundation everything else stands on.
- `SEMANTICS.md`, `CLAUDE.md`, `BACKLOG.md` in repo root

Gate: CI runs green on a hello-world test that talks to real Postgres.

## Phase 1 — Schema + storage layer (§1.3, §6.1, §8.1)

Tables: `messages`, `endpoints`, `endpoint_secrets` (many per endpoint —
rotation needs it, §4.5), `deliveries`, `delivery_attempts`.

Non-negotiables from the audit:
- `deliveries.locked_at TIMESTAMPTZ` + `locked_by` — §8 depends on it
- Partial unique index on `(message_id, endpoint_id) WHERE status != 'dead'`
  and NO table-level unique constraint — replay must be insertable (§6.2).
  Write the migration test that inserts a dead row then a fresh one.
- No global `UNIQUE(url)` on endpoints
- `tenant_id` column from day one (nullable, default single-tenant)

Tests: migration up/down clean; the replay-insert test; concurrent insert
with ON CONFLICT behaves.

Gate: explain why the partial index exists and what bug the old repo had.

## Phase 2 — Send API (§1.1–1.3, §2.1)

`lawl.send(event, { tx? })` — the transactional outbox headline feature:
when a caller passes their own transaction/client, the message insert joins
their COMMIT. Acknowledge only after commit. Message id generated here,
stable forever (§2.1).

Tests: send inside a rolled-back tx → no message exists; send without tx →
persisted before the promise resolves; fan-out creates one delivery per
matching endpoint in the same tx.

Gate: explain the crash window that 202-before-persist created in old LAWL
and why persist-then-ack closes it.

## Phase 3 — Worker loop + crash recovery (§5.1, §8)

Single async loop (no setInterval overlap), claim batch via
`FOR UPDATE SKIP LOCKED` setting `locked_at`/`locked_by`, deliver with
bounded global concurrency AND per-endpoint concurrency of 1 (kills
head-of-line blocking across endpoints, §5.1). Reaper runs inside the loop
every N seconds: `locked_at` older than visibility timeout → back to
pending (§8.1–8.2). Graceful shutdown finishes in-flight attempts.

Tests (the fun ones):
- Two workers, 10k messages, zero double-claims
- kill -9 mid-delivery → message redelivered, never lost (§8.3)
- One endpoint sleeping 5s does not delay other endpoints' deliveries
- Reaper ignores a freshly-claimed old row (the created_at bug, inverted)

Gate: explain locked_at vs created_at recovery and the double-delivery bug
the old repo had.

## Phase 4 — Standard Webhooks signing (§4)

Headers, `{id}.{timestamp}.{payload}` signed content, `v1,` + base64,
`whsec_` secrets, multi-secret signing for rotation windows.

Tests: **verify LAWL's output with the official `standard-webhooks` npm
library** — the spec's own reference verifier is the oracle, not our own
code. Rotation test: two active secrets → two signatures in header → old
verifier and new verifier both accept. Tampered timestamp header → official
verifier rejects.

Gate: explain the replay attack and why the timestamp lives inside the
signed content (the envelope-date story).

## Phase 5 — Retries + DLQ + replay (§3, §6)

Failure classification (retryable vs not, §3.2), schedule with jitter
(§3.3), Retry-After honored capped, transition to dead, replay API
(per-delivery, per-endpoint, time-range §6.3) creating fresh deliveries
with the SAME webhook-id and fresh timestamp/signature (§6.2).

Tests: 4xx goes straight to dead; 5xx follows schedule; replayed delivery
carries original webhook-id; response bodies capped and stored.

Gate: explain why replay keeps the id but re-signs with a new timestamp.

## Phase 6 — Circuit breaker (§5.2–5.3)

Per-endpoint, failure-rate over sliding window, three states, half-open
single probe, doubling cooldown capped, retry clocks suspended while open.
State lives in Postgres (workers share it), checked cheaply — no COUNT(*)
on the hot path (precompute/window table).

Tests: breaker opens on rate not backlog; exactly one probe in half-open;
probe success closes and drains; probe failure doubles cooldown; suspended
messages don't burn retry budget.

Gate: explain the livelock in old LAWL's breaker and why half-open is
mandatory.

## Phase 7 — SSRF guard (§9)

Resolve → reject private/loopback/link-local/metadata ranges → pin the
vetted IP for the actual request → no cross-origin redirects → byte cap and
total-time cap on body read → HTTPS default.

Tests: 169.254.169.254 rejected at registration AND at delivery time;
DNS-rebind simulation (hostname resolving to public then private) blocked;
slow-drip body killed by total-time cap.

Gate: explain DNS rebinding in two sentences.

## Phase 8 — Ordering (§7) [optional for v1 launch]

Ordering-key column, NOT EXISTS claim guard on (key, endpoint), documented
unblock-on-dead behavior. Ship v1 without it if time is short — unordered
at-least-once is an honest, launchable contract.

## Phase 9 — Ship

- README: the 5-minute quickstart, the dedup snippet for receivers, the
  honest comparison table (Svix / Outpost / Convoy / Postel / pg-boss)
- Docs pages generated from SEMANTICS.md sections
- `npm publish` (name check first), CHANGELOG, tags
- Launch posts: Show HN with SEMANTICS.md as the centerpiece; the SSRF
  writeup as a separate follow-up post

---

## Session log

Keep a one-line-per-session log here: date, phase, what merged, what got
kicked to BACKLOG.md. This becomes the build-in-public thread almost
verbatim.
