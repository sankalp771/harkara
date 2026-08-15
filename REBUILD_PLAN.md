# Harkara Rebuild Plan

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

- TypeScript strict, single package `harkara`, `src/` + `test/`
- vitest + testcontainers (or docker-compose Postgres) for integration tests
- `node-pg-migrate` wired: `harkara` never runs raw schema.sql at boot
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

`harkara.send(event, { tx? })` — the transactional outbox headline feature:
when a caller passes their own transaction/client, the message insert joins
their COMMIT. Acknowledge only after commit. Message id generated here,
stable forever (§2.1).

Tests: send inside a rolled-back tx → no message exists; send without tx →
persisted before the promise resolves; fan-out creates one delivery per
matching endpoint in the same tx.

Gate: explain the crash window that 202-before-persist created in old Harkara
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

Tests: **verify Harkara's output with the official `standard-webhooks` npm
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

Gate: explain the livelock in old Harkara's breaker and why half-open is
mandatory.

## Phase 7 — SSRF guard (§9)

Resolve → reject private/loopback/link-local/metadata ranges → pin the
vetted IP for the actual request → re-vet every redirect hop (§9.2) →
byte cap and total-time cap on body read → HTTPS default.

Requirement from the Phase 3 review: the byte cap is enforced DURING the
streamed read, not by truncating after buffering — Phase 3's interim
`response.text().slice(4096)` still buffers a hostile-sized body in
memory before slicing; Phase 7 replaces it with a reader that aborts at
the cap.

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

### 2026-08-11 — pre-phase-0: spec review amendments

Agent reviewed the contract, flagged five holes, touched nothing;
maintainer ruled on each. Four of five were drafting bugs in the spec.

1. **§1.3 spoke of HTTP 202 acks** — leftover from service-shaped
   thinking; Harkara is a library with no HTTP API. Ruling: fixed —
   `send()`'s promise resolves only after commit; with a caller tx,
   acceptance is the caller's own COMMIT.
2. **"Matching endpoint" was never defined** anywhere, yet Phase 1
   freezes the schema. Ruling: fixed, new §1a — event-type patterns with
   dot-segment globs, empty list = all events, **send-time binding**
   (late-binding to new endpoints explicitly rejected for v1; replay is
   the tool for backfill).
3. **Plain `send()` retry mints a fresh webhook-id**, defeating receiver
   dedup — §2.3's "effectively-once" was quietly false for that path.
   Ruling: fix in v1, not backlog — new §2.4 optional `idempotencyKey`.
