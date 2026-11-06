# Scheme: `upto` on `Casper`

> Companion to the network-agnostic [`scheme_upto.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md) and the EVM profile [`scheme_upto_evm.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto_evm.md). This document specifies how the upto scheme works on Casper network.

## Summary

The `upto` scheme on Casper enables usage-based payments where the Client authorizes a **maximum amount** of a CEP-18 token, and the Facilitator settles the **actual amount used** after the resource has been served. The Client signs once, off-chain; the Facilitator submits the settlement transaction and pays the gas.

The `exact` Casper scheme uses CEP-3009 `transfer_with_authorization`, which commits to an exact `value` and cannot settle less. `upto` on Casper instead uses **Permit2 for Casper**, a port of Uniswap's Permit2 that works with any CEP-18 token, through a dedicated proxy contract:

| Contract | Role |
| :--- | :--- |
| **Permit2** | Verifies the Client's EIP-712 signature, consumes the nonce, enforces `deadline` and `requestedAmount <= permitted.amount`, then calls the token's `transfer_from`. |
| **`x402UptoPermit2Proxy`** | The `spender` the Client signs for. Rebuilds the witness from its arguments, checks the caller is the bound facilitator and `validAfter` has passed, and calls Permit2 with `to = witness.to`. |

The Client's signature commits to the token, the maximum amount, the spender (the proxy), a nonce, a deadline, and a **witness** carrying the recipient, the facilitator, and `validAfter`. The Facilitator chooses only the settled amount, bounded by the signed maximum.

**Version Support:** This specification supports x402 v2 protocol only.

## Use Cases

- **LLM token generation**: the Client authorizes up to 5 csprUSD; the charge depends on tokens generated.
- **Bandwidth or data transfer**: pay per byte transferred in a single request, up to a cap.
- **Dynamic compute**: authorize a maximum cost and charge for the compute actually consumed.

## Mapping the five core requirements to Casper

