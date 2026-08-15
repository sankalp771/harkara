<!-- GENERATED from SEMANTICS.md ("4. Signing: Standard Webhooks, no exceptions") by scripts/build-docs.mjs — do not edit here; edit SEMANTICS.md and run `npm run docs`. -->

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
