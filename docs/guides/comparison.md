# Honest comparison

Harkara is a **library** — it rides inside your Node process and your
existing Postgres. Most alternatives are services. Neither shape is
"better"; they solve different operational realities. This table is
written to lose you honestly where Harkara genuinely loses.

|                           | **Harkara**                                                        | **Svix**                        | **Hookdeck Outpost**   | **Convoy**          | **pg-boss**                       |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------- | ---------------------- | ------------------- | --------------------------------- |
| Shape                     | npm library                                                        | hosted service                  | self-hosted service    | self-hosted service | npm library (job queue)           |
| Extra infrastructure      | none — your Postgres                                               | none (it's SaaS)                | Redis + Postgres/MySQL | Redis + Postgres    | none — your Postgres              |
| Transactional outbox      | ✅ `send({ tx })` joins your COMMIT                                | ❌ (API call after your commit) | ❌ (API call)          | ❌ (API call)       | ✅ (same idea, for jobs)          |
| Standard Webhooks signing | ✅ (verified against the official lib)                             | ✅ (they co-authored the spec)  | ✅                     | ✅                  | ❌ — it's a job queue             |
| Retries + DLQ + replay    | ✅                                                                 | ✅                              | ✅                     | ✅                  | retries; no webhook DLQ semantics |
| Per-endpoint breaker      | ✅                                                                 | ✅                              | ✅                     | ✅                  | ❌                                |
| SSRF egress guard         | ✅ (§9: pin, ranges, caps)                                         | ✅                              | ✅                     | ✅                  | ❌                                |
| Consumer portal / UI      | ❌                                                                 | ✅                              | ✅                     | ✅                  | ❌                                |
| Multi-region, SLAs        | ❌                                                                 | ✅                              | your ops team's        | your ops team's     | ❌                                |
| Written contract          | [SEMANTICS.md](../../SEMANTICS.md) — every test traces to a clause | docs                            | docs                   | docs                | docs                              |

**Choose Svix** when webhooks are a product surface you bill for:
consumer portals, multi-region delivery, SLAs, a team on call that
isn't yours. It is the best hosted option and Harkara's docs will keep
saying so.

**Choose Outpost or Convoy** when you want self-hosted
infrastructure-grade delivery and you're comfortable operating a
dedicated service with Redis alongside it.

**Choose pg-boss** when you need a great Postgres job queue and
webhooks are just one job type — you'll write the signing, dedup
contract, breaker, and egress guard yourself.

**Choose Harkara** when webhooks should be a `npm install`, not an
architecture decision: you already run Node + Postgres, you want the
send to commit atomically with your business data, and you'd rather
read a [contract](../../SEMANTICS.md) than a marketing page. (Postel,
the other library-shaped attempt in this space, appears unmaintained —
evaluate it yourself before trusting that sentence.)