| Requirement ([`scheme_upto.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md)) | Casper mechanism |
| :--- | :--- |
| Single-use authorization | Permit2 unordered nonce. Each `(owner, nonce)` pair is recorded in Permit2's `used_nonces` dictionary on the first successful transfer; a second transfer with the same pair reverts with `NonceAlreadyUsed` (38003). |
| Time-bound authorization | `deadline` is signed and enforced by Permit2 (`now <= deadline`). `validAfter` is signed inside the witness and enforced by the proxy (`now >= validAfter`). Both are Unix seconds compared against block time in seconds, `floor(block_time_ms / 1000)`. |
| Recipient binding | `witness.to` is part of the signed digest. The proxy passes `witness.to` as the transfer recipient, so a different recipient changes the digest and fails signature verification. |
| Maximum amount enforcement | `settlement_amount <= permitted.amount` is checked by the proxy and again by Permit2 (`AmountExceedsPermitted`, 38007). |
| Phase-dependent `amount` | `PaymentRequirements.amount` is the maximum at `/verify` and the actual charge at `/settle`. The facilitator always verifies the signature against `permitted.amount`. |

---

## Phase 1: One-Time Token Approval

Permit2 pulls tokens with the CEP-18 `transfer_from` entry point, so the Client MUST first approve the **Permit2 contract package** on the token, once per token:

```
token.approve(spender = Permit2 (Address::Contract), amount)
```

- `amount` is usually `U256::MAX`. CEP-18 tokens decrement even a maximum allowance on each transfer.
- The spender MUST be Permit2's package address. CEP-18 tokens key allowances by address variant, so an `Account` address with the same bytes is a different spender.
- The Client pays the gas for this transaction and therefore needs CSPR once.

This specification defines no sponsored approval. If the allowance is missing, the facilitator returns `412 Precondition Failed` with `permit2_allowance_required` and the Client must approve before retrying.

## Phase 2: `PAYMENT-SIGNATURE` Header Payload

The `payload` field MUST contain:

- `permit2Authorization`: the parameters needed to rebuild the signed `PermitWitnessTransferFrom` message.
- `publicKey`: the payer's public key, with a leading 1-byte algorithm tag.
- `signature`: the signature over the EIP-712 digest, with the same leading tag.

`permit2Authorization.permitted.amount` is the **maximum** the Client is willing to pay. The amount charged is decided at settlement and is less than or equal to it.

**Facilitator address discovery:** the facilitator announces the Casper account it settles from in the `extra` of each supported `upto` kind returned by `/supported`, as `facilitatorAddress`. The resource server copies it into `PaymentRequirements.extra.facilitatorAddress`, and the Client MUST sign it as `witness.facilitator`. Only that account can settle the authorization.

**Example `PaymentRequired` (402 response):**

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://api.example.com/llm/generate",
    "description": "LLM text generation endpoint",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "upto",
      "network": "casper:casper-test",
      "amount": "100000",
      "asset": "0cb6f94834c60510d532b0ae077b18b4100874a4c867396d61c2b13c790ead52",
      "payTo": "0076d080b4e769f0b29c77fc6472d6e425710840c2f46a4506e5544d2ce34f43a3",
      "maxTimeoutSeconds": 3600,
      "extra": {
        "facilitatorAddress": "0005a22b598f6d79cef07059ba51af296be6983fcf26eb73649cae96ab39d2a772"
      }
    }
  ]
}
```

**Example `PaymentPayload` (client request):**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/llm/generate",
    "description": "LLM text generation endpoint",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "upto",
    "network": "casper:casper-test",
    "amount": "100000",
    "asset": "0cb6f94834c60510d532b0ae077b18b4100874a4c867396d61c2b13c790ead52",
    "payTo": "0076d080b4e769f0b29c77fc6472d6e425710840c2f46a4506e5544d2ce34f43a3",
    "maxTimeoutSeconds": 3600,
    "extra": {
      "facilitatorAddress": "0005a22b598f6d79cef07059ba51af296be6983fcf26eb73649cae96ab39d2a772"
    }
  },
  "payload": {
    "permit2Authorization": {
      "from": "0046496b5e7422fef1a11f650abcaffbc90adf29e1c80481eb696af90600bd0a00",
      "permitted": {
        "token": "010cb6f94834c60510d532b0ae077b18b4100874a4c867396d61c2b13c790ead52",
        "amount": "100000"
      },
      "spender": "013092fce0e90825eda0c6e6398a1a1549de9e43a7f3cd11362cf629b94c887005",
      "nonce": "55565645865130469434335311732180976303031322827051106972185107245794792940727",
      "deadline": "1793802207",
      "witness": {
        "to": "0076d080b4e769f0b29c77fc6472d6e425710840c2f46a4506e5544d2ce34f43a3",
        "facilitator": "0005a22b598f6d79cef07059ba51af296be6983fcf26eb73649cae96ab39d2a772",
        "validAfter": "1793798547"
      }
    },
    "publicKey": "0202fbda46cb1f0a3929d094349d8a942509a514127ed3d11c97dcc811a8ed2c1b67",
    "signature": "02ade0709deba2b0f059454ddcf593ae78afeabf1eb498568f7db3ea258ab6e76437ca4e3427996586f20cc5539bc3f3f3731c3ce3bce76a62b78398941a78a400"
  }
}
```

`accepted` is the `PaymentRequirements` the Client chose; see [PaymentRequirements Schema](#paymentrequirements-schema).

### `payload.permit2Authorization` field definitions

- `from`: 33-byte hex `Address` of the payer. MUST be the account address derived from `publicKey`.
- `permitted.token`: 33-byte hex `Address` of the token. MUST equal `0x01` followed by `accepted.asset`. It is an `address` rather than a `bytes32` package hash to keep Uniswap's `TokenPermissions(address token,uint256 amount)` type string and type hash.
- `permitted.amount`: decimal string, the signed maximum.
- `spender`: 33-byte hex `Address` of the canonical `x402UptoPermit2Proxy` package for `network`. See [Contract Addresses](#contract-addresses).
- `nonce`: decimal string of an unsigned 256-bit integer. Clients SHOULD pick it uniformly at random; Permit2 nonces are unordered.
- `deadline`: decimal string, Unix seconds. Valid while `now <= deadline`. MUST fit in a `u64`, since Permit2 takes it as `u64` on chain.
- `witness.to`: 33-byte hex `Address` of the recipient. MUST equal `accepted.payTo`.
- `witness.facilitator`: 33-byte hex `Address`. MUST equal `accepted.extra.facilitatorAddress`.
- `witness.validAfter`: decimal string, Unix seconds. Valid while `now >= validAfter`. MUST fit in a `u64`.

### `payload` field definitions

- `publicKey`: Casper public key with a 1-byte algorithm tag (see [Signature Schemes](#signature-schemes)).
- `signature`: Casper signature over the 32-byte EIP-712 digest, with the same tag as `publicKey`. For secp256k1 this is ECDSA over SHA-256 of the digest, 64 bytes, no recovery byte, as produced by Casper's `crypto::sign`.

### Signing

The Client builds the digest defined in [EIP-712 Typed Data](#eip-712-typed-data) and signs it with its Casper key. The signature MUST be over the 32-byte digest itself, with no prefix or wrapping.

The Client SHOULD set `deadline` no later than `now + maxTimeoutSeconds` and `validAfter` slightly in the past, to absorb the gap between wall-clock time and block time.

## Phase 3: Verification Logic

A facilitator verifying an `upto` payment on Casper MUST reject any payload that fails a rule below, with the error code given (see [Error Codes](#error-codes)). "Chain time" means the timestamp of the latest block in seconds, `floor(block_time_ms / 1000)`, the same conversion Permit2 and the proxy apply on chain. Checks run in this order:

1. **Verify** `accepted.scheme` is `"upto"` (`unsupported_scheme`) and `PaymentRequirements.network` is a supported `casper:*` network (`invalid_network`). A payload whose fields do not parse, such as a malformed hex `Address` or a `deadline` that does not fit in a `u64`, fails with `invalid_payload`.

2. **Verify the bindings** against `PaymentRequirements`:
   - `permitted.token` equals `0x01 ‖ asset` (`permit2_token_mismatch`).
   - `witness.to` equals `payTo` (`invalid_permit2_recipient_mismatch`).
   - `witness.facilitator` equals `extra.facilitatorAddress`, and is an account this facilitator controls and will sign the settlement with (`upto_facilitator_mismatch`).
   - `spender` equals the canonical `x402UptoPermit2Proxy` address for `network` (`invalid_permit2_spender`). Implementations MUST NOT accept a spender, Permit2, or proxy address supplied by the payload or `extra`.
   - `from != payTo` (`invalid_upto_casper_payload_self_payment`). CEP-18 `transfer_from` reverts when owner and recipient are equal.

3. **Verify the signature** (`invalid_permit2_signature`):
   - The `publicKey` and `signature` tags agree and conform to [Signature Schemes](#signature-schemes), and `from` equals the account address of `publicKey`.
   - The signature is valid under `publicKey` over the `PermitWitnessTransferFrom` digest built from `permit2Authorization`, using the Permit2 domain for `network` and `permitted.amount` as signed.

4. **Verify** `permitted.amount` equals `PaymentRequirements.amount` (`permit2_amount_mismatch`).

   > **Note**: This equality check applies only at **verification** time, where `PaymentRequirements.amount` is the authorized maximum. At settlement time it carries the actual charge. See [Settle-Time Verification](#settle-time-verification).

5. **Verify the time window** against chain time: `now >= validAfter` (`permit2_not_yet_valid`) and `now <= deadline` (`permit2_deadline_expired`). The facilitator SHOULD reject an authorization whose `deadline` leaves too little time to settle after the resource runs, or is later than `now + maxTimeoutSeconds` plus allowed clock skew (`invalid_upto_casper_payload_deadline`).

6. **Verify the nonce is unused** (`permit2_invalid_nonce`): `(from, nonce)` MUST NOT be marked used in Permit2. The facilitator can read Permit2's `used_nonces` dictionary, keyed by `hex(blake2b(from ‖ nonce))`, or call Permit2's `is_nonce_used(owner, nonce)` view.

7. **Verify the Permit2 allowance**: the token's `allowance(from, Permit2)` MUST be at least `permitted.amount`. Otherwise return `412 Precondition Failed` with `permit2_allowance_required`.

8. **Verify the balance**: the token's `balance_of(from)` MUST be at least `permitted.amount` (`insufficient_funds`).

9. **Simulate (optional)** `x402UptoPermit2Proxy.settle` with `settlement_amount = permitted.amount` (worst case) through Casper's `speculative_exec` RPC. A revert maps to an error code as in [On-Chain Reverts](#on-chain-reverts); any other failure is `permit2_simulation_failed`. Facilitators MAY skip this and rely on the targeted checks above.

## Phase 4: Settlement Logic

Settlement is a Casper transaction, signed and paid for by the facilitator account `witness.facilitator`, that calls the `settle` entry point of the canonical `x402UptoPermit2Proxy` package with the **actual amount** to charge.

The resource server determines the actual amount from resource consumption and passes it in the settlement-time `PaymentRequirements.amount`.

**Settlement amount rules:**

- The settled `amount` MUST be `<=` `permitted.amount`.
- The settled `amount` MAY be `0`.
- The settled `amount` is chosen by the resource server, not the Client.

### Settle-Time Verification

The facilitator MUST run full verification again during settlement and MUST NOT rely on an earlier `/verify` result. Because `PaymentRequirements.amount` now carries the actual charge, the facilitator MUST:

1. **Verify the signature against `permitted.amount`**, the signed maximum from the payload, NOT against `PaymentRequirements.amount`. The Client signed the maximum; a digest rebuilt from the metered amount would not match.
2. **Validate** `PaymentRequirements.amount <= permitted.amount`. On violation, fail with `invalid_upto_casper_payload_settlement_exceeds_amount`.
3. **Replace** Phase 3 step 4 with step 2 above; run every other Phase 3 check unchanged. Step 7 and step 8 MAY compare against the settlement amount instead of `permitted.amount`. If step 9 runs, it simulates with `settlement_amount = PaymentRequirements.amount`, the amount that will be submitted.
4. **Execute** the transfer for `PaymentRequirements.amount`.

> **Conformance note**: A facilitator that requires `PaymentRequirements.amount == permitted.amount` at settle time rejects every partial settlement and breaks `upto`.

**Example settle request** (partial settlement):

```json
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "accepted": { "scheme": "upto", "network": "casper:casper-test", "amount": "100000", ... },
    "payload": {
      "permit2Authorization": {
        "from": "0046496b5e7422fef1a11f650abcaffbc90adf29e1c80481eb696af90600bd0a00",
        "permitted": { "token": "010cb6f94834c60510d532b0ae077b18b4100874a4c867396d61c2b13c790ead52", "amount": "100000" },
        "spender": "013092fce0e90825eda0c6e6398a1a1549de9e43a7f3cd11362cf629b94c887005",
        "nonce": "55565645865130469434335311732180976303031322827051106972185107245794792940727",
        "deadline": "1793802207",
        "witness": {
          "to": "0076d080b4e769f0b29c77fc6472d6e425710840c2f46a4506e5544d2ce34f43a3",
          "facilitator": "0005a22b598f6d79cef07059ba51af296be6983fcf26eb73649cae96ab39d2a772",
          "validAfter": "1793798547"
        }
      },
      "publicKey": "0202fbda46cb1f0a3929d094349d8a942509a514127ed3d11c97dcc811a8ed2c1b67",
      "signature": "02ade0709deba2b0f059454ddcf593ae78afeabf1eb498568f7db3ea258ab6e76437ca4e3427996586f20cc5539bc3f3f3731c3ce3bce76a62b78398941a78a400"
    }
  },
  "paymentRequirements": {
    "scheme": "upto", "network": "casper:casper-test",
    "asset": "0cb6f94834c60510d532b0ae077b18b4100874a4c867396d61c2b13c790ead52",
    "payTo": "0076d080b4e769f0b29c77fc6472d6e425710840c2f46a4506e5544d2ce34f43a3",
    "amount": "1858",
    "maxTimeoutSeconds": 3600,
    "extra": { "facilitatorAddress": "0005a22b598f6d79cef07059ba51af296be6983fcf26eb73649cae96ab39d2a772" }
  }
}
```

The Client signed for up to `100000`. The facilitator verifies the signature against `100000`, confirms `1858 <= 100000`, and transfers `1858`.

### Settlement Process

1. **Nonzero settlement.** Submit a transaction from `witness.facilitator` that calls `x402UptoPermit2Proxy.settle` with the arguments in [`x402UptoPermit2Proxy`](#x402uptopermit2proxy) and `settlement_amount = PaymentRequirements.amount`. The proxy calls Permit2, which verifies the signature, consumes the nonce, and calls `token.transfer_from(from, witness.to, settlement_amount)`.

2. **Zero settlement.** If `PaymentRequirements.amount` is `0`, no transaction is submitted and `transaction` is the empty string. The nonce is not consumed: the authorization stays valid until `deadline`, and the facilitator MUST NOT settle it later (see [Duplicate Settlement Mitigation](#duplicate-settlement-mitigation)). The Client can close it earlier with Permit2's `invalidate_unordered_nonces` (see [Permit2 Entry Point](#permit2-entry-point)). As on EVM, the proxy rejects a zero `settlement_amount` (`InvalidAmount`), so a facilitator never pays gas for a transfer of nothing.

The facilitator MUST wait until the transaction has executed on chain before returning. A Casper transaction that reverts still costs the facilitator its gas; the facilitator MUST return `success: false` with the transaction hash in `transaction` and the `errorReason` that [On-Chain Reverts](#on-chain-reverts) gives for the revert.

If the transaction was accepted by the node but its execution result cannot be obtained (for example an RPC error or timeout while waiting), the facilitator MAY return `settlement_pending` with the transaction hash in `transaction`, so the caller can reconcile on chain before retrying.

### Duplicate Settlement Mitigation

The Permit2 nonce prevents a second transfer, but two concurrent `/settle` calls for the same payload would both submit a transaction. Two independently built Casper transactions have different hashes, so the node accepts both and the second one reverts with `NonceAlreadyUsed` and the facilitator pays its gas.

A zero settlement has the opposite problem: no transaction is submitted, so nothing on chain stops a later `/settle` for the same authorization.

Facilitators MUST track settlements per authorization, identified by `(network, from, nonce)`:

1. If the authorization is already tracked, reject with `duplicate_settlement` and MUST NOT submit.
2. Otherwise track it, then submit. For a zero settlement, track it and submit nothing.
3. Keep it tracked until the transaction's execution result is known, or until `deadline` has passed. Keep a zero settlement tracked until `deadline` has passed.

**Example `SettlementResponse`:**

```json
{
  "success": true,
  "transaction": "b84b9e6a1e87cd3373c07993fee59c46dfb68b16dcdea28384293499ffbb5d5c",
  "network": "casper:casper-test",
  "payer": "0046496b5e7422fef1a11f650abcaffbc90adf29e1c80481eb696af90600bd0a00",
  "amount": "1858"
}
```

---

## PaymentRequirements Schema

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `scheme` | `string` | Required | `"upto"` |
| `network` | `string` | Required | CAIP-2 identifier: `casper:casper` for Mainnet, `casper:casper-test` for Testnet |
| `amount` | `string` | Required | Decimal string in atomic units. Phase-dependent: maximum at verification, actual amount at settlement |
| `asset` | `string` | Required | 32-byte hex CEP-18 contract package hash |
| `payTo` | `string` | Required | 33-byte hex `Address` of the recipient (see [Address Format](#address-format)) |
| `maxTimeoutSeconds` | `number` | Required | Maximum time allowed for payment completion |
| `extra` | `object` | Required | MUST include `facilitatorAddress`, the 33-byte hex `Address` of the facilitator's Casper account, with the `0x00` (account) tag. `name` and `version` are not used: the signed domain is Permit2's, fixed per network (see [EIP-712 Typed Data](#eip-712-typed-data)), not the token's. |

> **Note**: As in the [root spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md#5-phase-dependent-amount-semantics-in-paymentrequirements), `amount` is the authorized **maximum** at `/verify` and the **actual amount to settle** at `/settle`. Every other field is unchanged between the two phases.

## SettlementResponse Schema

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `success` | `boolean` | Required | Whether settlement succeeded |
| `errorReason` | `string` | Optional | Omitted on success |
| `payer` | `string` | Optional | 33-byte hex `Address` of the payer (`from`) |
| `transaction` | `string` | Required | 32-byte hex Casper transaction hash; empty string when no transaction was submitted (a zero settlement, or a failure before submission) |
| `network` | `string` | Required | CAIP-2 identifier |
| `amount` | `string` | Required | Actual amount charged in atomic units; MAY be `"0"` |

## Error Codes

Codes are taken, in order of preference, from:

- the core [x402 error codes](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md#9-error-handling);
- the Permit2 and `upto` codes the EVM SDKs already return, which carry no network in their name, so a multi-network client matches one code for the same failure;
- codes prefixed `invalid_upto_casper_`, only where neither of the above fits.

| Code | Returned when |
| --- | --- |
| `unsupported_scheme`, `invalid_network`, `invalid_payload` | Core codes; see Phase 3 step 1. |
| `insufficient_funds` | `balance_of(from)` is below the amount to transfer. |
| `settlement_pending` | The settlement transaction was accepted but its execution result could not be obtained. Non-terminal; `transaction` carries the hash. |
| `invalid_transaction_state` | The settlement transaction failed for a reason not listed in [On-Chain Reverts](#on-chain-reverts), for example out of gas. |
| `invalid_permit2_spender` | `spender` is not the canonical `x402UptoPermit2Proxy` for `network`. |
| `permit2_token_mismatch` | `permitted.token` is not `0x01 ‖ asset`. |
| `invalid_permit2_recipient_mismatch` | `witness.to` is not `payTo`. |
| `invalid_permit2_signature` | The tags disagree, `from` is not the account of `publicKey`, the secp256k1 signature is not low-s, or the signature does not verify. |
| `permit2_amount_mismatch` | At `/verify`, `permitted.amount` is not `PaymentRequirements.amount`. |
| `permit2_not_yet_valid` | `now < validAfter`. |
| `permit2_deadline_expired` | `now > deadline`. |
| `permit2_invalid_nonce` | `(from, nonce)` is already used in Permit2. |
| `permit2_allowance_required` | With `412`: `allowance(from, Permit2)` is below the amount to transfer. |
| `permit2_simulation_failed` | The optional simulation failed without a revert listed in [On-Chain Reverts](#on-chain-reverts). |
| `upto_facilitator_mismatch` | `witness.facilitator` is not `extra.facilitatorAddress`, or is not an account of this facilitator. |
| `invalid_upto_casper_payload_self_payment` | `from` equals `payTo`. |
| `invalid_upto_casper_payload_deadline` | `deadline` leaves too little time to settle, or is later than `now + maxTimeoutSeconds` plus allowed skew. |
| `invalid_upto_casper_payload_settlement_exceeds_amount` | At `/settle`, `PaymentRequirements.amount` exceeds `permitted.amount`. |
| `duplicate_settlement` | The authorization `(network, from, nonce)` is already tracked (see [Duplicate Settlement Mitigation](#duplicate-settlement-mitigation)): a settlement is in flight, or the authorization was already settled for zero. The SVM and XRPL `upto` profiles use the same code. |

### On-Chain Reverts

A reverted `settle`, whether simulated or executed, carries a Casper user error code. Facilitators map it as follows:

| User error | Contract | `errorReason` |
| --- | --- | --- |
| 39000 `InvalidAmount` | Proxy | `invalid_payload` |
| 39001 `AmountExceedsPermitted` | Proxy | `invalid_upto_casper_payload_settlement_exceeds_amount` |
| 39002 `UnauthorizedFacilitator` | Proxy | `upto_facilitator_mismatch` |
| 39003 `PaymentTooEarly` | Proxy | `permit2_not_yet_valid` |
| 38000 `SignatureExpired` | Permit2 | `permit2_deadline_expired` |
| 38001 `InvalidSignature`, 38002 `InvalidSigner` | Permit2 | `invalid_permit2_signature` |
| 38003 `NonceAlreadyUsed` | Permit2 | `permit2_invalid_nonce` |
| 38007 `AmountExceedsPermitted` | Permit2 | `invalid_upto_casper_payload_settlement_exceeds_amount` |
| 60001 `InsufficientBalance` | CEP-18 | `insufficient_funds` |
| 60002 `InsufficientAllowance` | CEP-18 | `permit2_allowance_required` |
| 60003 `CannotTargetSelfUser` | CEP-18 | `invalid_upto_casper_payload_self_payment` |
| Any other | | `invalid_transaction_state` |

---

## Annex

### Contract Addresses

The canonical Permit2 and `x402UptoPermit2Proxy` package hashes are per-network constants of the SDKs and facilitators, not wire fields. Casper has no `CREATE2`, so each network has its own deployment; the package hashes are published with the contracts in [Permit2 for Casper](https://github.com/casper-ecosystem/permit2). Implementations MUST use the canonical package hashes for the selected `network` and MUST NOT accept a Permit2 or proxy address from the payload or `extra`.

The canonical Permit2 and `x402UptoPermit2Proxy` packages MUST be deployed locked (`lock_status: Locked`). Facilitators SHOULD check at startup that both packages are locked, that the proxy's `permit2()` view returns the canonical Permit2 address for `network`, and that Permit2's `chain_name()` view equals `network`. Permit2's `init(chain_name)` takes a free string; a mis-set name does not open replay, since the package hash differs per network, but it makes every signature fail.

### EIP-712 Typed Data

**Domain**

| Field | Type | Value |
| --- | --- | --- |
| `name` | `string` | `"Permit2"` |
| `version` | `string` | `"1"` |
| `chain_name` | `string` | The CAIP-2 `network`, e.g. `"casper:casper-test"`. Stored in Permit2 at deployment and readable through its `chain_name()` view. |
| `contract_package_hash` | `bytes32` | Canonical Permit2 package hash for `network` (see [Contract Addresses](#contract-addresses)) |

The domain type string fixes the field order:

```
EIP712Domain(string name,string version,string chain_name,bytes32 contract_package_hash)
```

Its type hash is `e20dd13933eeb9d6099b53d5ffd59cfd50fe774983038681a378371664fad4fb`.

**Types**

```
PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,address facilitator,uint256 validAfter)
```

| Type | Type hash (`keccak256` of the type string) |
| --- | --- |
| `TokenPermissions(address token,uint256 amount)` | `618358ac3db8dc274f0cd8829da7e234bd48cd73c4a740aede1adec9846d06a1` |
| `Witness(address to,address facilitator,uint256 validAfter)` | `d4171c445a74218b01d4fd8af34ff1106580ea1e36ff837e64484bfaa2253b75` |
| `PermitWitnessTransferFrom(...)` (full string above) | `51dff6974ad4388c499e7fcfe838d2bd767162553a144098ce20ea661d70c2ee` |

Because the witness is a typed struct rather than an opaque `bytes32`, wallets that render typed data can show `to` and `facilitator`.

**Encoding rules**

- `address` fields are 33-byte Casper `Address` values encoded as `keccak256(tag ‖ hash)`, so an account and a contract with the same 32 bytes never collide.
- `uint256` fields are 32-byte big-endian. `deadline` and `validAfter` are `u64` on chain and are left-padded to 32 bytes.
- Nested structs (`permitted`, `witness`) are encoded as their `hashStruct`.

Golden vector, computed with an independent EIP-712 encoder:

| Input | Value |
| --- | --- |
| Chain name | `casper:casper-test` |
| Permit2 (domain `contract_package_hash`) | `Contract(0x33 × 32)` |
| `permitted.token` | `Contract(0x11 × 32)` |
| `permitted.amount` | `500` |
| `spender` | `Contract(0x44 × 32)` |
| `nonce` | `7` |
| `deadline` | `1000` |
| `witness.to` | `Account(0x55 × 32)` |
| `witness.facilitator` | `Account(0x66 × 32)` |
| `witness.validAfter` | `900` |

| Output | Value |
| --- | --- |
| `Witness` type hash | `d4171c445a74218b01d4fd8af34ff1106580ea1e36ff837e64484bfaa2253b75` |
| `PermitWitnessTransferFrom` type hash | `51dff6974ad4388c499e7fcfe838d2bd767162553a144098ce20ea661d70c2ee` |
| Witness hash | `6790d321a629f19074b1be4cf6c0aff3766d2bf073182613d014f4bcbdf5f420` |
| Struct hash | `f5cad14e4e8ceadccbdbdb21f495f8f9ae1701a8266cf71c72338fff424ed09c` |
| Digest | `b6bad959ddbf464b12434bacd0c2edc30c4282d2f352a14fb9b12ae803ff48bd` |

Signature vectors over the digest above, with test-only secret keys (never use them on a live network):

| Output | ed25519 (secret key `01` × 32) | secp256k1 (secret key `01` × 32) |
| --- | --- | --- |
| `publicKey` | `018a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c` | `02031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f` |
| Account hash | `ef4687f74d465826239bab05c4e1bdd2223dd8c201b96f361f775125e624ef70` | `28bbf7efd9be97339596ef441ff27d1e32195e90ddb17253c13951d23e5137a5` |
| `signature` | `015868837539215813bc699ebecc22dd1322af548e8c02920680324b5fbb77f544`<br>`be1fd084ac823db6390e40b7c13a5bfc809cb243b322c01fcb2fec0a00728707` | `027dbca1dcd78e78c433524ccf27302b243be01e4a53892472d50a1f8f19a1d99f`<br>`111e95b2b8ea629713d4132b212829bc625134f8da23b9d12901dc6a5dcaca1b` |

ed25519 signs the 32-byte digest. secp256k1 signs SHA-256 of the digest, as Casper's `crypto::sign` does; EVM wallets instead sign the digest directly. Passing the digest straight to ECDSA gives `02ac297179bb02d49ac1921fe1f8c83b6613299c1680d4d861c68a874ab4e88ed7192dbe3a9d5217d4b935b9c4ecdd327448c3daa8805701e91035b0438ee15595`, which Permit2 rejects with `InvalidSignature`.

### Permit2 Entry Point

This scheme uses the witness variant of the signature transfer, which Permit2 for Casper implements:

```
permit_witness_transfer_from(
    token: Address, 
    amount: U256, nonce: U256, deadline: u64,
    owner: Address, public_key: PublicKey, signature: Bytes,
    to: Address, 
    requested_amount: U256,
    witness: [u8; 32], 
    witness_type_string: String,
)
```

The Client can cancel an unused authorization with:

```
invalidate_unordered_nonces(nonces: Vec<U256>)
```

### `x402UptoPermit2Proxy`

The x402-specific checks live here, so Permit2 stays a generic Permit2 port. It stores the Permit2 package address at `init` and exposes one entry point:

```
settle(
    token: Address, amount: U256, nonce: U256, deadline: u64,
    owner: Address, public_key: PublicKey, signature: Bytes,
    settlement_amount: U256,
    to: Address, facilitator: Address, valid_after: u64,
)
```

`settle` MUST, in order:

1. Revert if `settlement_amount == 0` (`InvalidAmount`) or `settlement_amount > amount` (`AmountExceedsPermitted`).
2. Revert unless the caller equals `facilitator` (`UnauthorizedFacilitator`).
3. Revert if block time in seconds is below `valid_after` (`PaymentTooEarly`).
4. Compute `witness = keccak256(WITNESS_TYPEHASH ‖ enc(to) ‖ enc(facilitator) ‖ uint256(valid_after))`.
5. Call `Permit2.permit_witness_transfer_from(token, amount, nonce, deadline, owner, public_key, signature, to, settlement_amount, witness, WITNESS_TYPE_STRING)`, where `WITNESS_TYPE_STRING` is `"Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,address facilitator,uint256 validAfter)"`.
6. Emit `Settled { owner, facilitator, token, to, amount, nonce, valid_after, witness }`, where `amount` is `settlement_amount` and `witness` is the hash from step 4. Permit2 emits `PermittedWitnessTransfer` in the same transaction with the same `witness`, so observers can match the two events and check the plain values against the hash Permit2 verified.

The entry point SHOULD be non-reentrant. Proxy errors use the 39000 range, which does not overlap Permit2 (38000+), CEP-18 (60001 to 60003), CEP-2612 (36000+) or CEP-3009 (37000+):

| Code | Error |
| --- | --- |
| 39000 | `InvalidAmount` |
| 39001 | `AmountExceedsPermitted` |
| 39002 | `UnauthorizedFacilitator` |
| 39003 | `PaymentTooEarly` |

### Address Format

`payTo`, `from`, `token`, `spender`, `witness.to` and `witness.facilitator` use the 33-byte `Address` encoding from the [`exact` Casper spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_casper.md#address-format): a 1-byte tag (`0x00` account, `0x01` contract package) followed by the 32-byte hash, as 66 hex characters with no prefix.

On chain, Permit2 and the proxy take these arguments as `Key` CLValues: tag `0x00` is `Key::Account` (`account-hash-…`) and `0x01` is `Key::Hash` (`hash-…`). The 33 bytes are that `Key`'s serialization, so SDKs build the CLValue from the tag and hash directly.

### Signature Schemes

As in the [`exact` Casper spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_casper.md#signature-schemes): `0x01` ed25519, `0x02` secp256k1; the `publicKey` and `signature` tags MUST agree; secp256k1 signatures MUST be low-s.

### External References

- [Permit2 for Casper](https://github.com/casper-ecosystem/permit2): the contract this scheme depends on.
- [Uniswap Permit2 `SignatureTransfer`](https://github.com/Uniswap/permit2/blob/main/src/SignatureTransfer.sol): the EVM original of `permitWitnessTransferFrom`.
- [CEP-18: Casper Fungible Token Standard](https://github.com/casper-network/ceps/blob/master/text/0018-token-standard.md)
- [Casper EIP-712 toolkit](https://github.com/casper-ecosystem/casper-eip-712)
- [CAIP-2 for Casper](https://github.com/ChainAgnostic/namespaces/blob/main/casper/caip2.md)
- [Casper `speculative_exec` JSON-RPC](https://docs.casper.network/developers/json-rpc/json-rpc-transactional#speculative_exec_txn)

## Security Considerations

1. **Server trust.** The server can charge anything up to `permitted.amount`, and clients trust it to meter honestly within that maximum. The maximum, recipient, and single use are enforced on chain; the metered amount is not.
2. **Facilitator binding.** The signed payload travels in an HTTP header and may be seen by others. Binding `witness.facilitator` and checking the caller in the proxy stops a third party from settling first, for example with a tiny amount that burns the nonce and denies the server its payment.
3. **Spender binding.** Permit2 takes the spender from the caller, which is the proxy package. A signature for this proxy cannot be used directly against Permit2 or through any other contract.
4. **Signer binding.** EVM Permit2 recovers the signer from the signature. On Casper the caller passes `owner` and `public_key` as separate arguments, and Permit2 reverts with `InvalidSigner` (38002) unless `owner` is the account hash of `public_key`. `owner` is therefore always an account; contract packages cannot sign. Facilitators apply the same rule off chain when they verify the signature.
5. **Key rotation.** A Casper account hash is derived from the account's original public key and never changes, and Permit2 accepts only that key. It keeps signing valid authorizations after it is removed from the account's associated keys, and a rotated-in key cannot sign at all. An account rotating out a key, for example after a compromise, SHOULD revoke the Permit2 allowance with `token.approve(Permit2, 0)` on each token.
6. **Multi-key accounts.** Permit2 checks a single signature from that key and ignores the account's associated keys and action thresholds. Accounts that rely on weighted keys or multisig, such as treasuries, SHOULD NOT approve Permit2.
7. **Replay.** The EIP-712 domain binds `chain_name` and the Permit2 package hash, and Permit2 consumes the nonce on first use, so a signature works once, on one network, against one deployment.
8. **Reentrancy.** Permit2 calls `transfer_from` on whatever token the signed permit names; the facilitator checks it against `asset`, but Permit2 itself does not restrict it. As in Uniswap's Permit2, Permit2 marks the nonce used before the token call, so a malicious token that reenters Permit2 or the proxy with the same authorization reverts with `NonceAlreadyUsed` (38003). The proxy entry point SHOULD also be non-reentrant.
