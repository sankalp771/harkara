<!-- GENERATED from SEMANTICS.md ("1a. Endpoint matching") by scripts/build-docs.mjs — do not edit here; edit SEMANTICS.md and run `npm run docs`. -->

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
