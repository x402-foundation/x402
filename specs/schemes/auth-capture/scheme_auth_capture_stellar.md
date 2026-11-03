# Scheme: `auth-capture` on `Stellar`

## Versions supported

- ❌ `v1`
- ✅ `v2`

## Supported Networks

This spec uses [CAIP-2](https://namespaces.chainagnostic.org/stellar/caip2) identifiers:

- `stellar:pubnet` — Stellar mainnet
- `stellar:testnet` — Stellar testnet

## Summary

This is the Stellar binding of [`auth-capture`](./scheme_auth_capture.md). It specifies the escrow contract, wire fields, authorization entries, and facilitator logic that realize the scheme on Soroban.

The binding uses a single Soroban contract, `AuthCaptureEscrow`, that holds funds, enforces expiry ordering and fee bounds, and moves value on every operation. Funds are [SEP-41] tokens. Classic Stellar assets are supported through their Stellar Asset Contract (SAC).

Authorization uses Soroban's native authorization framework instead of off-chain signatures:

- The **client** signs one authorization entry for the collect call (`authorize` or `charge`). The token transfer into the escrow is a sub-invocation of that same entry. No token collector contract is involved.
- The **receiver authorizer** signs one authorization entry for each server-side operation (`charge`, `capture`, `void`, `refund`). The escrow checks it with `require_auth`. Server consent is therefore enforced onchain, not only by the facilitator.
- Every authorization entry carries a nonce and an expiration ledger, which the network enforces. Each consent is single-use without any state kept by the facilitator or the escrow.

The facilitator is the operator. It submits every transaction from its own account, sponsors network fees, and never appears as the source of any value transfer.

> [!NOTE]
> **Scope:** This binding defines one operator model, `"delegated"`. Because server consent is verified by the escrow, the guarantees that the EVM binding reserves for its future `"policy"` operator type hold here for every payment.

## Escrow contract

`AuthCaptureEscrow` exposes the following functions. `PaymentInfo` is defined in the [appendix](#paymentinfo-struct). Amounts are `i128` in token base units. Timestamps are Unix seconds compared against the ledger close time.

| Function | Signature | Authorization required |
| --- | --- | --- |
| `authorize` | `authorize(payment_info: PaymentInfo) -> BytesN<32>` | `operator`; `payer` for args `[payment_info]` |
| `charge` | `charge(payment_info: PaymentInfo, amount: i128, fee_amount: i128, fee_receiver: Option<Address>) -> BytesN<32>` | `operator`; `payer` for args `[payment_info]`; consent address |
| `capture` | `capture(payment_info: PaymentInfo, amount: i128, fee_amount: i128, fee_receiver: Option<Address>, void_remainder: bool)` | `operator`; consent address |
| `void` | `void(payment_info: PaymentInfo)` | `operator`; consent address |
| `refund` | `refund(payment_info: PaymentInfo, amount: i128, funder: Address)` | `operator`; consent address; `funder` (token transfer) |
| `reclaim` | `reclaim(payment_info: PaymentInfo)` | `payer` |
| `payment_hash` | `payment_hash(payment_info: PaymentInfo) -> BytesN<32>` | none |
| `payment_state` | `payment_state(payment_hash: BytesN<32>) -> PaymentState` | none |

The **consent address** is `payment_info.receiver_authorizer` when set, otherwise `payment_info.receiver`. The escrow calls `require_auth()` on it, so the authorization entry covers the function name and every argument of the call.

The escrow rejects at collect a payment whose consent address is the operator, and a payment that names the escrow itself as payer, receiver, or fee receiver. `refund` rejects the operator or the escrow as `funder`. The operator therefore cannot consent on the receiver's behalf or fund a refund, whatever the facilitator signs.

Behavior:

- `authorize` transfers `max_amount` from the payer into the escrow and records it as capturable.
- `charge` transfers `max_amount` from the payer into the escrow, distributes `amount` (fee first, remainder to `receiver`), returns `max_amount - amount` to the payer, and records `amount` as refundable. Collecting the full maximum lets the client sign before the server chooses `amount`.
- `capture` distributes `amount` from the hold and moves it from capturable to refundable. When `void_remainder` is `true`, the remaining hold is returned to the payer in the same call.
- `void` returns the whole remaining hold to the payer.
- `refund` transfers `amount` from `funder` to the payer and reduces the refundable balance. The escrow does not pay refunds from its own balance.
- `reclaim` returns the remaining hold to the payer once `authorization_expiry` has passed.

A payment can be collected once. `capture` and `refund` are repeatable up to the remaining balances.

## Protocol Flow

### Collect (`escrow` flow)

1. **Client** requests a resource from the **Resource Server**.
2. **Resource Server** responds `402 Payment Required` with an `auth-capture` entry in `accepts`.
3. **Client** builds `PaymentInfo` from the requirements, its own address, a random 32-byte `salt`, and `preApprovalExpiry = now + maxTimeoutSeconds`.
4. **Client** simulates `authorize(payment_info)` in recording mode, takes the authorization entry for its own address, and signs it with expiration `currentLedger + ceil(maxTimeoutSeconds / estimatedLedgerSeconds)`. Implementations should use the current network estimate for `estimatedLedgerSeconds` when available (fallback `5`).
5. **Client** retries the request with a `PaymentPayload` carrying the signed entry, `salt`, and `preApprovalExpiry`.
6. **Resource Server** forwards the payload to the facilitator's `/verify`, then `/settle`.
7. **Facilitator** rebuilds `PaymentInfo`, builds the `authorize` transaction with its own account as source, attaches the client's entry, simulates, signs, and submits.
8. **Resource Server** serves the resource after settlement succeeds.
9. **Resource Server** finalizes with a lifecycle settle: `capture` (optionally with `voidRemainder`) or `void`. This may happen in the same request (`captureMode: "sync"`) or later (`captureMode: "deferred"`).

### Collect (`authorization` flow)

Steps 1–6 are the same, except the client simulates `charge`. After the resource runs, the server completes the payload with `amount`, `feeAmount`, `feeReceiver`, and a consent entry, and calls `/settle`. There is no hold, so no `capture`, `void`, or `reclaim`.

### Lifecycle

`capture`, `void`, and `refund` are `/settle` calls whose payload names the operation in `payload.type`. The server produces the consent entry by simulating the escrow call and signing the authorization entry for the consent address. `reclaim` is called by the payer directly and is never relayed.

## `PaymentRequirements`

```json
{
  "scheme": "auth-capture",
  "network": "stellar:testnet",
  "amount": "10000000",
  "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "payTo": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  "maxTimeoutSeconds": 60,
  "extra": {
    "areFeesSponsored": true,
    "authCaptureEscrow": "CESCROWCONTRACTADDRESS...",
    "captureAuthorizer": "GFACILITATORADDRESS...",
    "receiverAuthorizer": "GRECEIVERAUTHORIZERADDRESS...",
    "paymentFlow": "escrow",
    "captureMode": "sync",
    "captureDeadline": 1740758554,
    "refundDeadline": 1741276954,
    "minFeeBps": 0,
    "maxFeeBps": 0,
    "feeRecipient": "GFEERECIPIENTADDRESS..."
  }
}
```

### `extra` fields

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `areFeesSponsored` | Yes | `boolean` | MUST be `true`. The facilitator pays network fees. |
| `authCaptureEscrow` | Yes | `string` | `AuthCaptureEscrow` contract address (`C...`). Clients and facilitators MUST check it against the canonical deployment for the network listed in [Deployments](#deployments). |
| `captureAuthorizer` | Yes | `string` | The operator: an account the facilitator controls and submits from. Committed as `PaymentInfo.operator`. Advertised in `/supported`. |
| `receiverAuthorizer` | No | `string` | Address whose authorization entry is required for `charge`, `capture`, `void`, and `refund`. Committed as `PaymentInfo.receiver_authorizer`. When absent, consent comes from `payTo`. |
| `paymentFlow` | No | `"escrow"` \| `"authorization"` | Selects whether the client's entry settles as `authorize` or `charge`. Default `"escrow"`. |
| `captureMode` | No | `"sync"` \| `"deferred"` | `escrow` only. `"sync"`: the server finalizes in the same request. `"deferred"`: the server finalizes later from stored state. Default `"sync"`. MUST NOT be set with `paymentFlow: "authorization"`. |
| `captureDeadline` | Yes | `number` | Unix seconds. Capture must happen before this; `reclaim` opens at this time. `PaymentInfo.authorization_expiry`. |
| `refundDeadline` | Yes | `number` | Unix seconds. Refund must happen before this. `PaymentInfo.refund_expiry`. MUST be greater than or equal to `captureDeadline`. |
| `minFeeBps` | Yes | `number` | Fee floor in basis points, `0`–`10000`. |
| `maxFeeBps` | Yes | `number` | Fee ceiling in basis points, `minFeeBps`–`10000`. |
| `feeRecipient` | No | `string` | Fee recipient. Committed as `PaymentInfo.fee_receiver`. When absent, `minFeeBps` and `maxFeeBps` MUST both be `0`. |

`requirements.amount` is the maximum the client authorizes (`PaymentInfo.max_amount`). `requirements.asset` is the SEP-41 token contract. `requirements.payTo` is the receiver.

## `PaymentPayload`

### Client payload

```json
{
  "x402Version": 2,
  "accepted": { "...": "the PaymentRequirements above" },
  "payload": {
    "authorizationEntry": "AAAAAQAAAAAAAAAA...",
    "salt": "1f0e5a...9c3a",
    "preApprovalExpiry": 1740672214
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `authorizationEntry` | `string` | Base64 XDR `SorobanAuthorizationEntry` signed by the payer. |
| `salt` | `string` | 32 bytes, hex. `PaymentInfo.salt`. MUST be random per payment. |
| `preApprovalExpiry` | `number` | Unix seconds. `PaymentInfo.pre_approval_expiry`. MUST NOT exceed `now + maxTimeoutSeconds` at verification, nor `captureDeadline`. Clients use `min(now + maxTimeoutSeconds, captureDeadline)`. |

The payer is the address in the entry's credentials. The facilitator rebuilds `PaymentInfo` from the requirements and these fields as the [appendix](#paymentinfo-struct) sets out.

The entry MUST have this shape:

- Credentials: `sorobanCredentialsAddress` or `sorobanCredentialsAddressV2` ([CAP-71]). `sorobanCredentialsSourceAccount` and `sorobanCredentialsAddressWithDelegates` MUST be rejected.
- `rootInvocation.function`: contract `extra.authCaptureEscrow`, function `authorize` for `"escrow"` or `charge` for `"authorization"`, args exactly `[payment_info]`.
- `rootInvocation.subInvocations`: exactly one, contract `requirements.asset`, function `transfer`, args `[payer, extra.authCaptureEscrow, requirements.amount]`, with no further sub-invocations.
- `signatureExpirationLedger` no later than `currentLedger + ceil(maxTimeoutSeconds / estimatedLedgerSeconds)`.

### Completed `charge` payload

For `paymentFlow: "authorization"`, the server appends four fields before `/settle` and leaves the client's fields unchanged:

```json
{
  "payload": {
    "authorizationEntry": "AAAAAQAAAAAAAAAA...",
    "salt": "1f0e5a...9c3a",
    "preApprovalExpiry": 1740672214,
    "amount": "7500000",
    "feeAmount": "0",
    "feeReceiver": null,
    "consentEntry": "AAAAAQAAAAAAAAAA..."
  }
}
```

`amount` is greater than zero and at most `PaymentInfo.max_amount`. `consentEntry` is the consent address's signed entry for `charge(payment_info, amount, fee_amount, fee_receiver)`.

When the server settles with a settlement override, `requirements.amount` at `/settle` equals the charged `amount` rather than the maximum. The facilitator then takes `max_amount` from the `transfer` sub-invocation of the client's entry; the entry shape check still binds it to `PaymentInfo`.

### Lifecycle payloads

Lifecycle payloads carry the full `paymentInfo` so the facilitator stays stateless. A server using `captureMode: "deferred"` MUST store `paymentInfo` after collect. The facilitator checks `paymentInfo` against the requirements and `extra` field by field, except `maxAmount`: a lifecycle settle may carry a settlement override in `requirements.amount`.

```json
{
  "payload": {
    "type": "capture",
    "paymentInfo": { "...": "see appendix" },
    "amount": "7500000",
    "feeAmount": "0",
    "feeReceiver": null,
    "voidRemainder": true,
    "consentEntry": "AAAAAQAAAAAAAAAA..."
  }
}
```

| `type` | Fields | Escrow call |
| --- | --- | --- |
| `capture` | `paymentInfo`, `amount`, `feeAmount`, `feeReceiver`, `voidRemainder`, `consentEntry` | `capture(payment_info, amount, fee_amount, fee_receiver, void_remainder)` |
| `void` | `paymentInfo`, `consentEntry` | `void(payment_info)` |
| `refund` | `paymentInfo`, `amount`, `funder`, `consentEntry`, `funderEntry` | `refund(payment_info, amount, funder)` |

For `refund`, `funderEntry` is the funder's signed entry. Its root invocation is the same `refund(payment_info, amount, funder)` call, with exactly one sub-invocation: `transfer(funder, payer, amount)` on `requirements.asset`. Rooting the entry at the escrow call binds the funder's authorization to this payment and amount. `funderEntry` is omitted when `funder` equals the consent address; the consent entry then carries the transfer sub-invocation instead.

`consentEntry` MUST use address credentials, MUST have the escrow call above as its root invocation with arguments matching the payload exactly, and MUST have no sub-invocations except the refund transfer when the consent address is also the funder.

## Verification

### Common checks

- `x402Version` is `2`. `accepted.scheme` and `requirements.scheme` are `"auth-capture"`. Networks match.
- `extra.authCaptureEscrow` is the canonical deployment for the network.
- `extra.captureAuthorizer` is an account the facilitator controls. Otherwise `invalid_auth_capture_stellar_operator_not_admitted`.
- `captureDeadline <= refundDeadline`, fee bounds are within `0`–`10000` with `minFeeBps <= maxFeeBps`, and a missing `feeRecipient` comes with zero fee bounds.
- Every authorization entry in the payload has address credentials, a valid signature for its address, and an unexpired `signatureExpirationLedger`.

### 🚨 Facilitator safety

- The facilitator's addresses MUST NOT appear in the credentials of any authorization entry in the payload.
- The facilitator's addresses MUST NOT be `payer`, `receiver`, `receiver_authorizer`, `fee_receiver`, or `funder`.
- The facilitator authorizes only as transaction source (operator and fee payer). It MUST NOT sign any authorization entry.
- Simulation MUST show only the balance changes expected for the operation, listed below, and no others.

### Per-operation checks

| Operation | Checks | Expected balance changes |
| --- | --- | --- |
| `authorize` | Client entry shape. `preApprovalExpiry` in the future and within `maxTimeoutSeconds`. Payment not yet collected. | payer `-max_amount`, escrow `+max_amount` |
| `charge` | As `authorize`, plus `0 < amount <= max_amount`, fee within bounds, `consentEntry` for the consent address. | payer `-amount`, receiver `+(amount - fee)`, fee receiver `+fee` |
| `capture` | `consentEntry` for the consent address. `amount <= capturable`. Before `captureDeadline`. | escrow `-amount` (`-capturable` if `voidRemainder`), receiver `+(amount - fee)`, fee receiver `+fee`, payer `+(capturable - amount)` if `voidRemainder` |
| `void` | `consentEntry` for the consent address. `capturable > 0`. | escrow `-capturable`, payer `+capturable` |
| `refund` | `consentEntry` for the consent address. `amount <= refundable`. Before `refundDeadline`. | funder `-amount`, payer `+amount` |

The facilitator reads `payment_state(payment_hash)` for balance checks and MUST also confirm them by simulation against the current ledger.

## Settlement

1. Re-run verification. `/settle` MUST NOT assume a prior `/verify`.
2. Build a transaction with source `extra.captureAuthorizer` and one `invokeHostFunction` operation calling the escrow function for the operation.
3. Attach the payload's authorization entries. The operator's own authorization is satisfied by the transaction source account.
4. Simulate, derive the fee as `simulationResourceFee + inclusionBuffer` (buffer at least 100 stroops), and refresh the Soroban resource data from that simulation. The facilitator MAY reject with `invalid_auth_capture_stellar_fee_exceeds_maximum` above a configured ceiling.
5. Sign, submit with `sendTransaction`, and poll until `SUCCESS` or `FAILED`.
6. Return the result.

```json
{
  "success": true,
  "transaction": "a1b2c3d4e5f6...",
  "network": "stellar:testnet",
  "payer": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  "amount": "7500000"
}
```

`amount` is the amount collected (`authorize`), charged, captured, voided, or refunded by this settle.

## Refund funding

Refund liquidity comes from `funder`, an address chosen by the server, typically `payTo`. The funder authorizes the transfer itself. The escrow never pays a refund from held funds of other payments, and rejects the operator and itself as funder. Unlike the EVM `"delegated"` binding, a facilitator MAY relay refunds, because no value it controls is at risk.

## Replay protection

Each authorization entry has a nonce that the network consumes on use and an expiration ledger after which it is invalid. A consent entry for `capture` or `refund` therefore authorizes exactly one call. Repeated captures or refunds each need a new consent entry. Neither the facilitator nor the escrow keeps nonce state.

Because consent entries are bound to the exact call arguments, including `payment_info`, an entry cannot be replayed against another payment, another escrow, or another network.

## `/supported`

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "auth-capture",
      "network": "stellar:testnet",
      "extra": {
        "areFeesSponsored": true,
        "authCaptureEscrow": "CESCROWCONTRACTADDRESS...",
        "captureAuthorizer": "GFACILITATORADDRESS...",
        "minFeeBps": 0,
        "maxFeeBps": 0
      }
    }
  ]
}
```

`minFeeBps` and `maxFeeBps` here are the facilitator's fee terms. A server that agrees to them copies them into its requirements together with the facilitator's `feeRecipient`.

## Account requirements

| Role | Requirement |
| --- | --- |
| Client | Token balance of at least `requirements.amount` at collect. For a SAC of a classic asset, a trustline to that asset. No XLM is needed for fees. |
| Server | `payTo`, `feeRecipient`, and `funder` hold trustlines when the token is a SAC of a classic asset. `funder` holds enough balance for refunds. |
| Facilitator | `captureAuthorizer` is a funded account that pays fees and sequence numbers. |

The escrow contract holds SAC balances without a trustline.

## Storage lifetime

Payment state is persistent contract storage. The escrow extends its TTL on every write to cover `refund_expiry`, assuming 5-second ledgers, up to the network's maximum entry TTL. If the window exceeds that maximum or ledgers close faster, the entry can be archived before `refund_expiry`. Archived persistent entries are restorable and never lost. The entry must be restored (simulation returns a restore preamble) before the next operation; a facilitator MAY submit the restore itself.

Keeping state until `refund_expiry` makes `authorize` and `charge` more expensive in resource fees than an `exact` transfer. Facilitators SHOULD size their fee ceiling accordingly; the reference implementation defaults to 1,000,000 stroops.

## Security considerations

- **Shared balance.** The escrow holds all payments of a token in one balance; per-payment accounting keeps each payment's funds separate. An asset issuer that claws back or freezes the escrow's balance affects every pending payment in that asset. Servers SHOULD NOT accept assets with clawback enabled.
- **Blocked recipients.** If the fee receiver or the payer cannot receive the token (missing or deauthorized trustline), `capture` with a fee or with `voidRemainder` fails. Funds stay held; the server can capture without `voidRemainder`, and the payer can `reclaim` after `captureDeadline`.
- **Operator trust.** The operator only submits transactions. It cannot move funds without the payer's entry (collect) or the consent address's entry (all other operations). A facilitator MUST NOT let its source-account authority extend below the escrow root invocation, so a malicious token cannot use it. It attaches an explicit `sorobanCredentialsSourceAccount` entry whose invocation tree is the escrow call alone; enforcing-mode simulation then fails if anything else requires the operator's authorization.

## Error codes

Verification errors use the prefix `invalid_auth_capture_stellar_`:

| Code | Meaning |
| --- | --- |
| `..._payload_format` | Payload fields missing or malformed. |
| `..._escrow_mismatch` | `authCaptureEscrow` is not the canonical deployment. |
| `..._operator_not_admitted` | `captureAuthorizer` is not controlled by the facilitator. |
| `..._unsupported_payment_flow` | Unknown `paymentFlow`, or an operation not allowed by it. |
| `..._extra` | Invalid deadlines, fee bounds, or fee recipient. |
| `..._authorization_entry` | Client entry has the wrong credentials, invocation, or sub-invocations. |
| `..._consent_entry` | Consent or funder entry missing, mismatched, or signed by the wrong address. |
| `..._signature` | An entry's signature is invalid. |
| `..._expired` | An entry or `preApprovalExpiry` has expired, or a deadline has passed. |
| `..._already_collected` | The payment was already collected. |
| `..._insufficient_balance` | Capturable or refundable balance is too low, or payer or funder balance is too low. |
| `..._facilitator_safety` | A facilitator safety check failed. |
| `..._simulation_failed` | Simulation failed or showed unexpected balance changes. |
| `..._fee_exceeds_maximum` | Simulated network fee is above the facilitator's ceiling. |

## Deployments

| Network | `AuthCaptureEscrow` |
| --- | --- |
| `stellar:testnet` | `CCB3W5542IQIVWT3ZDTSQIN2LPRMVYLZ2KKQOJT2CTIIDDTYIQVHHCCI` |
| `stellar:pubnet` | TBD |

## Appendix

### `PaymentInfo` struct

```rust
pub struct PaymentInfo {
    pub operator: Address,                    // extra.captureAuthorizer
    pub payer: Address,                       // credentials address of the client's entry
    pub receiver: Address,                    // requirements.payTo
    pub receiver_authorizer: Option<Address>, // extra.receiverAuthorizer
    pub token: Address,                       // requirements.asset
    pub max_amount: i128,                     // requirements.amount
    pub pre_approval_expiry: u64,             // payload.preApprovalExpiry
    pub authorization_expiry: u64,            // extra.captureDeadline
    pub refund_expiry: u64,                   // extra.refundDeadline
    pub min_fee_bps: u32,                     // extra.minFeeBps
    pub max_fee_bps: u32,                     // extra.maxFeeBps
    pub fee_receiver: Option<Address>,        // extra.feeRecipient
    pub salt: BytesN<32>,                     // payload.salt
}
```

In JSON payloads, `paymentInfo` uses the same field names in camelCase, addresses as strkeys, `maxAmount` as a decimal string, and `salt` as hex.

### Payment hash

```
payment_hash = sha256(network_id || xdr(escrow_address) || xdr(payment_info))
```

`network_id` is the SHA-256 of the network passphrase. The hash keys the escrow's payment state and binds a payment to one network and one escrow deployment.

### Expiry ordering

The escrow enforces `pre_approval_expiry <= authorization_expiry <= refund_expiry`.

| Expiry | Enforced at | Effect |
| --- | --- | --- |
| `pre_approval_expiry` | `authorize`, `charge` | Blocks collect |
| `authorization_expiry` | `capture` | Blocks capture; enables `reclaim` |
| `refund_expiry` | `refund` | Blocks refund |

### Fee system

`charge` and `capture` take `fee_amount` in token base units. The escrow requires `amount * min_fee_bps / 10000 <= fee_amount <= amount * max_fee_bps / 10000` with integer division. A non-zero fee requires a fee receiver. When `PaymentInfo.fee_receiver` is set, the call's `fee_receiver` MUST equal it. When it is not set, fee bounds MUST be zero.

Unlike the EVM `"delegated"` binding, the consent entry covers `fee_amount` and `fee_receiver` and is verified by the escrow, so the submitted fee is exactly what the receiver authorized.

[SEP-41]: https://stellar.org/protocol/sep-41
[CAP-71]: https://github.com/stellar/stellar-protocol/blob/master/core/cap-0071.md
