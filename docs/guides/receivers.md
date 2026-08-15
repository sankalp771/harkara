# Receiving Harkara webhooks

Harkara promises at-least-once delivery ([§1](../contract/README.md)):
duplicates are expected, rare, and harmless — **if you hold up your half
of the deal**. This page is that half.

## 1. Deduplicate on `webhook-id` (§2.2)

Every delivery carries a `webhook-id` header that is stable across all
retry attempts of a message. Keep a table of processed ids; on a
duplicate, skip processing and **still return 2xx**.

This exact code is exercised by Harkara's own test suite
(`test/receiver-dedup.integration.test.ts`) — it is tested code, not
sample code:

```sql
CREATE TABLE processed_webhooks (
  webhook_id   text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);
```

```ts
app.post('/webhooks', async (req, res) => {
  const webhookId = String(req.headers['webhook-id']);

  const { rows } = await db.query(
    `INSERT INTO processed_webhooks (webhook_id) VALUES ($1)
     ON CONFLICT (webhook_id) DO NOTHING
     RETURNING webhook_id`,
    [webhookId],
  );

  if (rows.length === 1) {
    // First time we've seen this id — process the event.
    await handleEvent(req.body);
  }

  // Duplicate or not: 2xx.
  res.status(200).end();
});
```

**Why 2xx for a skipped duplicate — isn't that lying?** No: the sender's
only question is "is this message durably in your hands?" (§3.1 — any
2xx is success, everything else is failure). Answer a duplicate with
409 and Harkara must classify it a failure: the delivery — which your
dedup just handled _correctly_ — goes to the dead letter queue, and the
"failure" feeds the endpoint's circuit-breaker window (§5.2). Enough
duplicates during a crash-recovery burst and the breaker pauses your
endpoint _for working properly_. Return 200; the sender asked about
receipt, not novelty.

## 2. Verify the signature (§4)

Harkara signs with [Standard Webhooks](https://www.standardwebhooks.com/):
`webhook-id`, `webhook-timestamp`, `webhook-signature` headers, HMAC
over `{id}.{timestamp}.{raw body}`. Use the **official verification
library for your language** — never write your own comparison:

```ts
import { Webhook } from 'standardwebhooks';

const wh = new Webhook(endpointSecret); // the whsec_… value
const payload = wh.verify(rawBody, {
  'webhook-id': req.headers['webhook-id'],
  'webhook-timestamp': req.headers['webhook-timestamp'],
  'webhook-signature': req.headers['webhook-signature'],
}); // throws on tamper, on a stale timestamp, on a bad seal
```

Verify against the **raw body bytes** — parse JSON only after
verification. During secret rotation the signature header carries
multiple space-separated signatures; the official libraries accept if
any matches (§4.5), so rotation is zero-downtime and you don't have to
think about it.

## 3. If you need strict ordering (§7.3)

Harkara's per-key ordering is best-effort and breaks loudly in exactly
three documented cases (death unblocks, replay is out-of-order, and
concurrent sends have no defined mutual order — [§7](../contract/README.md)).
If your handler needs strict ordering, order on a field **inside the
payload**:

```ts
// Sender puts a sequence number in the payload…
await harkara.send({
  type: 'account.updated',
  payload: { accountId, version: account.version, ...changes },
  orderingKey: accountId,
});

// …receiver ignores arrival order entirely:
if (event.version <= currentVersion) return; // stale — already applied
```

Arrival order is a property of networks. A version field is a property
of your data. Trust the second one.
