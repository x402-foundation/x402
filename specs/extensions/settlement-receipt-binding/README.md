# Settlement-Receipt Binding: Conformance Kit

The conformance gate for [`extension-settlement-receipt-binding.md`](../extension-settlement-receipt-binding.md) (§5). Licensed Apache-2.0 with the rest of this repository.

```sh
pip install rfc8785 cryptography
python3 check.py   # exit 0 = every verdict matched expected.json
```

`check.py` imports the standard library, `rfc8785` (JCS) and `cryptography` (ES256). It imports no x402 package and no receipt framework. It was written from §5 of the extension and from the receipt format in [`draft-sirkkavaara-vaara-receipt`](https://datatracker.ietf.org/doc/draft-sirkkavaara-vaara-receipt/) (sections 2–4).

## Layout

| Path | Contents |
| --- | --- |
| `vectors/generic/step{0,1}/` | Settlement record (`paymentHash` binding) and decision receipt |
| `vectors/sui/step{0,1}/` | Settlement record (`exact` binding) and decision receipt |
| `vectors/negative/<case>/` | A record and receipt that break one property each |
| `keys/es256_public.pem` | The verification key for every receipt |
| `expected.json` | The verdict for every check |

Step 0 is the in-progress step (`terminal: false`), step 1 the terminal step (`terminal: true`).

## Verdicts

For each rail and step:

- `action_ref_recomputes`: `sha256(JCS(action tuple))` equals the record's `actionRef`.
- `settlement_binding_resolves`: `sha256(JCS(record))` equals the receipt's `decisionDerived.evidenceRef.digest`, and `evidenceRef.canonicalization` is `"jcs-rfc8785"`, `"JCS"` or `"jcs-json-v1"`.
- `receipt_signature_ok`: the receipt passes the draft's closed schema, its envelope `alg` equals `issuerAsserted.alg`, and the ES256 signature verifies over the JCS encoding of `version`, `alg`, `backLink`, `decisionDerived` and `issuerAsserted`.

Per rail, `lifecycle_distinguishes_terminal`: the two steps carry opposite `terminal` flags and distinct `actionRef`s, and the step 0 receipt does not resolve against the step 1 record. Per step, `join_is_rail_agnostic`: both rails carry the same `actionRef`.

## Negative cases

| Case | What breaks | Expected failure |
| --- | --- | --- |
| `tampered-amount` | Amount changed after signing | `settlement_binding_resolves` (the join still recomputes: amount is not in it) |
| `forged-action-ref` | `actionRef` does not match its tuple | `action_ref_recomputes` |
| `mid-task-receipt` | Step 0 receipt presented against the step 1 record | `settlement_binding_resolves` |
| `wrong-key` | Signed with another key | `receipt_signature_ok` |
| `alg-mismatch` | `issuerAsserted.alg` differs from the envelope `alg` | `receipt_signature_ok` |
| `unknown-member` | A member the receipt schema does not define, inside the signed bytes | `receipt_signature_ok` |

## Where the records come from

The `sui` records describe a real gasless `exact` settlement on Sui testnet, transaction [`FVejSg9ddPYXwWtxjk58TjkZg6aawJFyynZEsTmsxRQ6`](https://testnet.suivision.xyz/txblock/FVejSg9ddPYXwWtxjk58TjkZg6aawJFyynZEsTmsxRQ6): +10000 of Circle testnet USDC to `payTo`, readable from the transaction's `balanceChanges`. The `generic` records carry the same action tuples, so they share each step's `actionRef`; their `paymentHash` is `sha256` over the UTF-8 bytes of that transaction id.

The receipts are signed with a throwaway key generated for this kit; its private half was discarded. A green result proves the receipt shape and the binding, not a live attestation (§5, non-goals). `backLink` is populated but not dereferenced.

## Changing the kit

A change to any vector or to `expected.json` comes with a settlement schema version bump (§2).
