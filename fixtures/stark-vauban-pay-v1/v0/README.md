# Axis 1 STARK Receipt Canonicalisation Fixtures

**Axis:** 1 - STARK proof-of-payment-conditions receipt  
**Proof scheme:** `stark-vauban-pay-v1`  
**Proof system:** Stwo Circle STARK M31 (FRI-based, post-quantum)  
**Anchor chain:** Starknet  
**Canonicaliser:** RFC 8785 (JCS) via `rfc8785@0.1.4`  
**Provenance:** Vauban Pay (`seritalien`), 2026-05-21  
**License:** Apache-2.0

## Overview

This fixture set demonstrates that the `stark-vauban-pay-v1` receipt format is canonically deterministic under JCS (RFC 8785). It parallels the coalition structure established by AlgoVoi's Axis 0 substrate vectors, FeedOracle's Axis 2 hybrid-PQC vectors (PR #2411), and andysalvo's Axis 3 work-receipt vectors (PR #2398).

The four vectors test three properties:

1. **JCS key-sorting independence** (0001 vs 0008): two source objects with identical field values in different insertion orders produce byte-for-byte identical canonical bytes after JCS serialisation.
2. **Field-name load-bearing discipline** (0002): renaming `payment_hash` to `paymentHash` (camelCase) changes the canonical bytes even though the value is identical. JCS treats field names as opaque UTF-8 byte sequences.
3. **Proof tamper evidence** (0003): mutating one byte of `proof_blob_b64` changes the canonical bytes, making the digest diverge from the expected value and causing STARK proof verification to fail independently.

The `receipt_core` shape is a subset of the `BoundReceipt<SettlementReceipt>` structure defined in `crates/zkpay-x402/src/lib.rs`. See the Open Questions section below for the structural mismatch between the Rust type and the fixture shape.

## Vectors

| File | Name | Expected result | Invariant tested |
|------|------|-----------------|------------------|
| `vectors/0001-baseline.json` | baseline-stark-vauban-pay | PASS | Canonical reference |
| `vectors/0002-field-name-load-bearing.json` | field-name-load-bearing | FAIL | Field-name canonicalisation |
| `vectors/0003-stark-proof-tamper-evidence.json` | stark-proof-tamper-evidence | FAIL | Proof blob tamper detection |
| `vectors/0008-interop-shared-payment-hash.json` | interop-shared-payment-hash | PASS | JCS key-sorting independence + cross-axis interop bind |

## Cross-axis interop bindings

Both `payment_hash` and `action_ref` in every vector in this set are shared verbatim with the other axes:

**`payment_hash`: `2ed186ebc66947eaac6a05a88c7bc096ee07ac11a2c44bb5580bd72b3670f580`**

Shared with FeedOracle Axis 2 (PR #2411). The same 32-byte hex string appears in FeedOracle's `receipt_core.payment_hash`. A conformant cross-implementation check: take the FeedOracle baseline JCS bytes, extract `payment_hash`, assert byte equality with the value above.

**`action_ref`: `10d8a38c01d8672176aa6e5209a368fde3e1831640d69e15283142b35880c2c1`**

Shared with andysalvo Axis 3 (PR #2398). This is `SHA-256(JCS({"action_type":"sanctions_screen","agent_id":"did:web:agent-7.example.com","scope":"counterparty-due-diligence","timestamp_ms":1747728000000}))`. The andysalvo work-receipt harness recomputes this value from the preimage and asserts byte equality. The binding is a pure hash reference: the STARK receipt knows nothing about the work-layer preimage internals; the work layer knows nothing about the STARK proof internals.

## Conformance instructions

1. For each vector, take `receipt_core` verbatim (preserve all field names and value types exactly).
2. Canonicalise with RFC 8785 (any conformant JCS implementation).
3. Compute `SHA-256(canonical_bytes)`, lowercase hex, prefixed `sha256:`.
4. For `PASS` vectors: assert computed digest equals `expected_core_digest`.
5. For `FAIL` vectors: assert computed digest equals `expected_divergent_digest` (not `expected_core_digest`, which is `null`).
6. For vector 0008: additionally assert `expected_core_digest` equals vector 0001 `expected_core_digest` byte-for-byte (the interop bind).

Expected conformance runner result: 4/4 vectors produce the expected outcome, 1/1 interop bind asserts pass.

A conformance runner stub (`runner-stark-axis-1`) is not yet published. Contribution welcome.

## Cross-implementation validation status

This set is Vauban-authored. The digests were computed using a pure-Python RFC 8785 implementation and verified against the `serde_jcs` Rust crate output (via the fixture in `crates/zkpay-x402/src/lib.rs`). Cross-implementation validation by a third party is a Phase 2 ask on the PR thread.

## Open questions

### Structural mismatch: `BoundReceipt<R>` vs `receipt_core`

The Rust type `BoundReceipt<SettlementReceipt>` in `crates/zkpay-x402/src/lib.rs` is a two-field wrapper:

```rust
pub struct BoundReceipt<R> {
    pub receipt: R,           // nested SettlementReceipt
    pub action_ref: Option<[u8; 32]>,
}

pub struct SettlementReceipt {
    pub payment_id: String,
    pub tx_hash: String,
    pub block_number: u64,
    pub settled_at: u64,
}
```

The `receipt_core` shape in these fixtures is flat and combines fields from the VPSF `SettlementReceipt` Claim (spec v0.3 §4.3) with x402 wire-format extensions (`payment_hash`, `proof_blob_b64`, `proof_scheme`, `canon_version`). This is intentional: the fixture `receipt_core` represents the canonical preimage for JCS hashing at the x402 wire layer, not the CBOR-encoded `BoundReceipt<R>` used in `PAYMENT-RESPONSE` headers.

The mapping between the two shapes is:

- `receipt_core.payment_hash` corresponds to the `nullifier` field of the VPSF `SettlementReceipt.Predicate.Settlement` (spec §4.3); the fixture uses `payment_hash` because that is the x402 V2 field name per issue #2357 open item.
- `receipt_core.action_ref` corresponds to `BoundReceipt.action_ref` (serialised as hex string in the fixture vs raw `[u8; 32]` in Rust).
- `receipt_core.payer_pseudonym`, `merchant_id`, `amount`, `currency`, `timestamp_ms` are derived from the VPSF Claim sextuplet fields (Subject, Predicate.Settlement.amount, etc.).
- `receipt_core.proof_blob_b64` has no direct equivalent in `BoundReceipt<R>`; it belongs to the `Evidence.StarkProofEnvelope` of the VPSF Claim (spec §4.3).

Resolution of this mismatch (flatten vs nest, field name mapping for x402 TSC review) is tracked on x402-foundation/x402#2357. These fixtures use the flat shape as the canonical preimage for Axis 1; the CBOR encoding for `PAYMENT-RESPONSE` headers remains the nested `BoundReceipt<R>` shape.

### proof_blob_b64 inclusion in canonical preimage

The manifest notes that in production the proof blob is stripped before the digest is computed (signatures cover the receipt without the proof blob, analogous to JWS detached payload). This fixture set includes `proof_blob_b64` in `receipt_core` and therefore in the canonical preimage. The production protocol is to be resolved in the PR thread before TSC ratification.
