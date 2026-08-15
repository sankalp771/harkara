<!-- GENERATED from SEMANTICS.md ("6. Dead letter queue and replay") by scripts/build-docs.mjs — do not edit here; edit SEMANTICS.md and run `npm run docs`. -->

## 6. Dead letter queue and replay

**6.1** A delivery that exhausts its retry schedule (or fails
non-retryably, §3.2) transitions to `dead`. Dead deliveries are parked
until explicitly pruned; Harkara never deletes dead deliveries on its
own. Full payload, every attempt's status code, response body
(truncated), and latency are retained for diagnosis.

**6.2** Replay is a **human/API decision, never automatic**. Replaying
creates a fresh delivery for the same message: same `webhook-id`
(receiver dedup still applies), new attempts, new signatures with a
current timestamp.

**6.3** Replay is available per-delivery, per-endpoint, and by time-range
filter (the "our server was down Tuesday 2-4pm" case is a first-class
operation).
