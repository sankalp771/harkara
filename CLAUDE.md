# CLAUDE.md — LAWL

You are working on LAWL, an embeddable webhook delivery library for
Node/TypeScript apps using their existing Postgres. Library, not service:
no Redis, no broker, no separate dispatcher. "The Sidekiq of webhooks."

## Authority order
1. `SEMANTICS.md` — the contract. If code and SEMANTICS.md disagree, the
   code is wrong. Never change SEMANTICS.md to make a test pass; flag the
   conflict and stop.
2. `REBUILD_PLAN.md` — current phase scope. Do not implement future phases.
3. This file.

## Hard rules
- Tests come from SEMANTICS clauses and are written/agreed BEFORE
  implementation. Never weaken, skip, or delete a failing test to go green.
- All schema changes via node-pg-migrate migrations. Never edit an already
  merged migration; write a new one. Never load schema from a .sql file at
  runtime.
- Integration tests run against real Postgres, not mocks. Concurrency
  claims (SKIP LOCKED, reaper, breaker) are only proven on the real thing.
- Never log secrets, DATABASE_URL, or full payloads. Response bodies stored
  truncated.
- Signing must verify against the official `standard-webhooks` npm package
  in tests — it is the oracle.
- No new runtime dependencies without listing them and why in the plan
  step. Target: tiny dependency tree (pg, node-pg-migrate, little else).
- Public API surface changes (exports, options, table names) are a
  stop-and-ask. They outlive any session.

## Conventions
- TypeScript strict; no `any` in src/ (tests may).
- One feature per session, Plan Mode first, plan approved before code.
- Mid-session ideas go to BACKLOG.md as one-liners. Do not implement them.
- Commit style: `phase-N: <what>` — e.g. `phase-3: reaper uses locked_at`.
- Every merged PR updates the Session log section in REBUILD_PLAN.md.

## Definition of done for any task
1. Named SEMANTICS clauses have passing tests in CI.
2. No unrelated files touched.
3. A 3-line summary the maintainer (a human, learning this domain) can
   read and explain back. Write for him, not for yourself.
