# Harkara docs

## Guides

- [Quickstart](guides/quickstart.md) — install → schema → endpoint → send → deliver → replay
- [Receiving webhooks](guides/receivers.md) — the dedup table (§2.2), signature verification (§4), strict ordering (§7.3)
- [Operations](guides/operations.md) — the probe-martyr, config-parked elders, the egress opt-ins, serverless, crash recovery
- [Honest comparison](guides/comparison.md) — Svix, Outpost, Convoy, pg-boss

## The contract

[SEMANTICS.md](../SEMANTICS.md) is the source of truth: every test in
the suite traces to a numbered clause, and if the code and the contract
disagree, the code is wrong. [docs/contract/](contract/README.md) holds
one generated page per section (`npm run docs`; CI fails if they drift).
