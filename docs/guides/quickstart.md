# Quickstart

Five minutes from `npm install` to a signed webhook arriving at a
receiver — on the Postgres you already run. No Redis, no broker, no
second service.

**Floors:** Node ≥ 20, PostgreSQL ≥ 15 (Harkara supports all non-EOL
PostgreSQL versions — [SEMANTICS §11](../contract/README.md)).

## 1. Install

```bash
npm install harkara pg
```

`pg` is a peer dependency: your app brings its own — Harkara works with
the `Pool` you already have, it never bundles a second copy.

## 2. Apply the schema

```ts
import { runMigrations } from 'harkara';

await runMigrations({ databaseUrl: process.env.DATABASE_URL });
```

Safe to call on every boot — an up-to-date database applies nothing.
Harkara records its migrations in its own `harkara_migrations` table,
so it never interferes with your app's own migration history.

The same door exists as a CLI (`DATABASE_URL` env or
`--database-url=`):

```bash
npx harkara migrate
```

## 3. Register an endpoint

v1 has no registration API yet (it's on the roadmap); endpoints are
rows you insert:

```sql
INSERT INTO endpoints (url, event_types)
VALUES ('https://customer.example.com/webhooks', '{"invoice.*"}')
RETURNING id;

-- Every endpoint needs an active signing secret (§4.1 — Harkara
-- refuses to deliver unsigned). whsec_ + base64 bytes:
INSERT INTO endpoint_secrets (endpoint_id, secret)
VALUES ('<endpoint-id>', 'whsec_' || encode(gen_random_bytes(24), 'base64'));
```

Event-type patterns are dot-segment globs: `invoice.*` matches
`invoice.paid`, not `invoice.payment.failed`. An empty array means all
events ([§1a](../contract/README.md)).

## 4. Send — inside your own transaction

```ts
import { Pool } from 'pg';
import { createHarkara } from 'harkara';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const harkara = createHarkara({ pool });

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`INSERT INTO orders (id, total) VALUES ($1, $2)`, [42, '19.99']);
  await harkara.send(
    { type: 'invoice.paid', payload: { orderId: 42 }, idempotencyKey: 'order-42-paid' },
    { tx: client },
  );
  await client.query('COMMIT'); // ← acceptance happens here (§1.3)
} finally {
  client.release();
}
```

The webhook is accepted if and only if your business data commits. An
order that rolls back is a webhook that never existed. (Standalone
`await harkara.send({...})` works too — it resolves only after its own
durable commit.)

## 5. Deliver

```ts
const worker = harkara.startWorker();
// … on shutdown:
await worker.stop(); // stops claiming, finishes in-flight attempts
```

The worker runs inside your process: claims with `FOR UPDATE SKIP
LOCKED`, signs with [Standard Webhooks](https://www.standardwebhooks.com/),
retries on the §3.3 schedule, trips a per-endpoint circuit breaker,
parks exhausted deliveries in the DLQ. Run as many workers as you like
— Postgres arbitrates.

Delivering to `http://localhost` in development? Two explicit opt-ins
(both off by default — [§9](../contract/README.md)):

```ts
harkara.startWorker({
  ssrf: { allowInsecureHttp: true, allowPrivateAddresses: true },
});
```

## 6. When things die: replay

```ts
// The "our receiver was down Tuesday 2–4pm" one-liner (§6.3):
await harkara.replay({
  endpointId,
  diedAfter: new Date('2026-08-11T14:00Z'),
  diedBefore: new Date('2026-08-11T16:00Z'),
});
```

Replay is never automatic, keeps the same `webhook-id` (receiver dedup
still applies), and re-signs with a fresh timestamp.

Next: [set up your receiver](receivers.md) — including the dedup table
that makes delivery effectively-once.
