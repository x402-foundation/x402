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

Tokens must implement the selected authorization method; publication of TIP-3009 does not add it to
existing tokens. For deployments such as USDT that do not implement TIP-3009, `permit2` is the
practical path when the configured Permit2 deployment supports the token and sufficient allowance
has been granted. Requirements for those tokens MUST explicitly select `permit2`; this does not
change the default method when `assetTransferMethod` is omitted.

## Payment Flow and Resource Costs

Both methods are facilitator-submitted and support the `authorization` payment flow
(verify → resource → settle), which is the default. This binding does not define additional payment
flows. An absent `extra.paymentFlow` means `authorization`.

The facilitator submits and pays the Energy/Bandwidth cost of settlement. The payer signs the payment
authorization off-chain. Permit2's initial TRC-20 approval is a separate payer-signed transaction;
this binding does not sponsor its resource cost.

### Account Preconditions

The payer MUST have sufficient token balance. For `permit2`, the payer MUST have granted sufficient
allowance to the configured Permit2 contract, not to the exact proxy. `tip3009` does not require
this Permit2 allowance. Signing an authorization off-chain does not itself require the payer to
hold TRX; any initial approval transaction and account activation remain separate prerequisites
under the applicable network and token rules.

The facilitator's submitting account MUST be activated and able to cover settlement costs through
available Energy/Bandwidth or the network's TRX payment fallback, with an appropriate transaction
`fee_limit`. Pre-staked resources are not mandatory. A submitting-account configuration or funding
failure is a facilitator availability failure, not evidence that the payer lacks tokens. This
binding does not impose a blanket activation requirement on every token recipient.

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

Requirements, the payload's `accepted.network`, and responses MUST use the decimal CAIP-2
identifiers above. Hexadecimal references such as `tron:0xcd8690dc` are not a wire format defined by
this binding. An implementation may migrate legacy configuration before constructing requirements;
it MUST NOT silently rewrite a client's accepted terms during verification.

