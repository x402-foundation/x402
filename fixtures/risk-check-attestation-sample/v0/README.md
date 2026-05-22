# risk-check-attestation-sample v0

Canonical JCS test vectors for the x402 risk-check attestation format.

**Spec originator**: @AlexanderLawson17 (x402 issue #2421, PR #2422)
**Production reference**: AlgoVoi (@chopmob-cloud) ; `/compliance/screen`, UK MLR 2017 / SAMLA Reg 40(3) / FCA 7-year retention

## Schema

Six required fields per receipt.

| Field | Type | Description |
|---|---|---|
| `payer_ref` | `sha256:<hex>` | SHA-256(JCS(payer_identity_object)) ; no raw PII (GDPR/CCPA compatible) |
| `screen_result` | `ALLOW` / `REFER` / `DENY` | `REFER` triggers SAR obligation under UK POCA 2002 s.330 |
| `screen_timestamp_ms` | integer | Epoch milliseconds ; NOT RFC 3339 (RFC 3339 admits multiple encodings, divergent digests at year-5 re-verification) |
| `screen_provider_did` | `did:web:` or `did:key:` | Screening provider identity |
| `jurisdiction_flags` | array of strings | ISO 3166-1 alpha-2 codes ; `BLOCKED` for sanctioned jurisdictions ; **array order is significant** (see below) |
| `canon_version` | `jcs-rfc8785-v1` | RFC 8785 JCS canonicalization marker |

`expected_hash` is present in test vectors only; absent in live receipts.

## Array ordering discipline (per PR #2436 normative section)

JCS preserves array element order ; it does NOT sort arrays. Two receipts identical except for `jurisdiction_flags` order produce different canonical digests.

Demonstration (vector 0001 with the in-file order `["UK", "EU"]`) :

```
JCS_canonical_bytes := '{"canon_version":"jcs-rfc8785-v1","jurisdiction_flags":["UK","EU"],"payer_ref":"sha256:4a7b...","screen_provider_did":"did:web:api.algovoi.co.uk","screen_result":"ALLOW","screen_timestamp_ms":1748000000000}'
expected_hash        := sha256:f4e8d652c6cf6c903adf08a0b0b77a3de099e5e0a4b3b01f78fd16cd2fa4da54
```

If the same payload were emitted with `["EU", "UK"]` instead, the digest would be `sha256:9c72e3d6b945492f088b4830274d6efcc00c1664841c15919a479b81f0c74580` ; a different attestation.

Implications for emitters:
- Document the canonical jurisdiction listing order alongside the receipt schema
- Do not sort `jurisdiction_flags` between observation and emission
- A verifier computes the digest with the array order as-received; no re-sort

(This discipline is codified in the shared canonicalisation section ; see x402 PR #2436.)

## Vectors

| Vector | `screen_result` | `jurisdiction_flags` | Description |
|---|---|---|---|
| `0001-allow-uk-eu` | `ALLOW` | `["UK", "EU"]` | Nominal UK+EU jurisdiction pass ; demonstrates array order significance |
| `0002-deny-jurisdiction` | `DENY` | `["BLOCKED"]` | Sanctioned jurisdiction ; payment rejected |

## JCS reproduction

All `expected_hash` values are `sha256:` prefixed hex digests of `SHA-256(JCS(receipt_object_without_expected_hash))`.

Reproduce with any RFC 8785 implementation:

```js
// JS (canonicalize npm + node:crypto)
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const c = createRequire(import.meta.url)('canonicalize');
const hash = 'sha256:' + createHash('sha256')
  .update(Buffer.from(c(receiptWithoutExpectedHash), 'utf8'))
  .digest('hex');
```

```python
# Python (rfc8785 pip + hashlib)
import rfc8785, hashlib
digest = 'sha256:' + hashlib.sha256(rfc8785.dumps(receipt)).hexdigest()
```

Cross-implementations compatible: `canonicalize` (JS), `gowebpki/jcs` (Go), `cyberphone/json-canonicalization` (Java), `serde_jcs` (Rust), `rfc8785` (Python).

## Cross-axis binding

These vectors share the JCS canonicalization substrate codified in PR #2436 ; `jcs-rfc8785-v1` marker is the canonical version reference.

The `payer_ref` content-addressing pattern is consistent with `action_ref = SHA-256(JCS(preimage))` from Axis 3 (PR #2398, andysalvo).

As an Axis 4 composite trust-query emitter row, the risk-check receipt binds to `(payment_hash, action_ref)` alongside AlgoVoi compliance-screening, Vauban STARK proof-of-payment-conditions, and nobulex bilateral-receipt (#2322) rows. Tetra-party composite structure per x402 issue #2322 ; composite preimage algorithm per AlgoVoi.

## Session-level amortisation

Per AlgoVoi production data: one screen per payer session, not per micropayment. A payer session covering 1,000 micropayments incurs one screen cost. The protocol SHOULD specify session-scope as the default amortisation unit to preserve micropayment unit economics without compromising screening depth.
