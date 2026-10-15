# Scheme: `exact` on `TRON`

## Summary

The TRON `exact` binding transfers one fixed TRC-20 amount. It supports:

| `extra.assetTransferMethod` | Authorization | Settlement |
| --- | --- | --- |
| `tip3009` or omitted | TIP-712 `TransferWithAuthorization` | Call the token's `transferWithAuthorization` |
| `permit2` | TIP-712 `PermitWitnessTransferFrom` | Call the network's `x402ExactPermit2Proxy.settle` |

TRON Base58Check addresses are used in requirements and deployment configuration. Addresses inside
TIP-712 typed data are normalized to 20-byte, `0x`-prefixed hex by removing the TRON `0x41` network
prefix.
The normalized values represent the same TRON addresses, not assets or accounts on another chain.
Signed token and recipient addresses MUST match the normalized `asset` and `payTo`; Permit2's
signed spender MUST match the normalized exact proxy configured for the accepted network.

[TIP-3009](https://github.com/tronprotocol/tips/blob/master/tip-3009.md) is the TRON adaptation of
[EIP-3009](https://eips.ethereum.org/EIPS/eip-3009): `TransferWithAuthorization` for TRC-20 tokens
using TIP-712 signatures. The proposal is currently Draft. This binding uses `tip3009` as its
canonical transfer-method identifier.

## Payment Flow and Resource Costs

Both methods are facilitator-submitted and support the `authorization` payment flow
(verify → resource → settle), which is the default. This binding does not define additional payment
flows. An absent `extra.paymentFlow` means `authorization`.

The facilitator submits and pays the Energy/Bandwidth cost of settlement. The payer signs the payment
authorization off-chain. Permit2's initial TRC-20 approval is a separate payer-signed transaction;
this binding does not sponsor its resource cost.

| Method | Replay primitive | Bounded validity window |
| --- | --- | --- |
| `tip3009` | Token authorization nonce for the payer | Signed `validAfter` and `validBefore` |
| `permit2` | Permit2 unordered nonce for the payer | Signed witness `validAfter` and permit `deadline` |

Distinct unused nonces allow concurrent authorizations; they do not reserve the payer's balance or
allowance. Balance changes, allowance revocation, nonce cancellation, or expiry can invalidate a
payment after verification. The remaining validity must cover resource execution and settlement.

Each settlement submits a contract call for the signed authorization. Re-executing that authorization
in another transaction is distinguishable by the contract's consumed nonce and MUST fail, rather
than return the earlier transaction's success. Re-submission of the same transaction ID is not a new
payment and MUST NOT authorize another resource delivery. After an indeterminate broadcast outcome,
reconcile the original transaction as described below instead of treating a retry as a new payment.

## Networks and Contracts

| Network | CAIP-2 ID | Permit2 | Exact proxy |
| --- | --- | --- | --- |
| Mainnet | `tron:728126428` | `TTJxU3P8rHycAyFY4kVtGNfmnMH4ezcuM9` | `TN49yaJmZMZoEdDCqjB4uPzQLHvYkGw95m` |
| Nile | `tron:3448148188` | `TYQuuhGbEMxF7nZxUHV3uHJxAVVAegNU9h` | `TFGoaq2KjizijgjtkVxT7yjffW1A5T1j6F` |
| Shasta | `tron:2494104990` | `TJMkP7a3ucTMkvi17p7ChhTCw6zriFX3tg` | `TGZkC38n14f2GpBWPMQLF2BpmcpWW3QNhg` |

The numeric TIP-712 `chainId` is the decimal CAIP-2 reference interpreted as an unsigned integer.
Deprecated hexadecimal CAIP-2 aliases may be accepted as inputs during migration, but requirements
and responses use the decimal identifiers above.

## Payment Requirements

The common fields follow the [core specification](../../x402-specification-v2.md).
`extra` contains:

| Field | Required | Meaning |
| --- | --- | --- |
| `assetTransferMethod` | No | `tip3009` (default) or `permit2` |
| `paymentFlow` | No | `authorization` (default and only supported flow) |
| `name` | For `tip3009` | Token TIP-712 domain name |
| `version` | For `tip3009` | Token TIP-712 domain version |

The server selects a transfer method supported by the configured token. Verification uses the
server-selected requirements, not untrusted client replacements for those requirements.

## TransferWithAuthorization Payload

Both payload examples below illustrate address encoding and field relationships, not executable
payment authorizations. Payer and recipient addresses are synthetic; this first example also uses
a synthetic token address and does not assert a deployed TransferWithAuthorization token. Signatures
are placeholders, and timestamps must be replaced with a valid window when constructing a payment.

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "tron:3448148188",
    "amount": "1000",
    "asset": "THkQfRopincF6emzbk6VMC7jTHqJ8MP8g7",
    "payTo": "TGCAjMXComunWZEXCT1LPBdcYbDVuyexBv",
    "maxTimeoutSeconds": 60,
    "extra": {
      "assetTransferMethod": "tip3009",
      "name": "Example Token",
      "version": "1"
    }
  },
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0x1111111111111111111111111111111111111111",
      "to": "0x4444444444444444444444444444444444444444",
      "value": "1000",
      "validAfter": "0",
      "validBefore": "1786500000",
      "nonce": "0x0000000000000000000000000000000000000000000000000000000000000001"
    }
  }
}
```

The TIP-712 domain is `{ name, version, chainId, verifyingContract = normalized(asset) }`;
`normalized(asset)` is `0x5555555555555555555555555555555555555555` in this example. The primary type is
`TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256
validBefore,bytes32 nonce)`.

## Permit2 Payload

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "tron:3448148188",
    "amount": "1000",
    "asset": "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
    "payTo": "TGCAjMXComunWZEXCT1LPBdcYbDVuyexBv",
    "maxTimeoutSeconds": 60,
    "extra": { "assetTransferMethod": "permit2" }
  },
  "payload": {
    "signature": "0x...",
    "permit2Authorization": {
      "from": "0x1111111111111111111111111111111111111111",
      "permitted": {
        "token": "0xeca9bc828a3005b9a3b909f2cc5c2a54794de05f",
        "amount": "1000"
      },
      "spender": "0x3a2c916ce2b40f0ffc06cc80c0f72c0fc25be105",
      "nonce": "1",
      "deadline": "1786500000",
      "witness": {
        "to": "0x4444444444444444444444444444444444444444",
        "validAfter": "0"
      }
    }
  }
}
```

