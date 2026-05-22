# composite-trust-query v0

Conformance vectors for the Axis 4 composite trust-query envelope.

Normative section: `specs/composite-trust-query.md`.
Canonicalisation discipline: `specs/canonicalisation.md` (`jcs-rfc8785-v1`, PR #2436).

## What the composite envelope is

One query against a `(payment_hash, action_ref)` anchor returns a set of
emitter rows. Each row is from a distinct emitter surface, independently
signed, declaring its own evidence class. The envelope assembles and binds
the rows; it does not produce evidence.

## The `composite_hash`

```
composite_hash = "sha256:" + lowercase_hex( SHA-256( JCS( preimage_array ) ) )
```

where `preimage_array` is the list of emitter rows with each `sig` field
removed, sorted by `source_id` (lexicographic byte order, ascending).

Per-row `sig` fields are EXCLUDED from the preimage: the composite digest
signs the set of rows, not the set of signatures. The composite preimage
algorithm is the contribution of AlgoVoi (x402 issue #2322).

## Vectors

| Vector | Rows | composite_hash | Demonstrates |
|---|---|---|---|
| `0001-tetra-full` | 4 | `sha256:54ab9c64...042f649e` | Full four-row composite in canonical order |
| `0002-tetra-rotated` | 4 | `sha256:54ab9c64...042f649e` | Same rows, rotated transmission order ; identical digest |
| `0003-partial-absent-row` | 3 | `sha256:98b03e76...6ff53d6b` | Cryptographic row absent ; anchor still binds |

`0001` and `0002` carry the same four rows in different `emitter_rows` array
order and produce the SAME `composite_hash`. Emitter rows are a set, not a
sequence ; the preimage algorithm sorts by `source_id` before
canonicalisation. This is the set-semantics property contributed by nobulex
(x402 issue #2322).

`0003` omits the `vauban.stark-proof-of-payment-conditions` row entirely (no
null placeholder). The `composite_hash` is computed over the three rows that
are present. The `(payment_hash, action_ref)` anchor binds the partial
composite cleanly. Absent-row partial-response semantics contributed by
nobulex (x402 issue #2322).

## Emitter surfaces in the v0 vectors

| `source_id` | `evidence_type` | Underlying fixture |
|---|---|---|
| `algovoi.compliance-screening` | behavioral | `fixtures/canonicalisation-substrate/v0/` (PR #2412) |
| `algovoi.risk-check-attestation` | behavioral | `fixtures/risk-check-attestation-sample/v0/` (PR #2434) |
| `nobulex.verascore-evidence-schema-v0.1` | observational | nobulex `fixtures/bilateral-receipt/v0/` |
| `vauban.stark-proof-of-payment-conditions` | cryptographic | `fixtures/bounded-spend-authorization-sample/v0/` (PR #2432) |

## On the `sig` placeholders

The `sig` field in each row carries a `PLACEHOLDER-...-demonstration-only`
string. These are NOT real signatures. The v0 conformance fixture exercises
the composite preimage and anchor-binding rules, which by construction exclude
`sig` from the digest. Real per-row signatures are emitter-produced and
verified independently of the `composite_hash`. A later vector set will carry
real signatures once each emitter surface publishes its signing key.

## Reproduction

```js
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const c = createRequire(import.meta.url)('canonicalize');

function compositeHash(emitterRows) {
  const preimage = emitterRows
    .map(({ sig, ...rest }) => rest)
    .sort((a, b) => a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0);
  return 'sha256:' + createHash('sha256')
    .update(Buffer.from(c(preimage), 'utf8'))
    .digest('hex');
}
```

Compatible RFC 8785 implementations: `canonicalize` (JS), `gowebpki/jcs` (Go),
`cyberphone/json-canonicalization` (Java), `serde_jcs` (Rust), `rfc8785`
(Python).

## Open question for coalition co-sign-off

The `source_id` of the risk-check row is `algovoi.risk-check-attestation` in
this draft (the production screening service is AlgoVoi-operated,
`did:web:api.algovoi.co.uk`). If the coalition prefers the receipt-format
origin (Vauban-hosted fixture and IETF I-D track), the value becomes
`vauban.risk-check-attestation` and the lexicographic order of `0001`/`0002`
shifts. The fixture regenerates deterministically once the convention is
fixed. See `specs/composite-trust-query.md` for the full statement.

## IETF track

The composite anchor `action_ref` is the same 32-byte work-receipt digest
defined in `draft-vauban-x402-stark-receipts-00`
(https://datatracker.ietf.org/doc/draft-vauban-x402-stark-receipts/),
Independent Submission posted 2026-05-21.