4. **§6.1 "never deleted" = unbounded growth** in the host's own
   Postgres. Ruling: promise softened now ("parked until explicitly
   pruned"); the prune API ships with Phase 5.
5. **§9.2 allowed same-origin redirects**, which reopens the DNS
   rebinding window (302-to-self with flipped resolution). Ruling: fixed
   — every hop re-resolved, re-vetted, re-pinned; hop count capped.

Plus: §5.2 now marks the per-endpoint drain serialization as
load-bearing so no future session "optimizes" it away.

Process note: flag → rule → amend contract → only then code. This
exchange is the methodology in miniature.

### 2026-08-15 — phase-7: SSRF guard (PR #10)

§9 live, zero new dependencies and zero schema changes. The headline is
the ⚠ FLAG: the plan caught §9.2 ("every followed redirect hop is
re-vetted") contradicting §3.2's Phase 5 ruling (redirects never
followed, 3xx → dead) — the contract review process caught its own
author, and the maintainer ratified the safer resolution: **redirects
stay dead**, §9.2 rewritten so no dormant clause invites a future
"helpful" redirect follower. T1–T5 ratified: pin via ONE resolution
per attempt (node:http/https dialing the vetted address while Host/SNI/
cert stay on the hostname — the rebind TOCTOU window is structurally
absent, and the test proves `resolver` was called exactly once against
a .invalid hostname that real DNS cannot serve); all-or-nothing DNS
answer vetting (one poisoned record kills the set); egress refusals
join the §3.2 config bucket (no wire → never dead, NULL attempt_number,
breaker-invisible) while NXDOMAIN stays network-retryable; the status
line decides while the caps protect resources (a 200-then-drip is
DELIVERED with a truncated body — retrying it would manufacture the
§1.2 duplicates the contract promises are rare); two independent
opt-ins (allowInsecureHttp §9.3, allowPrivateAddresses) both default
off — every pre-Phase-7 test now runs with them ON, which is itself
the proof the opt-ins restore delivery. Riders: NAT64 64:ff9b::/96
unwraps like v4-mapped; metadata blocked as a link-local RANGE member
(the pure test pins 169.254.0.1 alongside 169.254.169.254 so the range
check can never become an IP list). Byte cap moved from
truncate-after-buffer to destroy-at-4096-DURING-read, observed from
outside: the receiver sees its own socket die mid-write. Kicked to
BACKLOG: registration-time vetting (needs the future endpoints API).

### 2026-08-15 — phase-6: circuit breaker (PR #9)

§5.2/§5.3 live: per-endpoint three-state breaker, state shared through a
lazy endpoint_breakers row (missing row = closed), tumbling-window
counters so the hot path never COUNT(*)s, half-open probe riding the
§5.1 exclusivity machinery unchanged (endpoint lock + NOT EXISTS +
demote — a crashed probe is reaped and simply re-probed). T1–T5 ratified
at plan approval: **refusals never feed the window** (Phase 5 rider 3
discharged: the breaker measures the wire, refusals never touch it);
breaker failure = §3.1 failure (non-retryable counts too); **probes burn
real budget** (the probe-martyr may die into the DLQ — visible,
replayable, never a zombie); tumbling window over sliding; separate
state table over endpoint columns. Cooldown doubles per failed probe,
capped, and resets on close — clean slate ratified.

Bug story earned live: first full-suite run, Phase 5's replay test
caught the breaker **tripping on a SUCCESS** — three 410s then a replay:
the successes met the volume floor while stale failures still dominated
the rate (3/5 = 60%), and the drain froze for a 30s cooldown. Ruling
folded into the transition: only a failure can trip; a success only
updates counters (on a success the rate can only fall — crossing the
floor on good news is a floor artifact, not evidence). Pinned by unit
test. §5.3 suspension is positional, not temporal: budget is attempts,
open means no attempts, so an outage burns nothing — proven by the
frozen-attempt-counts test. Kicked to BACKLOG: probe-martyr named
paragraph for the Phase 9 docs.

### 2026-08-15 — phase-5: retries + DLQ + replay (PR #8)

Phase 3's interim scaffolding retired: §3.2 classification (4xx/3xx →
dead instantly; 5xx/429/timeouts follow the §3.3 schedule with ±20%
jitter to exhaustion), Retry-After honored on 429 AND 503 verbatim but
capped (T2 extension), and the config-error bucket ruled never-dead with
frozen schedule position (T1 + riders: refusal rows carry NULL
attempt_number; fix-triggers-resume queued for the secrets API; P6 must
rule on refusals × breaker). Migration 3: dead_at + partial indexes,
attempt_number nullable. Replay API (§6.2/6.3): per-delivery,
per-endpoint, time-range on dead_at — fresh delivery, same webhook-id,
fresh seal (oracle-verified), dead rows parked untouched, never
automatic (asserted: dead + running worker + time = zero traffic). The
replay arbiter is Phase 1's partial unique index — the old repo's broken
constraint is now load-bearing for the feature it used to prevent.
"No usable-now claim" caveat lifted: failing endpoints now cost
schedule+1 attempts, not infinity.

### 2026-08-14 — phase-4: Standard Webhooks signing (PR #7)

