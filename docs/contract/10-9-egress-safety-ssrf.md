<!-- GENERATED from SEMANTICS.md ("9. Egress safety (SSRF)") by scripts/build-docs.mjs — do not edit here; edit SEMANTICS.md and run `npm run docs`. -->

## 9. Egress safety (SSRF)

**9.1** Endpoint URLs are untrusted user input pointed at Harkara's own
outbound HTTP client. Before any attempt, Harkara resolves the hostname and
rejects targets in private, loopback, and link-local ranges (including
cloud metadata addresses).

**9.2** The connection is pinned to the vetted IP: the hostname is
resolved exactly once per attempt, every returned address must pass the
blocklist (one bad record poisons the whole set), and the socket
connects only to a vetted address while TLS identity is still verified
against the hostname. There is no second resolution for DNS rebinding
to win. Redirects are never followed — a 3xx response is terminal
(§3.2), so no hop can route the request somewhere the vetting never
saw. Response bodies are read with a hard byte cap enforced DURING the
streamed read (the connection is destroyed at the cap, never buffered
past it), and the attempt timeout covers the body, not just the
headers. A 2xx whose body trips either cap is still a delivered
webhook — the status line decides the outcome; the caps protect
resources.

**9.3** HTTPS is required by default; plain HTTP is an explicit opt-in
intended for local development. Delivery to private, loopback, or
link-local addresses is likewise an explicit opt-in, independent of the
HTTP opt-in — internal receivers behind real HTTPS are legitimate. Both
opt-ins default to off.
