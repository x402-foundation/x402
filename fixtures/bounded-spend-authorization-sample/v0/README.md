# bounded-spend-authorization-sample/v0

Public no-secret reference fixture set for the `DelegationGrant + SettlementReceipt` pair that backs Vauban Pay's bounded-spend authorization primitive. Published per the 2026-05-22 Vauban Pay commitment to [@egoriklok](https://github.com/egoriklok) on [x402-foundation/x402#2405](https://github.com/x402-foundation/x402/issues/2405) (the `fiscal_authority` metadata block discussion), as a discrete artifact a buyer-agent can compare against when implementing or validating `fiscal_authority` v0.

## Purpose

The fixture set demonstrates the shape and verification surface for **cryptographically enforced bounded-spend authorization** under the x402 V2 wire format + RFC 8785 JCS canonicalisation discipline + the Vauban Proof Stack Framework (VPSF) Claim sextuplet model (spec v0.3 §4.5 `DelegationGrant`, §4.3 `SettlementReceipt`).

## fiscal_authority seven-field mapping (egoriklok #2405)

Each of the seven fields `@egoriklok` proposed for the `fiscal_authority` metadata block maps to a field in this fixture set as follows :

| # | `fiscal_authority` field | Maps to | Schema location |
|---|---|---|---|
| 1 | Provider / resource identity | `SettlementReceipt.subject.value` (MerchantPseudonym) + verifier contract address | `settlement-receipt.schema.json#/properties/subject` |
| 2 | Exact charge amount + asset + network | `SettlementReceipt.predicate.amount` + `.currency` (URN with chain hint) + `SettlementReceipt.anchor.chain_id` | `settlement-receipt.schema.json#/properties/predicate` + `/properties/anchor` |
| 3 | Who/what approved the spend authority | `DelegationGrant.subject` (UserPseudonym) + `DelegationGrant.anchor.delegation_commitment` (Poseidon commitment over grant terms) | `delegation-grant.schema.json#/properties/subject` + `/properties/anchor` |
| 4 | Spend cap and expiry | `DelegationGrant.predicate.cap_per_tx` + `.cap_per_period` + `.period_seconds` + `DelegationGrant.temporal_frame.t_start` + `.t_end` | `delegation-grant.schema.json#/properties/predicate` + `/properties/temporal_frame` |
| 5 | Receipt / charge_evidence reference | `SettlementReceipt.predicate.intent_ref.claim_hash` + the receipt's own JCS hash (`SHA-256(JCS(receipt_object))`) | `settlement-receipt.schema.json#/properties/predicate/properties/intent_ref` |
| 6 | Audit / canonicalisation version | `DelegationGrant.canon_version` + `SettlementReceipt.canon_version` (both follow [#2326 v3](https://github.com/x402-foundation/x402/issues/2326) discipline) | both schemas top-level `canon_version` property |
| 7 | Revocation or dispute path | `DelegationGrant.anchor.revocation_authority` (URL or DID publishing revocation receipts) | `delegation-grant.schema.json#/properties/anchor/properties/revocation_authority` |

## Layout

```
v0/
├── README.md                                    (this file)
├── schema/
│   ├── delegation-grant.schema.json             (JSON Schema Draft 2020-12, full Phase 2a sextuplet per spec §4.5)
│   └── settlement-receipt.schema.json           (JSON Schema Draft 2020-12, full Phase 2a sextuplet per spec §4.3)
└── vectors/
    ├── 0001-baseline.json                       (PASS, nominal grant + receipt, well within caps)
    ├── 0002-cap-respect.json                    (PASS edge, amount = cap_per_tx - 1)
    └── 0003-cap-violation.json                  (FAIL_AT_VERIFIER, pinned-divergent-digest, amount > cap_per_tx)
```

## Vectors

Each vector file contains :

- `vector_id`, `case`, `expected_result`, `invariant`, `notes` ; metadata
- `cross_axis_binding` ; shared `payment_hash` + `action_ref` values across the four coalition axes
- `delegation_grant` ; full VPSF sextuplet (Subject, Predicate, Evidence, TemporalFrame, RevelationMask, Anchor)
- `settlement_receipt` ; full VPSF sextuplet
- `expected_delegation_grant_jcs_bytes_b64` ; base64 of `serde_jcs::to_vec(delegation_grant)`
- `expected_delegation_grant_hash` ; `sha256:` + lowercase hex of `SHA-256` over the JCS bytes
- `expected_settlement_receipt_jcs_bytes_b64` ; analogous for the receipt
- `expected_settlement_receipt_hash` ; analogous SHA-256

### Cross-vector invariants

| Property | Reason |
|---|---|
| `expected_delegation_grant_hash` identical across `0001`, `0002`, `0003` | Same DelegationGrant authorises multiple SettlementReceipts. Hash equals `sha256:ff558f21b26c5045fb6997fef185b9993e33a29a7907dbcf349e49b9019c1fd2`. |
| `expected_settlement_receipt_hash` distinct per vector | Each receipt has a unique `predicate.amount`, `predicate.nullifier`, `predicate.settlement_index`, and `temporal_frame.issued_at`. |
| `cross_axis_binding.shared_payment_hash` identical across all 3 vectors AND with PR #2413 Axis 1 vector 0001 | Demonstrates the canonical payment binding the four-axis coalition substrate is built on. |

## Cross-axis binding to PR #2413 (Axis 1 STARK fixtures)

The `cross_axis_binding` block in every vector reproduces the canonical values from `fixtures/stark-vauban-pay-v1/v0/vectors/0001-baseline.json` :

- `shared_payment_hash` : `2ed186ebc66947eaac6a05a88c7bc096ee07ac11a2c44bb5580bd72b3670f580`
- `shared_action_ref` : `10d8a38c01d8672176aa6e5209a368fde3e1831640d69e15283142b35880c2c1`
- The `SettlementReceipt.predicate.intent_ref.claim_hash` points at the Axis 1 baseline core digest (`sha256:89e01af0770494243e7ba6d003332688ca7107dd05c52cc8c73f470b13d5767f`), demonstrating compositional binding from Axis 1 (STARK receipt-core) to this fixture set (bounded-spend-authorization).

## Canonicalisation discipline

JSON Canonicalization Scheme per **RFC 8785** (Erdtman + Rundgren 2020). SHA-256 over the canonical bytes, lowercase hex. Aligned with the [#2326 v3](https://github.com/x402-foundation/x402/issues/2326) section text co-authored 2026-05-21 by Vauban Pay + AlgoVoi + FeedOracle.

- Producer-loud, verifier-silent (failure on non-canonical input at issuance ; equivalent canonical input accepted at verification)
- `canon_version` field declared in both `DelegationGrant` and `SettlementReceipt` at the top level
- `1.0` form accepted (matches Axis 1 fixtures on PR #2413) ; `x402-jcs-v1.0.0` Phase 2a form also accepted

## Validation across 5 independent implementations

The fixture set is intended for byte-for-byte cross-validation across the **5-implementation JCS reference matrix** :

| Library | Language | Author |
|---|---|---|
| `rfc8785@0.1.4` | Python | Trail of Bits |
| `canonicalize@3.0.0` | JavaScript | Erdtman + Rundgren |
| `gowebpki/jcs v1.0.1` | Go | GoWebPKI |
| `cyberphone/json-canonicalization` | Java | Rundgren (RFC 8785 reference) |
| `serde_jcs 0.2.0` | Rust | l1h3r (5th-impl runner maintained by Vauban Pay) |

Vauban-side validation is performed by `crates/zkpay-x402/examples/stamp-bounded-spend-vectors.rs` (Rust, `serde_jcs 0.2.0`). Independent reproduction by the other four implementations is a coalition-validation step ; the canonical bytes and SHA-256 expected in the fixture should reproduce identically.

## Reproducing the hashes

From the workspace root :

```bash
cargo run -p vauban-zkpay-x402 \
  --example stamp-bounded-spend-vectors -- \
  fixtures/bounded-spend-authorization-sample/v0/vectors/
```

The stamper is **idempotent** : on first run it populates the four `expected_*` fields in each vector ; on subsequent runs it confirms the canonical bytes + SHA-256 are unchanged. Any divergence between the stored values and the recomputed values indicates a canonicalisation regression.

## Phase MVP vs Phase 2a delta (honest scope declaration)

This fixture set documents the **Phase 2a target shape** for `DelegationGrant` and `SettlementReceipt`. The currently shipped Phase MVP Rust structs in `crates/zkpay-types/src/` (`delegation_grant.rs`, `settlement_receipt.rs`) carry a minimal subset :

| Surface | Phase MVP shipped today | Phase 2a (this fixture's target) |
|---|---|---|
| `DelegationGrant` fields | `delegator`, `delegatee`, `scope`, `expires_at` | + `cap_per_tx`, `cap_per_period`, `delegation_nonce`, full sextuplet shape, `delegation_circuit` STARK proof |
| `SettlementReceipt` fields | `payment_id`, `tx_hash`, `block_number`, `settled_at` | + `merchant_id`, `amount`, `currency`, full sextuplet shape, JCS-canonical `receipt_hash` |
| Cap enforcement | wrapping facilitator layer (off-chain policy) | `delegation_circuit` ZK proof of cap-respect at use time |

Sprint-662 (Vauban Pay internal sprint) lands the missing struct fields. This fixture's `evidence.scheme` is set to `HmacPhaseMvp` (Phase MVP fallback) to keep the fixture self-validating without requiring Stwo prover integration ; Phase 2a moves to `StarkProofEnvelope`.

## License

Apache-2.0. Per ADR-ECO-025 (Vauban Pay license decision, option B : Apache 2.0 for Rust crates + Cairo + reference fixtures, closed Vauban Facilitator service).

## Cross-references

- Vauban Pay specification : `docs/specs/vauban-zk-payment-spec-v0.3.md` §4.3 (`SettlementReceipt`), §4.5 (`DelegationGrant`), §5.3 (`delegation_circuit`)
- Coalition substrate Axis 1 : [PR #2413](https://github.com/x402-foundation/x402/pull/2413) `fixtures/stark-vauban-pay-v1/v0/`
- Coalition substrate Axis 0 : [PR #2412](https://github.com/x402-foundation/x402/pull/2412) `fixtures/canonicalisation-substrate/v0/`
- Canonicalisation discipline section : [x402-foundation/x402#2326](https://github.com/x402-foundation/x402/issues/2326) v3
- IETF I-D : `draft-vauban-x402-stark-receipts-00` (submission ID 163411, ISE Manual Post queue 2026-05-22)
- TSC engagement Issue : [x402-foundation/x402#2428](https://github.com/x402-foundation/x402/issues/2428)
- Originating discussion : [x402-foundation/x402#2405](https://github.com/x402-foundation/x402/issues/2405) (egoriklok `fiscal_authority` proposal + Vauban Pay Post 13 response)
