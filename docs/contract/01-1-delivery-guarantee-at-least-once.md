<!-- GENERATED from SEMANTICS.md ("1. Delivery guarantee: at-least-once") by scripts/build-docs.mjs — do not edit here; edit SEMANTICS.md and run `npm run docs`. -->

## 1. Delivery guarantee: at-least-once

**1.1** Every accepted event will be delivered to each matching endpoint
**at least once**, or will end in the dead letter queue after the retry
schedule is exhausted. Silent loss is a bug of the highest severity.

**1.2** Harkara does NOT promise exactly-once delivery. No networked system can:
a worker may crash after the receiver processes a request but before the
success is recorded, and the only safe recovery is to send again.
Duplicates are therefore **expected, rare, and harmless by contract** (see §2).

**1.3** An event is "accepted" only after it is durably persisted, in the
same transaction as its per-endpoint delivery rows. The promise returned by
`harkara.send()` resolves only after that persistence is committed; a
rejected promise means not-accepted, and the caller may safely resend.
When the caller supplies their own transaction, acceptance occurs at the
caller's own COMMIT — send() joins it and adds no acknowledgment of its
own. There is no window in which an accepted event can be lost.
