# Harkara — Delivery Semantics

This document is Harkara's contract. It states exactly what the library promises,
what it explicitly does not promise, and what receivers must do on their side.
Every test in the correctness suite traces back to a numbered clause here.
If the code and this document disagree, the code is wrong.

---

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

## 1a. Endpoint matching

**1a.1** Each endpoint subscribes to a list of event-type patterns. A
pattern is either an exact type (`invoice.paid`) or a glob on
dot-delimited segments (`invoice.*`). An empty list means all events.
`*` matches **exactly one segment**: `invoice.*` matches `invoice.paid`
but neither `invoice` nor `invoice.payment.failed` — segment counts must
match, and each segment is a literal or `*`. There is no `**` in v1;
widening later is backward-compatible, narrowing never is.

**1a.2** An endpoint "matches" a message iff any pattern matches the
message's type. Fan-out creates exactly one delivery per matching
endpoint, in the same transaction as the message insert (§1.3).

**1a.3** Matching is evaluated at send time. Endpoints added later do not
receive earlier messages (replay is the tool for that, §6.3).

**1a.4** Matching is tenant-strict: a message is matched only against
endpoints of the same tenant, where "same" includes NULL = NULL (the
single-tenant default). A message never fans out across a tenant
boundary, and there are no cross-tenant ("firehose") endpoints in v1.

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

## 3. Retry schedule

**3.1** A delivery attempt is successful iff the endpoint returns any 2xx
status within the attempt timeout. Everything else is a failure.

**3.2** Failure classification:

- **Retryable:** 5xx, 429, timeouts, connection errors.
- **Not retryable:** all other statuses, including the rest of 4xx and
  all 3xx — redirects are not followed (§9.2), so a redirect response
  means the URL is misconfigured, and the request will be equally wrong
  tomorrow. These go straight to the dead letter queue.
- **`Retry-After` on 429 or 503:** the header is honored (capped at the
  maximum backoff step) instead of the default schedule — the receiver
  naming its own price is §3.4's mercy principle in header form.
- **Config errors** (e.g. the endpoint has no active signing secret): no
  request is sent. The delivery waits at the maximum backoff step and
  does NOT advance toward dead — the fix is a human act of configuration,
  and killing the delivery for the operator's mistake would punish the
  receiver. Each refusal is still recorded as an attempt row (§6.1).
  Once configuration is fixed, the delivery resumes its normal schedule
  from where it left off.

**3.3** Default schedule (configurable): 10s → 30s → 2m → 10m → 1h,
each step with ±20% random jitter to prevent synchronized retry storms.
After the final attempt fails, the delivery transitions to `dead` (§6).

**3.4** Backoff exists primarily as mercy for the receiver — a recovering
server must not be re-flattened by its own backlog — and secondarily to
protect sender worker capacity.

## 4. Signing: Standard Webhooks, no exceptions

**4.1** Every delivery carries the three Standard Webhooks headers:
`webhook-id`, `webhook-timestamp` (unix seconds), `webhook-signature`.

**4.2** The signed content is `{id}.{timestamp}.{payload}` where payload is
the raw request body bytes. The signature is
`v1,` + base64(HMAC-SHA256(secret, signed_content)).

**4.3** Every value a receiver makes a security decision on lives inside the
signed content. The timestamp is signed so a captured request cannot be
freshened by editing a header: editing is free, re-sealing is impossible
without the secret.

**4.4** Receivers SHOULD reject messages whose timestamp is outside a
tolerance window (recommended ±5 minutes) and MUST verify using the raw
body bytes and a constant-time comparison. Harkara's docs point to the
official Standard Webhooks verification libraries rather than shipping
a proprietary scheme.

**4.5** Secrets use the `whsec_` prefix (secret-scanner friendly). An
endpoint may have multiple active secrets simultaneously; during rotation
Harkara signs with all active secrets and sends the signatures
space-separated in one header. Receivers accept if ANY signature matches.
Rotation is therefore zero-downtime by construction.