The numeric TIP-712 `chainId` is the decimal CAIP-2 reference interpreted as an unsigned integer.
For TIP-3009, wallets and verifying token contracts MUST use `block.chainid & 0xffffffff`, as
specified by TIP-3009. This is the same numeric value as the corresponding network entry above;
the domain field remains ABI-encoded as `uint256`, not as four bytes or a CAIP-2 string.
[TIP-474](https://github.com/tronprotocol/tips/blob/master/tip-474.md) describes the historical and
optimized `CHAINID` opcode values. Permit2 uses the domain of its configured deployment; this
binding requires the same network integer and does not assert how that deployment computes it.

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
match normalized `from`, using the configured contract's signature validity rules.

Clients MUST produce canonical low-`s` signatures. In both verification and pre-broadcast
re-verification, facilitators MUST reject signatures unless `1 <= r < n` and `1 <= s <= floor(n/2)`,
where `n` is the secp256k1 curve order:

```text
n          = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141
floor(n/2) = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0
```

Recovering the correct payer does not make a high-`s` signature acceptable. Facilitators MUST NOT
silently normalize a received high-`s` signature and accept it. TIP-3009 requires this rejection in
the verifying token contract as well; for Permit2, the facilitator check is mandatory regardless
of whether the configured deployment also enforces low-`s` on-chain.

Compact signatures, contract-wallet signatures and TRON account-permission multisignatures are outside this
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

1. Match both schemes and the accepted network using the canonical identifiers above, and reject
   unsupported transfer methods or payment flows. Validate the payload structure and the client's
   accepted terms against the server-selected requirements. The payload MUST use the transfer
   method selected by the requirements.
2. Reconstruct typed data using the requirement's network and configured contracts.
3. Validate the signature encoding and recover the payer specified by `from`, as defined above.
4. Match recipient, asset, and exact amount.
5. Apply the activation and remaining-validity checks in Authorization Timing. Before submission,
   also satisfy the submitting-account prerequisites in Account Preconditions.
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
semantics. For standard TRC-20 tokens, decode this transaction's raw `log` entries according to
[TRON's event-log format](https://developers.tron.network/docs/event):

1. Normalize `requirements.asset` by validating and decoding its Base58Check address, checking the
   21-byte result starts with `0x41`, and removing that one network-prefix byte. The log's `address`
   MUST equal the resulting 20-byte token address. Raw receipt emitters already omit `0x41`; do not
   remove another byte, even when the 20-byte value itself starts with `41`.
2. A standard non-anonymous `Transfer(address,address,uint256)` entry MUST have exactly three
   32-byte topics. `topics[0]` MUST equal the Keccak-256 event signature hash:
   `ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`.
3. `topics[1]` and `topics[2]` MUST each be an ABI address word: twelve zero bytes followed by
   the 20-byte `from` and `to`, respectively. Neither word contains a TRON network-prefix byte.
   Compare `from` with `authorization.from` for `tip3009` or `permit2Authorization.from` for
   `permit2`; compare `to` with `requirements.payTo` normalized as in step 1. Compare address bytes,
   not the literal Base58 and hex strings.
4. `data` MUST contain exactly one 32-byte unsigned big-endian integer. Its value MUST equal
   `requirements.amount` in atomic units, without rounding or floating-point conversion.
5. There MUST be exactly one matching transfer. Multiple matching entries are ambiguous and MUST
   NOT establish success; multiple smaller transfers MUST NOT be summed to satisfy the amount.
   Other logs do not automatically invalidate a payment, but evidence contradicting the exact
   transfer or facilitator-safety requirements MUST NOT be ignored merely because one entry matches.

Hex letter case and an optional display `0x` prefix may be normalized before validating the byte
length and comparing values. Implementations MUST NOT truncate malformed values or strip `41`
from an already 20-byte address. A proxy event or a same-named event from another token is
insufficient. Logs from tokens with unsupported transfer semantics do not establish payment merely
because their fields match.

For example, the following synthetic log matches the `tip3009` payload example's token, payer,
recipient and amount. It illustrates encoding only and is not an on-chain receipt:

```json
{
  "address": "5555555555555555555555555555555555555555",
  "topics": [
    "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    "0000000000000000000000001111111111111111111111111111111111111111",
    "0000000000000000000000004444444444444444444444444444444444444444"
  ],
  "data": "00000000000000000000000000000000000000000000000000000000000003e8"
}
```

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

Every non-empty `SettleResponse.transaction` MUST be the original txID encoded as exactly 64
lowercase hexadecimal characters without `0x` (`^[0-9a-f]{64}$`). Success, pending, and terminal
post-submission failure MUST use that same identity. RPC display prefixes or letter case may be
normalized; the authorization hash, signature hash, or an event identifier MUST NOT replace txID.
As permitted by core, a failure known to precede broadcast uses `transaction: ""`. This exception
does not apply when submission may have occurred but transaction identity is unavailable.

An unavailable or incomplete receipt is unresolved evidence. A complete receipt whose execution
or transfer evidence contradicts these requirements, including the absence of the required transfer,
is terminal failure once the confirmation policy is met; it MUST NOT remain pending indefinitely.

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

Reasons are stable, machine-readable tokens. A failed `/verify` returns `isValid: false` with
`invalidReason`. The same check failing during pre-broadcast settlement verification returns
`success: false` with the same token in `errorReason`. Successful responses omit the failure reason.
The following table defines their meaning and the corresponding caller action; it does not add
fields to the core response schemas.

### Verification and Pre-Broadcast Failures

These codes apply to `invalidReason` during verification and `errorReason` before settlement
submission. None authorizes another resource delivery or permits ignoring an earlier pending
transaction for the same authorization.

| Reason | Condition | Caller action |
| --- | --- | --- |
| `invalid_exact_tron_scheme` | Scheme does not match `exact` | Correct the payment terms |
| `invalid_exact_tron_network_mismatch` | Network does not match the required canonical network | Correct the network; do not substitute deployments |
| `invalid_exact_tron_asset_transfer_method` | Method identifier is not defined by this binding | Correct the method |
| `invalid_exact_tron_unsupported_asset_transfer_method` | Method is defined but unavailable on this facilitator/network | Select a service supporting the required method; no silent fallback |
| `invalid_payload` | Missing or malformed payload, address, integer, or nonce encoding | Correct the payload |
| `invalid_payment_requirements` | Malformed requirements or unsupported payment flow | Correct the server requirements |
| `missing_tip712_domain` | Required token domain name or version is absent | Correct the server requirements |
| `invalid_exact_tron_payload_signature` | Invalid signature encoding, high-`s`, or recovered payer mismatch, for either method | Obtain a valid signature |
| `invalid_exact_tron_payload_recipient_mismatch` | Signed recipient differs from `payTo`, for either method | Correct the authorization |
| `invalid_exact_tron_payload_authorization_value_mismatch` | `tip3009` value differs from the exact amount | Correct the authorization |
| `permit2_amount_mismatch` | Permit2 permitted amount differs from the exact amount | Correct the authorization |
| `invalid_exact_tron_payload_asset_mismatch` | Client's accepted asset differs from server requirements | Correct the accepted terms |
| `permit2_token_mismatch` | Permit2 signed token differs from the required asset | Correct the authorization |
| `invalid_permit2_spender` | Signed spender is not the configured exact proxy | Correct the authorization |
| `invalid_exact_tron_payload_authorization_valid_before` / `permit2_deadline_expired` | The respective authorization has expired | Obtain a fresh authorization |
| `invalid_exact_tron_payload_authorization_valid_after` / `permit2_not_yet_valid` | The respective authorization's lower time bound is not satisfied | Wait and re-verify within the remaining validity window |
| `authorization_window_insufficient` | Not expired, but insufficient remaining time under the applicable `S`, `B`, and `M` checks | Obtain a fresh authorization; do not reset the old expiry |
| `invalid_transaction_state` | Authorization nonce is confirmed consumed or cancelled | Do not reuse the authorization; this code MUST NOT represent a failed nonce read |
| `insufficient_funds` | Required payer token balance is confirmed insufficient | Restore balance and re-verify |
| `permit2_allowance_required` | Payer's allowance to Permit2 is confirmed insufficient | Establish sufficient allowance and re-verify |
| `chain_read_failed` | Required chain state cannot be established by successful reads or successful simulation | Retry verification after infrastructure recovery; do not infer invalid nonce or insufficient funds |
| `chain_time_unavailable` | Required chain-time freshness or clock bounds cannot be established | Restore time evidence and re-verify |
| `simulation_reverted` | Simulation establishes execution failure without a more specific reason above | Resolve the failure before re-verification; do not broadcast blindly |
| `facilitator_unavailable` | Submitting account is unactivated, misconfigured, or unable to cover resource costs | Restore facilitator availability and re-verify; do not charge this to payer token balance |

If multiple checks fail, report a specific established cause; do not infer a payment defect from an
infrastructure exception. For `tip3009`, the token is bound through the reconstructed domain, not a
`payload.token` field. A signature made for another domain without an explicit accepted-asset
mismatch fails signature validation; it does not independently reveal the other signed token.
Simulation unavailability alone is not `simulation_reverted`: successful state reads may still
establish all mandatory conditions as described in Verification.

Core codes `invalid_x402_version`, `unexpected_verify_error`, and `unexpected_settle_error` apply
to an invalid protocol version and otherwise unclassified failures in the corresponding stage.
An unexpected error MUST NOT be used to disguise a possibly submitted transaction as safe to retry.

### Post-Submission Outcomes

| `errorReason` | Condition | Caller action |
| --- | --- | --- |
| `settlement_pending` | Submission may have occurred, but execution, exact transfer, or required confirmation remains unresolved | Reconcile the original non-empty `transaction`; do not construct another transaction or deliver the resource again |
| `transaction_failed` | Confirmation policy is met and execution failed or complete transfer evidence contradicts the requirements | Preserve the original txID and report terminal failure; do not automatically resubmit the authorization |

A successful settlement has `success: true`, the original txID, and no `errorReason`. A possibly
submitted transaction whose identity was unexpectedly lost follows the infrastructure recovery
procedure above, outside a normal `SettleResponse`; neither an empty-ID `settlement_pending` nor an
ordinary retryable error is valid for that case. The pinned downstream implementation is not
asserted to emit every reason defined here; SDK adaptation remains separate work.

## Security Considerations

Only configured chain IDs, Permit2 deployments, and proxy deployments may be used. Payload-supplied
addresses MUST NOT replace those constants. Permit2 nonce consumption and token authorization nonces
provide replay protection. The proxy is required because a raw Permit2 authorization without a
recipient-bound witness would let the submitter redirect funds.
