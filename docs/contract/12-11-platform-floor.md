<!-- GENERATED from SEMANTICS.md ("11. Platform floor") by scripts/build-docs.mjs — do not edit here; edit SEMANTICS.md and run `npm run docs`. -->

## 11. Platform floor

Harkara supports **all non-EOL PostgreSQL versions** — the floor is
inherited from PostgreSQL's own release lifecycle, not invented here.
As of this writing that means 15+ (the §2.4 per-tenant idempotency index
depends on `NULLS NOT DISTINCT`; single-tenant rows carry `tenant_id
NULL`, and plain UNIQUE treats NULL ≠ NULL). CI runs the full suite
against the oldest supported major and a current one, so the promise is
enforced by machine, not memory.
