# Harkara

Harkara is an embeddable webhook delivery engine for Node/TypeScript
apps, built on the Postgres you already run — a **library, not a
service**. No Redis, no broker, no separate dispatcher to deploy:
`npm install`, point it at your pool, and your webhooks get a
transactional outbox, Standard Webhooks signing, retries with backoff,
a per-endpoint circuit breaker, an SSRF egress guard, a dead letter
queue, and replay. The Sidekiq of webhooks.

> **v0.1.0** — early release. The delivery contract
> ([SEMANTICS.md](SEMANTICS.md)) is stable and every test in the suite
> traces to a numbered clause of it; the API surface is young. If the
> code and that document disagree, the code is wrong.

**Floors:** Node ≥ 20, PostgreSQL ≥ 15 (all non-EOL PostgreSQL
versions — the CI matrix tests the oldest supported major).

## Five minutes to a delivered webhook

```bash
npm install harkara pg
```

```ts
import { Pool } from 'pg';
import { createHarkara, runMigrations } from 'harkara';

// 1. Schema — safe on every boot; harkara keeps its own migration
//    ledger (harkara_migrations), never touching your app's.
//    (Or from a terminal: `npx harkara migrate`.)
await runMigrations({ databaseUrl: process.env.DATABASE_URL });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const harkara = createHarkara({ pool });

// 2. The headline feature: send() inside YOUR transaction. The webhook
//    is accepted iff your business data commits — an order that rolls
//    back is a webhook that never existed.
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`INSERT INTO orders (id, total) VALUES ($1, $2)`, [42, '19.99']);
  await harkara.send(
    { type: 'invoice.paid', payload: { orderId: 42 }, idempotencyKey: 'order-42-paid' },
    { tx: client },
  );
  await client.query('COMMIT'); // ← acceptance happens here
} finally {
  client.release();
}

// 3. Delivery runs inside your process, on your Postgres. Run as many
//    workers as you like — SKIP LOCKED arbitrates.
const worker = harkara.startWorker();

// 4. Replay from the DLQ is one call, never automatic — the
//    "our receiver was down Tuesday 2–4pm" one-liner:
await harkara.replay({ endpointId, diedAfter: outageStart, diedBefore: outageEnd });
```

Endpoints are rows (a registration API is on the roadmap) — see the
[quickstart](docs/guides/quickstart.md) for the two INSERTs, ordering
keys, and the local-development egress opt-ins.

## Your receiver's half of the deal

Harkara guarantees at-least-once; your receiver collapses duplicates on
the stable `webhook-id` header. Together: effectively-once. This exact
snippet is exercised by Harkara's own test suite:

```ts
app.post('/webhooks', async (req, res) => {
  const webhookId = String(req.headers['webhook-id']);
  const { rows } = await db.query(
    `INSERT INTO processed_webhooks (webhook_id) VALUES ($1)
     ON CONFLICT (webhook_id) DO NOTHING RETURNING webhook_id`,
    [webhookId],
  );
  if (rows.length === 1) await handleEvent(req.body); // first sighting
  res.status(200).end(); // 2xx even for duplicates — see the docs for why
});
```

Signature verification uses the official
[Standard Webhooks](https://www.standardwebhooks.com/) libraries — full
receiver guide in [docs/guides/receivers.md](docs/guides/receivers.md).

## Choosing honestly

| You need…                                                      | Use                                       |
| -------------------------------------------------------------- | ----------------------------------------- |
| Webhooks as a billed product: portals, multi-region, SLAs      | [Svix](https://www.svix.com/) — genuinely |
| Self-hosted delivery infrastructure (with Redis + an ops team) | Hookdeck Outpost, Convoy                  |
| A Postgres job queue where webhooks are one job type           | pg-boss                                   |
| `npm install` webhooks that commit atomically with your data   | **Harkara**                               |

Full table with the losses spelled out:
[docs/guides/comparison.md](docs/guides/comparison.md).

## Read more

- **[SEMANTICS.md](SEMANTICS.md)** — the contract: at-least-once, dedup,
  retry schedule, signing, breaker, DLQ, ordering, SSRF. The centerpiece
  of this project.
- **[docs/](docs/README.md)** — quickstart, receiver guide, operations
  (the probe-martyr, config-parked elders), comparison; plus one
  generated page per contract section, kept fresh by CI.
- **[REBUILD_PLAN.md](REBUILD_PLAN.md)** — how this was built in public:
  the phase plan and a session log of every spec review, ruling, and bug
  story (including the four concurrency bugs one 10k-delivery test
  caught).

## The build receipt

Built phase by phase, tests-from-contract first, every phase verified
against real Postgres (and a real HTTP receiver, and real SIGKILLed
processes) in CI:

- [x] **Phase 0 — Scaffolding**: strict TS, vitest vs real Postgres, CI gate
- [x] **Phase 1 — Schema**: replay-safe partial unique index, `NULLS NOT DISTINCT` idempotency
- [x] **Phase 2 — Send API**: the transactional outbox — `send()` joins _your_ COMMIT
- [x] **Phase 3 — Worker**: `SKIP LOCKED` claims, global per-endpoint serialization, crash recovery (kill -9 tested)
- [x] **Phase 4 — Signing**: Standard Webhooks, verified by the official library as the test oracle
- [x] **Phase 5 — Retries + DLQ + replay**: classification, jittered schedule, `Retry-After`, dead letter parking, replay by delivery/endpoint/time-range
- [x] **Phase 6 — Circuit breaker**: per-endpoint, failure-rate tripped, exactly-one-probe half-open, retry clocks suspended while open
- [x] **Phase 7 — SSRF guard**: resolve → vet → pin (one lookup, no rebind window), https by default, byte cap kills the read mid-stream
- [x] **Phase 8 — Ordering**: per-key acceptance order, death unblocks loudly, replay rejoins at the back of the queue
- [x] **Phase 9 — Ship**: npm package, docs generated from the contract, this README
