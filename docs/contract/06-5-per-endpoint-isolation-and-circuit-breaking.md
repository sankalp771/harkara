<!-- GENERATED from SEMANTICS.md ("5. Per-endpoint isolation and circuit breaking") by scripts/build-docs.mjs — do not edit here; edit SEMANTICS.md and run `npm run docs`. -->

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

The failure-rate window counts only real attempts — outcomes of requests
that touched the wire (any HTTP status, or a timeout/connection error).
2xx counts as success; everything else counts as failure (§3.1's
definition). Config errors (§3.2) send no request and never feed the
breaker window: a refusal is evidence about the sender's configuration,
not the receiver's health. The rate only trips once the window holds a
minimum number of attempts — below that floor the breaker stays closed,
because one failure is not a rate. On a successful probe the breaker
closes, the window resets, and the cooldown returns to its base value.

**5.3** While a circuit is open, the affected deliveries' retry clocks are
suspended — an endpoint outage must not burn through a message's retry
budget.

Suspension is positional, not temporal: retry budget is measured in
attempts (§3.3), and while the circuit is open no attempts occur, so no
budget burns regardless of how long the outage lasts. The half-open
probe is the one deliberate exception — it is a real attempt and counts
against the probed delivery's schedule; a long outage may therefore
exhaust the probe delivery into the DLQ (§6), which is visible and
replayable, never silent.