Every delivery now carries webhook-id / webhook-timestamp /
webhook-signature, and the acceptance authority is the official
standardwebhooks package verifying captured wire bytes (oracle rule —
npm name has no hyphen, the spec/org name does). Rotation proven the
§4.5 way: two active secrets → one header, two signatures → a verifier
holding ONLY the old key and one holding ONLY the new key both accept
the same request. Revocation stops signing immediately. Tamper tests pin
§4.3 (edited timestamp or body → oracle rejects). T1 ruling live: zero
active secrets → refusal recorded, never an unsigned request (Phase 5
owes this a config-error classification — BACKLOG). T2: fresh seal per
attempt, webhook-id stable across retries. HMAC key = base64-DECODED
whsec_ payload (the #1 interop mistake, pinned by test). Phase 3
fixtures gained secrets (§4.1 has no exceptions, tests included).

### 2026-08-13 — phase-3: worker loop + crash recovery (PR #6)

The hard one. Single-loop worker, claim-and-mark in ONE statement,
reaper keyed on locked_at only, graceful stop. Per-endpoint concurrency
1 is GLOBAL (T1 ruling): endpoint-row lock + NOT EXISTS + post-claim
verify-demote. The 10k throughput test EARNED ITS KEEP: first run
double-delivered 195/10000 because the claim subquery locked only
endpoint rows — a stale READ COMMITTED snapshot let EvalPlanQual re-apply
the IN-set to an already-claimed delivery. Fix: FOR UPDATE SKIP LOCKED on
the delivery rows inside the LATERAL (the lock chain re-evaluates quals
on the newest row version). Also: migration 2 (claim-path indexes —
Phase 1's next_attempt_at index couldn't serve per-endpoint lookups; the
10k test crawled until they existed). Real node:http receiver harness +
real SIGKILLed child process per maintainer directive; tsx added
(dev-only) to run the TS child. Interim scaffolding flagged: uniform 5s
retry until Phase 5, unsigned deliveries until Phase 4.

### 2026-08-13 — phase-2: send API (PR #4)

The headline feature: harkara.send(event, { tx? }) — transactional
outbox. Persist-then-resolve without a tx; with a caller tx, send() joins
their COMMIT and acks nothing itself (proven by an observer-connection
test that sees nothing pre-COMMIT, everything post). Fan-out per §1a in
the same tx via a pure, unit-tested matcher. §2.4 idempotencyKey wired to
Phase 1's NULLS NOT DISTINCT arbiter index. Two contract amendments
ratified at plan approval: §1a.1 glob = exactly-one-segment; new §1a.4
tenant-strict matching (firehose endpoints → BACKLOG). First real src/
code — the no-any lint gate is now guarding product code.

### 2026-08-12 — phase-1: schema (PR #2)

Five tables, tests-from-clauses first (auditable in the git log: tests
commit precedes migration commit). Load-bearing details: partial unique
index on deliveries (message_id, endpoint_id) WHERE status <> 'dead' —
replay insertable, the old repo's bug inverted; NULLS NOT DISTINCT on the
idempotency index (single-tenant NULL rows); payload as TEXT not JSONB
(byte-stable for §4.2 signing). Review flagged one silent decision made
loud: NULLS NOT DISTINCT sets a Postgres floor → SEMANTICS §11 adopts a
rolling policy ("all non-EOL versions", today 15+) and CI tests the floor
(PG 15 + 17 matrix). Known fallback if a real PG14 user ever appears:
COALESCE(tenant_id, '') expression index — on request, not preemptively. Kicked to backlog: endpoint
deletion semantics (disable-not-delete question). MIT license added.

### 2026-08-12 — phase-0: scaffolding merged (PR #1)

Strict TS skeleton, vitest against real Postgres (testcontainers locally /
service container in CI, one code path), node-pg-migrate wired, CI gate
live: lint → format → typecheck → migrate → test. Phase gate met — CI
green on a hello-world test talking to real Postgres. Nothing kicked to
backlog.
