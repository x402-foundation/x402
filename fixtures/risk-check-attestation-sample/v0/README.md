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
| `jurisdiction_flags` | array of strings | ISO 3166-1 alpha-2 codes ; `BLOCKED` for sanctioned jurisdictions |
| `canon_version` | `jcs-rfc8785-v1` | RFC 8785 JCS canonicalization marker |

`expected_hash` is present in test vectors only; absent in live receipts.

## Vectors

| Vector | `screen_result` | `jurisdiction_flags` | Description |
|---|---|---|---|
| `0001-allow-uk-eu` | `ALLOW` | `["EU", "UK"]` | Nominal UK+EU jurisdiction pass |
| `0002-deny-jurisdiction` | `DENY` | `["BLOCKED"]` | Sanctioned jurisdiction ; payment rejected |

## JCS reproduction

All `expected_hash` values are `sha256:` prefixed hex digests of `SHA-256(JCS(receipt_object_without_expected_hash))`.

Reproduce with any RFC 8785 implementation:

```js
// JS (canonicalize npm + node:crypto)
const { createRequire } = require('module');
const c = createRequire(import.meta.url)('canonicalize');
const hash = 'sha256:' + crypto.createHash('sha256')
  .update(Buffer.from(c(receiptWithoutExpectedHash), 'utf8'))
  .digest('hex');
```

```python
# Python (jcs pip + hashlib)
import jcs, hashlib
digest = 'sha256:' + hashlib.sha256(jcs.canonicalize(receipt)).hexdigest()
```

Compatible implementations: `canonicalize` (JS), `gowebpki/jcs` (Go), `cyberphone/json-canonicalization` (Java), `serde_jcs` (Rust), `jcs` (Python).

## Cross-axis binding

These vectors share the JCS canonicalization substrate defined in Axis 0 (x402 PR #2412, AlgoVoi).

The `payer_ref` content-addressing pattern is consistent with `action_ref = SHA-256(JCS(preimage))` from Axis 3 (PR #2398, andysalvo).

As an Axis 4 composite trust-query emitter row, the risk-check receipt binds to `(payment_hash, action_ref)` alongside AlgoVoi compliance-screening, Vauban STARK proof-of-payment-conditions, and nobulex verascore-evidence-schema rows. Tetra-party composite structure per x402 issue #2322.

## Session-level amortisation

Per AlgoVoi production data: one screen per payer session, not per micropayment. A payer session covering 1,000 micropayments incurs one screen cost. The protocol SHOULD specify session-scope as the default amortisation unit to preserve micropayment unit economics without compromising screening depth.
