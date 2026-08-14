# Harkara

Harkara is an embeddable webhook delivery engine for Node/TypeScript apps,
built on the Postgres you already run — a **library, not a service**. No
Redis, no broker, no separate dispatcher to deploy: `npm install`, point it
at your pool, and your webhooks get a transactional outbox, Standard
Webhooks signing, retries with backoff, a dead letter queue, and replay.
The Sidekiq of webhooks.

> ⚠️ **In active development — not yet published to npm.** The delivery
> contract, including the full story of what happens to a failing
> endpoint, lives in [SEMANTICS.md](SEMANTICS.md). If the code and that
> document disagree, the code is wrong.

## Progress

Built phase by phase, tests-from-contract first, every phase verified
against real Postgres in CI:

- [x] **Phase 0 — Scaffolding**: strict TS, vitest vs real Postgres, CI gate
- [x] **Phase 1 — Schema**: replay-safe partial unique index, `NULLS NOT DISTINCT` idempotency
- [x] **Phase 2 — Send API**: the transactional outbox — `send()` joins _your_ COMMIT
- [x] **Phase 3 — Worker**: `SKIP LOCKED` claims, global per-endpoint serialization, crash recovery (kill -9 tested)
- [x] **Phase 4 — Signing**: Standard Webhooks, verified by the official library as the test oracle
- [x] **Phase 5 — Retries + DLQ + replay**: classification, jittered schedule, `Retry-After`, dead letter parking, replay by delivery/endpoint/time-range
- [ ] **Phase 6 — Circuit breaker**: per-endpoint, failure-rate tripped, half-open probe
- [ ] **Phase 7 — SSRF guard**: resolve → vet → pin, per-hop redirect re-vetting, streamed byte caps
- [ ] **Phase 8 — Ordering** _(optional for v1)_
- [ ] **Phase 9 — Ship**: npm publish, docs, launch

## A taste

```ts
import { Pool } from 'pg';
import { createHarkara } from 'harkara';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const harkara = createHarkara({ pool });

// The headline feature: send() inside YOUR transaction. The webhook is
// accepted if and only if your business data commits — an order that
// rolls back is a webhook that never existed.
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`INSERT INTO orders (id, total) VALUES ($1, $2)`, [42, '19.99']);
  await harkara.send(
    { type: 'order.created', payload: { orderId: 42 }, idempotencyKey: 'order-42-created' },
    { tx: client },
  );
  await client.query('COMMIT'); // ← acceptance happens here
} finally {
  client.release();
}

// Standalone sends resolve only after durable commit:
await harkara.send({ type: 'invoice.paid', payload: { invoiceId: 7 } });

// Delivery runs inside your process, on your Postgres. No extra infra:
const worker = harkara.startWorker();
// …and replay from the dead letter queue is one call, never automatic:
await harkara.replay({ endpointId, diedAfter: outageStart, diedBefore: outageEnd });
```

## Read more

- **[SEMANTICS.md](SEMANTICS.md)** — the contract: at-least-once, dedup,
  retry schedule, signing, breaker, DLQ, ordering, SSRF. Every test in the
  suite traces to a numbered clause here.
- **[REBUILD_PLAN.md](REBUILD_PLAN.md)** — the phase plan and the session
  log: every spec review, ruling, and bug story as it happened.
- **Build-in-public thread** — <!-- TODO: add thread link --> coming soon.
