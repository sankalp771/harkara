<!-- GENERATED from SEMANTICS.md ("8. Crash recovery") by scripts/build-docs.mjs — do not edit here; edit SEMANTICS.md and run `npm run docs`. -->

## 8. Crash recovery

**8.1** Claimed deliveries carry a `locked_at` timestamp. A periodic reaper
(running inside every worker, not only at startup) returns deliveries to
`pending` when their lock exceeds the visibility timeout.

**8.2** Recovery is keyed on `locked_at` (when work started), never on
`created_at` (when the row was born). Recovering on row age double-delivers
old messages that were legitimately claimed seconds ago.

**8.3** Recovery MAY produce duplicates (§1.2 window). It MUST NOT produce
loss.