The TIP-712 domain is `{ name: "Permit2", chainId, verifyingContract: normalized(Permit2) }`, using
the Permit2 deployment configured for the accepted network. The spender MUST
be the configured exact proxy. The witness binds `payTo`; `permitted.token` and `permitted.amount`
bind the asset and exact amount. The payer MUST first grant the Permit2 contract sufficient TRC-20
allowance. Its primary type is `PermitWitnessTransferFrom`, with these fields in order:

```text
PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)
TokenPermissions(address token,uint256 amount)
Witness(address to,uint256 validAfter)
```

These are signing types, not the `settle` ABI tuple. TIP-712 encoding appends the dependency types
in alphabetical order (`TokenPermissions`, then `Witness`) when deriving the primary type hash.
`permit2Authorization.from` identifies the payer and settlement `owner`; it is not an extra field
in the signed message. The recovered signer MUST equal this normalized address.

## Signature and Integer Encoding

Both methods use [TIP-712](https://github.com/tronprotocol/tips/issues/443) structured-data hashing:
`keccak256(0x1901 || domainSeparator || hashStruct(message))`, without a personal-message prefix.
The domain types are:

```text
TIP-3009: EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
Permit2:  EIP712Domain(string name,uint256 chainId,address verifyingContract)
```

Permit2 has no `version` field. Domain values and normalized addresses are defined above.
This binding supports ordinary secp256k1 account signatures encoded as `0x` plus 65 bytes:
`r` (32 bytes), `s` (32 bytes), then `v` (one byte, 27 or 28). Wallet adapters MUST normalize
recovery identifiers 0/1 to 27/28 before constructing the payload; other encodings MUST be rejected.
For TransferWithAuthorization, split these bytes into the contract's `v`, `r`, and `s` arguments.
For Permit2, pass the same signature bytes to the proxy. In both cases the recovered signer MUST
match normalized `from`, using the configured contract's signature validity rules. Compact
signatures, contract-wallet signatures and TRON account-permission multisignatures are outside this
binding; transaction-signing permissions do not replace payment-authorization signature checks.

Amounts and timestamps are decimal integer strings. All `uint256` values MUST be within
`0..2^256-1`, with no rounding or truncation. TransferWithAuthorization's nonce is exactly 32 bytes
encoded as `0x` plus 64 hex digits. Permit2's nonce is an unsigned `uint256`, encoded as a decimal
or `0x`-prefixed hexadecimal integer string; both representations sign the same integer.
Clients MUST choose a fresh, unpredictable nonce for each new authorization.

## Authorization Timing

Timestamps are Unix seconds. Contracts supported by this binding MUST enforce these execution-time
boundaries:

| Method | Lower bound | Upper bound |
| --- | --- | --- |
| TransferWithAuthorization | `block.timestamp > validAfter` | `block.timestamp < validBefore` |
| Permit2 via exact proxy | `block.timestamp >= witness.validAfter` | `block.timestamp <= deadline` |

Clients set `validAfter = 0` and set `validBefore` or `deadline` to the signing-time Unix timestamp
plus `maxTimeoutSeconds`. As defined by core, this is a payment-completion budget, not an additional
business-processing window. A client needing a fresh window must obtain/sign a new authorization;
verification or polling MUST NOT extend an existing one.

For off-chain checks, let `t` be the verifier's current Unix time, synchronized against fresh TRON
block timestamps; `S` is its configured finite clock-uncertainty bound in seconds, and `M >= 6`
is its configured inclusion margin. Implementations MUST document these bounds and the maximum
accepted age of their chain-time observations, and MUST NOT accept verification when the configured
time bounds cannot be established. They MUST check the lower bound against `t - S` and require
expiry strictly greater than `t + S + M`. This conservative check does not relax contract boundaries.

Before authorizing resource execution, the resource server MUST also ensure that expiry is greater
than `t + S + B + M`, where `B` bounds its remaining resource-processing and handoff time. The
facilitator's six-second floor alone does not establish this business-time budget. At settlement,
recheck the signature, terms, nonce, balance and allowance, but use `B = 0` for the time check: do
not restart the completed resource-processing window or require a fresh full `maxTimeoutSeconds`.

For example, with signing time 1000 and `maxTimeoutSeconds = 60`, expiry is 1060. At `t = 1002`,
`S = 1`, `B = 20`, `M = 6`, there is sufficient time (`1060 > 1029`); at settlement time 1027,
only the remaining margin is required (`1060 > 1034`). An expiry of 1010 at time 1002 fails the
resource check even though eight seconds remain. These policy values are illustrative, not network
constants. A separate receipt-waiting budget can expire before confirmation or continue after the
authorization expires; neither outcome changes whether the transaction executed within its window.

## Verification

The facilitator MUST:

1. Match both schemes and the accepted network, and reject unsupported transfer methods or payment
   flows. The payload MUST use the transfer method selected by the requirements.
2. Reconstruct typed data using the requirement's network and configured contracts.
3. Validate the signature encoding and recover the payer specified by `from`, as defined above.
4. Match recipient, asset, and exact amount.
5. Apply the activation and remaining-validity checks in Authorization Timing.
6. For Permit2, match the exact proxy spender and verify that the payer's token allowance to
   Permit2 covers the required amount.
7. Verify that the payer's token balance covers the required amount.
8. Verify that the authorization nonce is neither consumed nor cancelled. For TransferWithAuthorization,
   query the token's `authorizationState(from, nonce)` and require `false`, including cancellation
   state where supported. For Permit2, read the configured Permit2's `nonceBitmap(from, nonce >> 8)`
   and require the bit `1 << (nonce & 255)` to be zero. This is an unordered nonce, not an account's
   sequential transaction counter.

Required balance, allowance and nonce checks may be established by successful state reads or by a
successful simulation of the intended settlement call that enforces those conditions. If neither
establishes a required condition, verification MUST NOT return `isValid: true`. Infrastructure
failures SHOULD be reported distinctly from invalid payment authorizations so callers can retry
verification; a failed nonce read MUST NOT be reported as evidence that the nonce is consumed.
All signature and payment-term checks remain mandatory.

### Settlement Simulation

The facilitator SHOULD simulate the intended settlement call using the actual submitting address,
configured contracts, and the same parameters that will be submitted on-chain:

- TransferWithAuthorization: simulate the token's `transferWithAuthorization` call.
- Permit2: simulate `x402ExactPermit2Proxy.settle`.

TRON's `triggerconstantcontract` endpoint can simulate these state-changing calls without
broadcasting a transaction. The facilitator MUST inspect the execution result and any return values
required by the configured contract; an HTTP success or a transaction object alone is insufficient.
The facilitator MUST reject verification if simulation reports a contract revert or another definite
execution failure. A transport error, timeout, or unavailable simulation endpoint MUST NOT be
treated as a successful simulation. If simulation is unavailable, the mandatory verification checks
above still apply.

Simulation does not reserve funds or consume the authorization nonce. A successful simulation does
not guarantee settlement success; the settlement confirmation requirements below still apply.

## Settlement

- TransferWithAuthorization: the facilitator calls the TRC-20 token directly with `(from, to,
  value, validAfter, validBefore, nonce, v, r, s)`.
- Permit2: the facilitator calls `x402ExactPermit2Proxy.settle(permit, owner, witness, signature)`.

The facilitator MUST construct only the configured token or exact proxy call from the verified
parameters; it MUST NOT execute arbitrary payload-supplied calls. Settlement MUST transfer exactly
`requirements.amount` of `requirements.asset` from the payer to `requirements.payTo`, and MUST NOT
debit the facilitator beyond the settlement resource cost. Tokens whose transfer behavior does not
satisfy this exact-amount requirement are not supported by this binding.

The proxy's `permit` tuple is `((address token,uint256 amount),uint256 nonce,uint256 deadline)`;
`witness` is `(address to,uint256 validAfter)`. Its `owner` MUST equal the verified payer. It MUST
request exactly `permit.permitted.amount` for `witness.to` from Permit2, binding the signed witness
and spender and enforcing the time and nonce rules above. The [pinned TRON ABI](https://github.com/BofAI/x402/blob/e50e9f09149203a97e35110ee1cd64073487f30d/typescript/packages/mechanisms/tron/src/constants.ts#L150)
specifies the interface; it is not evidence that a particular deployment implements these semantics.

### Execution and Transfer Evidence

A transaction ID or successful broadcast alone is not settlement success. For the submitted txID,
the facilitator MUST obtain transaction information with block inclusion and an explicit successful
TVM execution result (`receipt.result = "SUCCESS"` for these contract calls), using TRON's
[`gettransactioninfobyid`](https://developers.tron.network/reference/gettransactioninfobyid) response.
It MUST also establish the expected exact transfer for a configured token with supported transfer
semantics. For standard TRC-20 tokens, inspect this transaction's `Transfer(address,address,uint256)`
logs: the emitting contract MUST be the required token, the decoded `from` and `to` MUST match the
payer and `payTo`, and the transferred value MUST equal `requirements.amount`. A proxy event or a
same-named event from another contract is insufficient. Logs from tokens with unsupported transfer
semantics do not establish payment merely because their fields match.

The facilitator MUST document its confirmation policy, including the network, node view and required
inclusion/finality condition. A FullNode inclusion receipt does not establish solidification; a
policy requiring solidification must observe the transaction in the SolidityNode view (or equivalent
chain evidence). An otherwise successful transfer remains pending until that policy is met.

### Submission and Pending Results

Immediately before broadcasting, the facilitator MUST re-run verification using the settlement-time
rules above. It MUST retain the signed transaction and its locally derived txID before submission,
and track the original transaction after a broadcast timeout or lost response. TRON derives txID
as SHA-256 of the protobuf-serialized `raw_data`; no broadcast response is needed to know it.
An adapter that cannot provide the transaction identity before submission cannot satisfy this
requirement. If an unexpected adapter failure leaves the ID unavailable after a possible submission,
surface an infrastructure failure outside a normal `SettleResponse` and recover the identity before
returning a settlement outcome. Both facilitator and caller MUST block automatic resubmission of
that authorization during recovery. Do not infer rejection, invent a txID, or return an empty-ID
`settlement_pending`: core requires a non-empty transaction ID for that response.

The facilitator polls within a configurable receipt-waiting budget. If the budget expires, receipt
RPC fails, the required confirmation is absent, or transfer-effect evidence is incomplete, return
`success: false`, `errorReason: "settlement_pending"`, and the known original transaction ID.
Once the configured confirmation condition is met, an explicit execution failure or complete
evidence contradicting the expected transfer is terminal failure and MUST preserve the txID.
Negative evidence awaiting that confirmation remains pending. A caller MUST reconcile the original
transaction; pending MUST NOT trigger another resource delivery or a newly constructed transaction
for the same authorization.

| Observed state | Result |
| --- | --- |
| Signature or terms invalid, or nonce confirmed consumed/cancelled | Verification failure |
| Required state or time cannot be established | Distinct infrastructure failure; no verification success |
| Simulation establishes execution failure | Verification failure |
| Possibly submitted; execution, transfer or confirmation unresolved | Pending with original txID; reconcile |
| Confirmation policy met, and execution failed or complete transfer evidence contradicts requirements | Settlement failure with original txID |
| Execution, exact transfer and configured confirmation all established | Settlement success with original txID |

## Implementation Notes

The [pinned downstream SDK](https://github.com/BofAI/x402/tree/e50e9f09149203a97e35110ee1cd64073487f30d/typescript/packages/mechanisms/tron)
is implementation context, not a claim of conformance to every rule above. Its token registry selects
Permit2 for mainstream USDT/USDD deployments, and its receipt-waiting default is 90 seconds. Approval
amounts and wallet prompts are client policies; an SDK may offer unlimited approval, but this binding
requires only sufficient allowance and does not require automatic or unlimited approval.

## Error Codes

Stable reasons include `invalid_exact_tron_scheme`, `invalid_exact_tron_network_mismatch`,
`invalid_exact_tron_payload_signature`, `invalid_exact_tron_payload_recipient_mismatch`,
`invalid_exact_tron_payload_authorization_value_mismatch`, `invalid_permit2_spender`,
`permit2_amount_mismatch`, `permit2_token_mismatch`, `permit2_allowance_required`,
`insufficient_funds`, `invalid_transaction_state`, `settlement_pending`, and `transaction_failed`.

## Security Considerations

Only configured chain IDs, Permit2 deployments, and proxy deployments may be used. Payload-supplied
addresses MUST NOT replace those constants. Permit2 nonce consumption and token authorization nonces
provide replay protection. The proxy is required because a raw Permit2 authorization without a
recipient-bound witness would let the submitter redirect funds.
