<!-- GENERATED from SEMANTICS.md ("7. Ordering") by scripts/build-docs.mjs — do not edit here; edit SEMANTICS.md and run `npm run docs`. -->

## 7. Ordering

**7.1** Within an ordering key, deliveries to a given endpoint are attempted
in creation order: a message is not attempted while an older message for
the same key and endpoint is still pending or retrying.

Creation order is acceptance order, defined by a per-delivery sequence
assigned at persistence. Order is guaranteed between messages whose
acceptances do not overlap: a send() that begins after an earlier
send()'s acceptance (its promise resolution, or its enclosing
transaction's COMMIT) is ordered after it. Within a single caller
transaction, order is send() call order. Two sends racing concurrently
on the same key have no defined mutual order — a message is ordered
only against the history it could have observed.

**7.2** Ordering is **best-effort and explicitly broken by two events**,
both documented rather than hidden:

- When a message goes `dead`, younger messages for that key unblock and
  deliver. The alternative (blocking forever behind a dead message) is
  worse.
- Replaying a dead message after younger messages have delivered will
  deliver it out of order, by construction.
- A replayed message re-enters the queue at the back of its ordering
  key: out of order with respect to the past (above), in order with
  respect to everything still queued.

**7.3** Receivers that require strict ordering should order on a field
inside the payload (e.g. a sequence number), not on arrival order.
Harkara documents this pattern.
