# Operating Harkara

The behaviors below are deliberate contract decisions, not bugs — each
links back to the clause that mandates it. Read this page before filing
the support ticket; it was written from the tickets we expect.

## The probe-martyr

When an endpoint's circuit breaker is open and the cooldown expires,
exactly ONE delivery is chosen to probe the endpoint (§5.2). The probe
is a **real attempt**: it counts against that delivery's retry budget.
During a long outage the same delivery tends to be re-chosen — it
absorbs probe failure after probe failure while every other delivery's
budget stays frozen (§5.3: suspension is positional, not temporal — no
attempts happen while open, so nothing burns).

That one delivery is the probe-martyr. It may exhaust its schedule and
die into the DLQ so that the rest of the backlog survives the outage
untouched. This is the designed trade: **one visible, replayable corpse
instead of a backlog-wide budget massacre**. When the endpoint recovers
and the backlog drains, replay the martyr (§6.2) — same webhook-id,
fresh signature, and the receiver's dedup makes it harmless even if it
actually got through.

## A config-parked elder freezes its ordering key

A delivery in the §3.2 **config-error** bucket (endpoint has no signing
secret; URL refused by the egress guard) never dies — it waits at the
maximum backoff step until a human fixes the configuration. If that
parked delivery carries an `orderingKey`, then §7.1 does exactly what
it says: **every younger message on that key waits behind it.
Indefinitely.**

This is deliberate. The elder is not failing — it is _forbidden_, and
the fix is one config change away. Skipping ahead would break the
ordering promise to paper over an operator mistake, and unlike a dead
letter, nothing here is lost: fix the secret (or the URL, or set the
opt-in), and the whole key drains in order. If you see one key's
deliveries piling up as `pending` with `attempt_count = 0` and refusal
rows (`attempt_number IS NULL`) in `delivery_attempts` — that's this.
The refusal row's `error` column names the exact clause it tripped.

## 169.254.169.254 is blocked as a range member — keep it that way

The egress guard (§9.1) refuses cloud-metadata addresses because they
fall inside **link-local space (169.254.0.0/16)** — a range check, not
a famous-IP list. The same goes for every other blocked network:
RFC1918, CGNAT, loopback, multicast, their IPv6 equivalents, and the
IPv4-in-IPv6 wrappers (v4-mapped, NAT64) which are unwrapped and vetted
by the same rules. If you ever find yourself "optimizing" the range
check into a list of specific addresses, stop: the list is exactly what
an attacker with `169.254.169.253` wants you to have. (The test suite
pins a metadata _neighbor_ address for precisely this reason.)

## The two egress opt-ins (§9.3)

Both default **off**:

- `ssrf.allowInsecureHttp` — plain `http://` targets. For local
  development. Production webhooks are HTTPS.
- `ssrf.allowPrivateAddresses` — private/loopback/link-local targets.
  For local development AND for the legitimate production case of
  internal receivers on a VPC behind real HTTPS.

They are independent because both mixes are real. Turning both on
disables most of §9 — do it in dev, do it knowingly anywhere else.

## Serverless: the worker needs a long-lived process

`startWorker()` is a loop, not a task: it claims, delivers, reaps, and
sleeps, on the assumption the process stays up. Lambda-style platforms
that freeze or kill processes between invocations will strand claims
until the visibility timeout reaps them (§8.1 — nothing is lost, but
delivery gets lumpy). On serverless hosts, run the worker in the one
long-lived thing you have (a container, a pinned instance, a scheduled
runner that stays up for minutes at a time) — `send()` can happen
anywhere, it's just SQL in your transaction.

## Crash recovery expectations (§8)

Workers stamp claims with `locked_at`; every worker also runs a reaper
that returns expired claims to `pending`. Recovery may duplicate (the
§1.2 window — receiver dedup absorbs it), never lose. If you SIGKILL a
worker mid-delivery, the delivery re-runs after `visibilityTimeoutMs`
(default 60s). That parameter must stay ≥ 2× `attemptTimeoutMs` —
`startWorker` enforces it rather than let a lock expire under a legally
still-running attempt.
