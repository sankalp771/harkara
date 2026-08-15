# Changelog

All notable changes to Harkara. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/). Until 1.0, minor versions may adjust the
API surface; the delivery contract (SEMANTICS.md) only moves by
recorded amendment.

## [0.1.0] — 2026-08-16

First public release: the complete delivery contract, built phase by
phase with tests written from SEMANTICS.md clauses before code.

### Added

- **Transactional outbox** — `send()` joins the caller's transaction;
  acceptance is the caller's COMMIT (§1.3). Optional per-tenant
  `idempotencyKey` (§2.4), tenant-strict fan-out with dot-segment glob
  matching (§1a).
- **Worker** — single-loop claimer on `FOR UPDATE SKIP LOCKED`, global
  per-endpoint concurrency of 1 (§5.1), crash recovery keyed on
  `locked_at` with an in-worker reaper (§8).
- **Standard Webhooks signing** (§4) — stable `webhook-id`, signed
  timestamp, multi-secret zero-downtime rotation; verified in tests
  against the official `standardwebhooks` package as the oracle.
- **Retries + DLQ + replay** (§3, §6) — classification (config errors
  never die; 3xx never retries), jittered schedule, `Retry-After`
  honored capped on 429/503, `dead` parking, replay by delivery /
  endpoint / died-time-range — never automatic, same webhook-id, fresh
  seal.
- **Circuit breaker** (§5.2–5.3) — per-endpoint, failure-rate over a
  volume-floored window, exactly-one-probe half-open, doubling capped
  cooldown, retry budget suspended while open. Never trips on a
  success.
- **SSRF egress guard** (§9) — resolve once, vet every address against
  ranges (RFC1918, CGNAT, loopback, link-local incl. cloud metadata,
  multicast, IPv6 equivalents, v4-mapped/NAT64 unwrapped), pin the
  socket to the vetted IP; HTTPS by default with two explicit opt-ins;
  byte cap enforced during the streamed read; redirects never followed.
- **Ordering** (§7) — per-key acceptance order via sequence (never
  clock), death unblocks, replay re-enters at the back of the key,
  concurrency scope stated honestly in the contract.
- **`runMigrations()`** — hosts apply harkara's schema through one
  call, recorded in harkara's own `harkara_migrations` ledger (never
  node-pg-migrate's default table).
- **Docs** — generated per-section contract pages (CI-enforced fresh),
  quickstart, tested receiver dedup snippet, operations guide
  (probe-martyr, config-parked elders), honest comparison.

[0.1.0]: https://github.com/sankalp771/harkara/releases/tag/v0.1.0