## 5. Per-endpoint isolation and circuit breaking

**5.1** One endpoint's slowness or failure MUST NOT delay deliveries to any
other endpoint (no head-of-line blocking across endpoints). Concurrency
is bounded globally and per-endpoint.

**5.2** Circuit breaker is per-endpoint, three-state, and trips on **failure
rate over a recent window** (not backlog size — backlogs can be large for
innocent reasons):

- **Closed:** normal delivery.
- **Open:** after the failure-rate threshold is crossed, deliveries to this
  endpoint are paused (not failed, not dropped — they wait). No delivery
  attempts are made while open.
- **Half-open:** after a cooldown, exactly ONE probe delivery is attempted.
  Success → close and resume. Failure → reopen with doubled cooldown
  (capped). A breaker without a recovery path is a fuse, not a breaker;
  the half-open probe is mandatory.

On close, the backlog drains through the same per-endpoint concurrency
limit (§5.1); that serialization is load-bearing — it is what prevents
the drain from re-flattening a just-recovered endpoint.

**5.3** While a circuit is open, the affected deliveries' retry clocks are
suspended — an endpoint outage must not burn through a message's retry
budget.

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

## 7. Ordering

**7.1** Within an ordering key, deliveries to a given endpoint are attempted
in creation order: a message is not attempted while an older message for
the same key and endpoint is still pending or retrying.

**7.2** Ordering is **best-effort and explicitly broken by two events**,
both documented rather than hidden:

- When a message goes `dead`, younger messages for that key unblock and
  deliver. The alternative (blocking forever behind a dead message) is
  worse.
- Replaying a dead message after younger messages have delivered will
  deliver it out of order, by construction.

**7.3** Receivers that require strict ordering should order on a field
inside the payload (e.g. a sequence number), not on arrival order.
Harkara documents this pattern.

## 8. Crash recovery

**8.1** Claimed deliveries carry a `locked_at` timestamp. A periodic reaper
(running inside every worker, not only at startup) returns deliveries to
`pending` when their lock exceeds the visibility timeout.

**8.2** Recovery is keyed on `locked_at` (when work started), never on
`created_at` (when the row was born). Recovering on row age double-delivers
old messages that were legitimately claimed seconds ago.

**8.3** Recovery MAY produce duplicates (§1.2 window). It MUST NOT produce
loss.

## 9. Egress safety (SSRF)

**9.1** Endpoint URLs are untrusted user input pointed at Harkara's own
outbound HTTP client. Before any attempt, Harkara resolves the hostname and
rejects targets in private, loopback, and link-local ranges (including
cloud metadata addresses).

**9.2** The connection is pinned to the vetted IP (DNS rebinding defense).
Every followed redirect hop is treated as a fresh request: re-resolved,
re-vetted against the blocklist, and re-pinned, exactly like the first.
Hop count is capped. Response bodies are read with a hard byte cap and a
total-time cap covering the body, not just the headers.

**9.3** HTTPS is required by default; plain HTTP is an explicit opt-in
intended for local development.

## 10. Non-goals

Harkara is a library, not a service. It will not ship: a hosted offering, a
separate dispatcher service, a required Redis/broker, multi-region
delivery, or enterprise SLAs. Teams that need those should use Svix,
Hookdeck Outpost, or Convoy — and Harkara's docs say so plainly.

## 11. Platform floor

Harkara supports **all non-EOL PostgreSQL versions** — the floor is
inherited from PostgreSQL's own release lifecycle, not invented here.
As of this writing that means 15+ (the §2.4 per-tenant idempotency index
depends on `NULLS NOT DISTINCT`; single-tenant rows carry `tenant_id
NULL`, and plain UNIQUE treats NULL ≠ NULL). CI runs the full suite
against the oldest supported major and a current one, so the promise is
enforced by machine, not memory.
