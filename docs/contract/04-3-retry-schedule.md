<!-- GENERATED from SEMANTICS.md ("3. Retry schedule") by scripts/build-docs.mjs — do not edit here; edit SEMANTICS.md and run `npm run docs`. -->

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
- **Config errors** (e.g. the endpoint has no active signing secret, or
  its URL is refused by the egress guard, §9): no request is sent. The delivery waits at the maximum backoff step and
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
