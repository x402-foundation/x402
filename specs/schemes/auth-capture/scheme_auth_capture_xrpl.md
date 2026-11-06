# Scheme: `auth-capture` on `XRPL`

## Summary

This is the XRP Ledger binding of [`auth-capture`](./scheme_auth_capture.md). It realizes the scheme with a native **conditional Escrow**, so no contract is deployed and every guarantee below is enforced by XRPL consensus.

It is a *full-capture-only profile*: the client authorizes an exact amount, and the hold is either captured in full or reclaimed after the deadline.

The client signs an `EscrowCreate` that locks `amount` drops for `payTo`, guarded by a PREIMAGE-SHA-256 crypto-condition and a `CancelAfter` deadline. The facilitator relays only that collect. A **capture authorizer** chosen by the client holds the preimage, signs the order it was created for, and releases the escrow with `EscrowFinish` once it accepts what the resource server delivered. If it never does, anyone may submit `EscrowCancel` after the deadline, and the funds can only return to the client.

Use cases: verify-then-pay for agents buying data or work, where the resource server is paid only after an independent check of the delivery; delayed delivery with buyer recourse.

## Network and asset

`network` is `xrpl:0` (mainnet) or `xrpl:1` (testnet). Network binding follows [`exact` XRPL §5](../exact/scheme_exact_xrpl.md#5-network-binding): `NetworkID` MUST be omitted, the facilitator MUST submit only to the requested network, and clients SHOULD use different accounts per network.

`asset` is `"XRP"` and `amount` is a string of drops. Issued currencies are out of scope for this profile.

## Payment flow

`paymentFlow` is `escrow` (settle → resource → settle).

| Step | Operation | XRPL | Who |
| --- | --- | --- | --- |
| Before the handler | `authorize` | presigned `EscrowCreate`, relayed by `/settle` | Facilitator |
| After the handler | — | nothing | — |
| Out of band | `capture` | `EscrowFinish` with the fulfillment, before `CancelAfter` | Capture authorizer, or anyone it hands the fulfillment to |
| After the deadline | `reclaim` | `EscrowCancel`, after `CancelAfter` | Anyone; funds go only to the client |

`operatorType` MUST be `"custom"` and `captureMode` MUST be `"deferred"`, as for a collect-only route in the [EVM binding](./scheme_auth_capture_evm.md#sync-and-async-finalize): the resource server skips the after-handler settle, and capture happens when the authorizer accepts the delivery. On XRPL there is no operator contract. `"custom"` here means what it means for the facilitator on EVM: it relays only the collect, and the lifecycle runs out of band under the capture authorizer's rules.

Because the collect settles before the handler runs, `/verify` and `/settle` are back to back, and the payer's `Sequence` is held only for the few seconds the `EscrowCreate` takes to validate, never for the handler's run time.

## PaymentRequirements

```json
{
  "scheme": "auth-capture",
  "network": "xrpl:1",
  "amount": "1000000",
  "asset": "XRP",
  "payTo": "rSELLER...",
  "maxTimeoutSeconds": 60,
  "extra": {
    "paymentFlow": "escrow",
    "assetTransferMethod": "sequence",
    "areFeesSponsored": false,
    "operatorType": "custom",
    "captureMode": "deferred",
    "captureAuthorizer": "rAUTHORIZER...",
    "captureAuthorizerPublicKey": "ED...",
    "orderId": "ord_7f3c...",
    "condition": "A0258020<64 hex>810120",
    "captureDeadline": 1761330000,
    "orderSignature": "<hex>"
  }
}
```

### `extra` fields

| Field | Required | Meaning |
| --- | --- | --- |
| `paymentFlow` | Yes | `"escrow"`. |
| `assetTransferMethod` | No | `"sequence"` (default) or `"ticketSequence"`, resolved as in [`exact` XRPL §7](../exact/scheme_exact_xrpl.md#7-expiry-and-account-sequencing). |
| `areFeesSponsored` | Yes | `false`. The payer pays the `EscrowCreate` fee. |
| `operatorType` | Yes | `"custom"`. |
| `captureMode` | Yes | `"deferred"`. |
| `captureAuthorizer` | Yes | Classic address of the party holding the preimage. |
| `captureAuthorizerPublicKey` | Yes | Hex public key that derives to `captureAuthorizer`. |
| `orderId` | Yes | The capture authorizer's id for this order. Fresh on every `402`. |
| `condition` | Yes | PREIMAGE-SHA-256 condition, 78 uppercase hex characters: `A0258020` ‖ SHA-256(preimage) ‖ `810120`. Fresh on every `402`. |
| `captureDeadline` | Yes | Absolute Unix seconds. `CancelAfter = captureDeadline − 946684800`. Fresh on every `402`. |
| `orderSignature` | Yes | The capture authorizer's signature over the order, per [Order signature](#order-signature). Fresh on every `402`. |

`orderId`, `condition`, `captureDeadline` and `orderSignature` are dynamic. A resource server MUST validate them as part of the requirements the client paid against and MUST NOT regenerate them on the paid retry. `refundDeadline`, `feeRecipient`, `minFeeBps` and `maxFeeBps` are absent, because refunds and fees are unsupported.

The preimage MUST be 32 bytes from a CSPRNG and MUST NOT be reused across orders. It MUST NOT be disclosed before capture.

### Order signature

The resource server writes the `402`, but the condition must come from the capture authorizer. Otherwise a resource server could name an authorizer the client trusts, use a condition whose preimage it holds itself, and finish the escrow without any check. The capture authorizer therefore signs every order it creates, and client and facilitator verify that signature.

The signed message is the SHA-256 digest of the canonical JSON of:

```json
{
  "domain": "x402-auth-capture-xrpl-order-v1",
  "network": "xrpl:1",
  "orderId": "ord_7f3c...",
  "condition": "A0258020<64 hex>810120",
  "captureDeadline": 1761330000,
  "captureAuthorizer": "rAUTHORIZER...",
  "payTo": "rSELLER...",
  "amount": "1000000",
  "asset": "XRP"
}
```

Canonical JSON sorts keys lexicographically and contains no whitespace. `condition` is uppercase; `captureDeadline` is an integer; every other value is a string. The signature is an XRPL key signature over the 32 digest bytes: Ed25519 over the bytes, or secp256k1 ECDSA (DER) over their SHA-512Half, as XRPL signs transactions. The `domain` value keeps the signature from being valid for any other message the same key signs.

An authorizer that never submits transactions itself MAY use an Ed25519 key it holds only for signing orders.

## Client payment payload

```json
{ "x402Version": 2, "accepted": { "...": "the requirements above" }, "payload": { "signedTxBlob": "120001..." } }
```

`signedTxBlob` is the hex of a fully signed `EscrowCreate`:

| Field | Value |
| --- | --- |
| `TransactionType` | `EscrowCreate` |
| `Account` | payer |
| `Destination` | `payTo` |
| `Amount` | `amount` |
| `Condition` | `extra.condition` |
| `CancelAfter` | `captureDeadline − 946684800` |
| `Sequence` | the payer's current sequence, or `0` with `TicketSequence` |
| `Fee` | at most the facilitator's policy maximum |
| `LastLedgerSequence` | within the policy in [`exact` XRPL §7](../exact/scheme_exact_xrpl.md#7-expiry-and-account-sequencing) |

`FinishAfter`, `DestinationTag`, `Memos`, `Delegate`, `Signers` and non-zero `Flags` MUST be absent.

### Payment identity

The escrow is identified by `(Owner = Account, OfferSequence = Sequence, or TicketSequence if a ticket was used)`, which anyone holding the blob can derive. The signed `condition` binds the escrow to one order; `EscrowCreate` has no `InvoiceID`.

### Client requirements

Before signing, the client:

- MUST verify `orderSignature` per [Order signature](#order-signature), using this request's `network`, `payTo`, `amount` and `asset`, and MUST check that `captureAuthorizerPublicKey` derives to `captureAuthorizer`;
- MUST refuse a `captureAuthorizer` it does not trust;
- MUST refuse a `captureDeadline` outside its own lock window: long enough for the authorizer to act, short enough to bound how long its funds are held;
- SHOULD NOT sign or submit another transaction from the payer account until the payment settles or `LastLedgerSequence` passes, when using `"sequence"`.

The client uses `orderId` to address the capture authorizer out of band, for example to forward the delivery it received.

## Verification

In order. Reasons are namespaced `invalid_auth_capture_xrpl_*` unless noted.

1. **Envelope.** `x402Version === 2`; `accepted.scheme` and `requirements.scheme` are `auth-capture`; `accepted.network === requirements.network` ∈ {`xrpl:0`, `xrpl:1`}; the selected `assetTransferMethod` follows `exact` XRPL §7; `asset === "XRP"`.
2. **`extra`.**
   - The constant fields above; `captureAuthorizer` a valid classic address; `orderId` non-empty; `condition` well-formed.
   - `captureDeadline` is an integer with `now + maxTimeoutSeconds + 20 ≤ captureDeadline ≤ now + maxLock`, where `maxLock` is facilitator policy. The lower bound keeps the escrow from expiring before it lands: 20 seconds is two ledger closes at a pessimistic 10-second rate, the landing margin of [`upto` XRPL](../upto/scheme_upto_xrpl.md). A facilitator MAY require more.
   - Every dynamic field and `captureAuthorizer` are equal between `accepted.extra` and `requirements.extra`.
   - `captureAuthorizerPublicKey` derives to `captureAuthorizer`, and `orderSignature` verifies over the terms of this request.
3. **Decode** `signedTxBlob`; `TransactionType === "EscrowCreate"`.
4. **Destination** `=== payTo`; no `DestinationTag`.
5. **Amount** is a string of drops `=== requirements.amount`.
6. **Condition** `=== extra.condition` (case-insensitive).
7. **`CancelAfter`** `=== captureDeadline − 946684800`; no `FinishAfter`.
8. **Network binding.** `NetworkID` absent.
9. **Sequencing and expiry.** As in `exact` XRPL §7: `LastLedgerSequence` present, after the current validated ledger and within policy; `sequence` requires `Sequence` equal to the account's current sequence and no `TicketSequence`; `ticketSequence` requires `Sequence === 0` and an available ticket.
10. **Safety.** `Fee` ≤ policy maximum; no `Memos`, `Delegate` or `Signers`; `Flags` is `0`.
11. **Signature.** Single-signed, valid, and the signing key derives to `Account`, whose master key is not disabled.
12. **Would succeed.** The facilitator MUST check that the transaction would currently succeed, and SHOULD use XRPL transaction simulation where available. Without simulation it MUST at least check: the payer's balance covers `amount` + `Fee` + the reserve with this escrow added (base + increment × (OwnerCount + 1)); the destination exists and has neither `lsfDepositAuth` (which would make `EscrowFinish` fail) nor `lsfRequireDestTag` set.

A payload carrying `payload.type` is a lifecycle operation, which this binding never relays; the facilitator MUST reject it with `invalid_auth_capture_xrpl_lifecycle_not_relayed`.

## Settlement

`/settle` re-runs verification, claims the transaction hash in the duplicate-settlement guard, submits the blob to the requested network, waits for a validated result, and succeeds only on `tesSUCCESS`.

The facilitator signs nothing and pays no fee on this path, so it is never the source of value or of a fee.

### Duplicate settlement mitigation (REQUIRED)

As in [`exact` XRPL](../exact/scheme_exact_xrpl.md#duplicate-settlement-mitigation-required): XRPL answers every resubmission of a known blob with the same validated success. The facilitator MUST check and record the transaction hash atomically before submitting, retain it until `LastLedgerSequence` has passed (also after a failed submit), and reject a hit with `duplicate_settlement`. The cache is short-lived and keyed only on hashes the facilitator has submitted.

## `SettlementResponse`

```json
{
  "success": true,
  "transaction": "<EscrowCreate hash>",
  "network": "xrpl:1",
  "payer": "rBUYER...",
  "amount": "1000000"
}
```

The escrow's identity, `(payer, Sequence or TicketSequence)`, derives from the blob, so no field is added. The after-handler settle is skipped (`captureMode: "deferred"`), and a resource server MAY return this collect response for it.

## Capture and reclaim

Neither is relayed through `/settle`.

- **Capture.** `EscrowFinish { Owner, OfferSequence, Condition, Fulfillment }`, with `Fulfillment = A0228020 ‖ preimage`, submitted while the parent ledger's close time is before `CancelAfter`. The capture authorizer decides when to release; since the ledger only checks the fulfillment, it MAY hand the fulfillment to any party to submit. The submitter pays a fee above the base fee because of the fulfillment. The preimage becomes public once the finish validates; the escrow no longer exists by then.
- **Reclaim.** Anyone submits `EscrowCancel { Owner, OfferSequence }` once close time is past `CancelAfter`. Funds can only return to `Owner`.

Ledger close time has coarse resolution (up to about 10 s). Implementations SHOULD keep margins of about 20 s on both sides of the deadline.

## Account requirements

| Role | Requirement |
| --- | --- |
| Client | An activated account holding `amount` + `Fee` + one owner-reserve increment above its current reserve. The increment stays locked until the escrow closes. With `"ticketSequence"`, an available ticket. |
| Resource server | `payTo` is an activated account without `lsfDepositAuth` or `lsfRequireDestTag`. No RPC is needed. |
| Capture authorizer | A key for signing orders. Whoever submits `EscrowFinish` needs XRP for its fee. |
| Facilitator | An RPC connection to each network it serves. No account and no funds. |

## `/supported`

```json
{
  "x402Version": 2,
  "scheme": "auth-capture",
  "network": "xrpl:1",
  "extra": {
    "areFeesSponsored": false,
    "operatorTypes": ["custom"]
  }
}
```

A resource server MUST check that `operatorTypes` includes `"custom"`. The facilitator signs nothing on this path, so it advertises no `signers` for `xrpl:*`. The EVM `operators` allowlist does not apply: there is no operator contract to admit.

## Error codes

Verification failures use the reasons below. Standard reasons keep their canonical names.

| Reason | Rule |
| --- | --- |
| `invalid_auth_capture_xrpl_x402_version`, `invalid_auth_capture_xrpl_scheme`, `invalid_auth_capture_xrpl_network`, `invalid_auth_capture_xrpl_asset_transfer_method`, `invalid_auth_capture_xrpl_asset` | 1 |
| `invalid_auth_capture_xrpl_payment_flow`, `invalid_auth_capture_xrpl_operator_type`, `invalid_auth_capture_xrpl_capture_mode`, `invalid_auth_capture_xrpl_fees_sponsored`, `invalid_auth_capture_xrpl_capture_authorizer`, `invalid_auth_capture_xrpl_order_id`, `invalid_auth_capture_xrpl_condition`, `invalid_auth_capture_xrpl_capture_deadline`, `invalid_auth_capture_xrpl_order_signature` | 2 |
| `invalid_auth_capture_xrpl_payload`, `invalid_auth_capture_xrpl_transaction_type` | 3 |
| `invalid_auth_capture_xrpl_destination`, `invalid_auth_capture_xrpl_destination_tag` | 4 |
| `invalid_auth_capture_xrpl_amount` | 5 |
| `invalid_auth_capture_xrpl_condition_mismatch` | 6 |
| `invalid_auth_capture_xrpl_cancel_after`, `invalid_auth_capture_xrpl_finish_after` | 7 |
| `invalid_auth_capture_xrpl_network_id` | 8 |
| `invalid_auth_capture_xrpl_last_ledger_sequence`, `invalid_auth_capture_xrpl_sequence`, `invalid_auth_capture_xrpl_ticket` | 9 |
| `invalid_auth_capture_xrpl_fee`, `invalid_auth_capture_xrpl_memos`, `invalid_auth_capture_xrpl_delegate`, `invalid_auth_capture_xrpl_signers`, `invalid_auth_capture_xrpl_flags` | 10 |
| `invalid_auth_capture_xrpl_signature` | 11 |
| `invalid_auth_capture_xrpl_insufficient_funds`, `invalid_auth_capture_xrpl_destination_not_found`, `invalid_auth_capture_xrpl_destination_flags` | 12 |
| `invalid_auth_capture_xrpl_lifecycle_not_relayed` | lifecycle payload |
| `duplicate_settlement` | settlement guard |

Ledger results at settle map onto the same reasons: `tecUNFUNDED` and `tecINSUFFICIENT_RESERVE` to `insufficient_funds`; `tecNO_DST` and `tecNO_DST_INSUF_XRP` to `destination_not_found`; `tecNO_PERMISSION`, which `EscrowCreate` returns when `CancelAfter` has already passed, to `capture_deadline`; `tefPAST_SEQ` to `sequence`. Any other non-`tesSUCCESS` result is `invalid_auth_capture_xrpl_ledger_rejected`.

## Security considerations

**Trust minimization.** The facilitator holds no key and no funds and cannot redirect a payment: `Destination` is fixed in the signed blob. The capture authorizer can only pay `payTo` the full amount or let the escrow refund.

**Untrusted `402`.** Every `extra` field comes from the resource server. The client trusts `captureAuthorizer` only by its own allowlist, and the condition only through `orderSignature`, which binds it to this network, `payTo`, `amount`, `asset` and deadline. A resource server that substitutes its own condition cannot produce that signature. The facilitator repeats the check so a client that skipped it is still protected.

**Choosing the authorizer.** The client trusts the authorizer to judge honestly, so the client picks it. A resource server acting as its own authorizer reduces the scheme to pay-first.

**Delivery binding.** Resource servers SHOULD sign the bytes they deliver (for example SHA-256 of `orderId + "\n" + body` with the `payTo` key), so the authorizer judges exactly what the client received and the client cannot forge a bad delivery.

**Reclaim is open.** The core scheme describes `reclaim` as the client's escape hatch. On XRPL anyone may submit `EscrowCancel` after the deadline; funds still go only to `Owner`.

## Limitations

- **No fee sponsorship.** XRPL charges the fee to the transaction's `Account`, as in [`exact` XRPL](../exact/scheme_exact_xrpl.md#payment-model).
- **No void before the deadline.** XRPL cannot cancel an escrow before `CancelAfter`, so a rejected delivery refunds at the deadline.
- **Full capture only.** An escrow finishes for its whole amount. Partial capture would need Payment Channels, as in [`upto` XRPL](../upto/scheme_upto_xrpl.md).
- **No refund after capture and no fee split.** `EscrowFinish` pays `Destination` the full amount.
- **XRP only.** Issued-currency holds (`TokenEscrow`) are a natural extension.

## Appendix

### Network requirements

| # | Requirement | This binding |
| --- | --- | --- |
| 1 | Hold / settlement mechanism | Conditional `EscrowCreate`. Capture is `EscrowFinish`, full amount only. The deadline is `CancelAfter`, enforced by consensus. No void or refund. |
| 2 | Client authorization format | Presigned `EscrowCreate` in `signedTxBlob`; identity `(Account, Sequence \| TicketSequence)`. |
| 3 | Operator model | `"custom"`. The facilitator relays only `authorize`. Capture is driven by `captureAuthorizer`, reclaim by anyone, both out of band. |
| 4 | Server consent | No lifecycle operation is relayed. The right to capture is the fulfillment, held by the authorizer the client chose and bound to the order by `orderSignature`. |
| 5 | Replay protection | The ledger consumes each escrow once. The collect is deduplicated by transaction hash. |
| 6 | Per-operation verification and settlement | `authorize`: [Verification](#verification), then [Settlement](#settlement). Capture and reclaim are checked by consensus. |
| 7 | Refund funding | Refunds are unsupported. `reclaim` returns the client's own hold; the facilitator is never a source of value. |
| 8 | Sync capture-and-void | Unsupported; `captureMode` MUST be `"deferred"`. |

## Version History

| Version | Date | Changes | Authors |
| --- | --- | --- | --- |
| v1.0 | 2026-10-26 | Initial draft (full-capture-only profile) | @Meredithhelipigeon |
