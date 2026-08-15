<!-- GENERATED from SEMANTICS.md ("2. Deduplication contract (receiver's half of the deal)") by scripts/build-docs.mjs — do not edit here; edit SEMANTICS.md and run `npm run docs`. -->

## 2. Deduplication contract (receiver's half of the deal)

**2.1** Every message carries a `webhook-id` header that is **stable across
all retry attempts** of that message. Attempt 1 and attempt 7 carry the
same id.

**2.2** Receivers MUST deduplicate on `webhook-id`: keep a table of processed
ids; on a duplicate, skip processing and still return 2xx.

**2.3** Sender guarantees ≥1 delivery; receiver collapses N deliveries to 1
processing. Together: effectively-once. Harkara's docs ship a copy-paste
dedup example for this reason.

**2.4** `send()` accepts an optional `idempotencyKey`, unique per tenant.
A resend with the same key returns the previously accepted message (same
webhook-id) instead of creating a new one. Callers using their own
transaction don't need it; callers retrying a failed plain send() should
pass one. With it, §2.3's effectively-once holds across sender-side
retries too.
