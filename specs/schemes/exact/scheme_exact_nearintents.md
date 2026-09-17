# `exact` Scheme for NEAR Intents

## Summary

The `exact` payment scheme for Near Intents uses the [NEAR Intents 1Click Swap API](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api) as the settlement backend. This scheme facilitates cross-chain payments where a client pays a specified amount of a source asset on any [supported origin chain](https://docs.near-intents.org/resources/chain-support), and the resource server (merchant) receives an exact amount of a destination asset on any supported destination chain, with the NEAR Intents solver network executing the cross-chain swap in between.

The asset transfer method is `near-intents`. It belongs to the **client-submitted (payment proof)** family defined in [`scheme_exact.md`](./scheme_exact.md) and satisfies its requirements. It MUST use the `upfront` payment flow (`extra.paymentFlow: "upfront"`): the payment is confirmed before the resource executes, and the facilitator's `/verify` endpoint is not invoked. A resource server advertises one `accepts[]` entry per origin network it accepts from. The merchant configures only its destination recipient; refunds are returned to the client (see [Refunds](#refunds)).

---
 
## Protocol Flow
 
```
┌────────┐          ┌───────────────┐          ┌────────────────┐       ┌──────────────┐
│ Client │          │Resource Server│          │  Facilitator   │       │ 1Click Swap  │
│(Buyer) │          │  (Merchant)   │          │(x402 + 1Click) │       │     API      │
└───┬────┘          └──────┬────────┘          └───────┬────────┘       └──────┬───────┘
    │                      │                           │                      │
    │  1. GET /resource    │                           │                      │
    │─────────────────────>│                           │                      │
    │                      │                           │                      │
    │                      │  2. POST /quote           │                      │
    │                      │──────────────────────────>│                      │
    │                      │                           │  3. POST /v0/quote   │
    │                      │                           │     (dry: false)     │
    │                      │                           │     per origin       │
    │                      │                           │─────────────────────>│
    │                      │                           │  depositAddress,     │
    │                      │                           │  amount, deadline    │
    │                      │                           │<─────────────────────│
    │                      │  accepts[] entries        │                      │
    │                      │  + operationToken each    │                      │
    │                      │<──────────────────────────│                      │
    │                      │                           │                      │
    │  4. 402 Payment      │                           │                      │
    │     Required         │                           │                      │
    │  (one entry per      │                           │                      │
    │   origin network)    │                           │                      │
    │<─────────────────────│                           │                      │
    │                      │                           │                      │
    │  5. Client sends     │                           │                      │
    │     deposit TX on    │                           │                      │
    │     origin chain     │                           │                      │
    │     to payTo address │                           │                      │
    │  ════════════════════╪═══════════════════════════╪══(on-chain TX)═══════│
    │                      │                           │                      │
    │  6. GET /resource    │                           │                      │
    │  PAYMENT-SIGNATURE:  │                           │                      │
    │  {operationToken,    │                           │                      │
    │   txHash}            │                           │                      │
    │─────────────────────>│                           │                      │
    │                      │                           │                      │
    │                      │  7. POST /settle          │                      │
    │                      │  (facilitator resolves    │                      │
    │                      │   offer by token)         │                      │
    │                      │──────────────────────────>│                      │
    │                      │                           │ 8. POST              │
    │                      │                           │   /v0/deposit/submit │
    │                      │                           │─────────────────────>│
    │                      │                           │      OK              │
    │                      │                           │<─────────────────────│
    │                      │                           │                      │
    │                      │                           │ 9. Poll GET          │
    │                      │                           │   /v0/status         │
    │                      │                           │─────────────────────>│
    │                      │                           │  SUCCESS, or refund  │
    │                      │                           │  (payment failed)    │
    │                      │                           │<─────────────────────│
    │                      │                           │                      │
    │                      │  SettlementResponse       │                      │
    │                      │<──────────────────────────│                      │
    │                      │                           │                      │
    │                      │ 10. Execute route handler │                      │
    │                      │                           │                      │
    │  11. 200 OK          │                           │                      │
    │  + resource body     │                           │                      │
    │  + PAYMENT-RESPONSE  │                           │                      │
    │<─────────────────────│                           │                      │
```
 
### Step-by-step
 
1. **Client → Resource Server**: `GET /resource` without payment headers.
2. **Resource Server → Facilitator**: `POST /quote` with the merchant's destination terms and offered origins. See [Quote Operation](#quote-operation-post-quote).
3. **Facilitator → 1Click API**: one `POST /v0/quote` (`dry: false`, `swapType: EXACT_OUTPUT`) per offered origin. Each yields a single-use `depositAddress`, `amountIn`, `minAmountIn` and a `deadline`. The facilitator returns one `accepts[]` entry per origin, each with a fresh `operationToken`.
4. **Resource Server → Client**: `402 Payment Required`.
5. **Client sends deposit**: a transfer of `amount` of `asset` to `payTo` on `network` (with `extra.depositMemo` where required), before `maxTimeoutSeconds` elapses. The client persists the selected entry and the deposit `txHash`.
6. **Client → Resource Server**: retries with `PAYMENT-SIGNATURE` carrying `operationToken` and `txHash`.
7. **Resource Server → Facilitator `/settle`**: called before the route handler with `payload.accepted` as the requirements. The resource server MUST NOT rebuild and match requirements for this method, the facilitator validates them against the offer it issued (see [Settlement](#settlement-post-settle)).
8. **Facilitator → 1Click API**: `POST /v0/deposit/submit` to accelerate detection (optional).
9. **Facilitator polls `GET /v0/status`** until the payment is delivered (`SUCCESS`) or has failed without delivery.
10. **Resource Server** executes the route handler only after a successful `SettlementResponse`, once per operation.
11. **Resource Server → Client**: `200 OK` with the resource and `PAYMENT-RESPONSE`.
---
 
## PaymentRequirements for `exact`
 
```jsonc
{
  "scheme": "exact",
  "network": "eip155:42161",               // ORIGIN network: where the client pays
  "amount": "1005000",                     // deposit amount the client must send
  "asset": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // origin asset (USDC on Arbitrum)
  "payTo": "0x76b4c56085ED136a8744D52bE956396624a730E8", // 1Click deposit address on the origin network
  "maxTimeoutSeconds": 280,                // time left to deposit
  "extra": {
    "assetTransferMethod": "near-intents",
    "paymentFlow": "upfront",
    "operationToken": "b3f1c9e2-4d7a-4f0e-9c1b-7a2d6e5f8c04-9e1a2b3c4d5e6f70"
  }
}
```
 
Full `PaymentRequired` object:
 
```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Cross-chain premium market data access",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:42161",
      "amount": "1005000",
      "asset": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      "payTo": "0x76b4c56085ED136a8744D52bE956396624a730E8",
      "maxTimeoutSeconds": 280,
      "extra": {
        "assetTransferMethod": "near-intents",
        "paymentFlow": "upfront",
        "operationToken": "b3f1c9e2-4d7a-4f0e-9c1b-7a2d6e5f8c04-9e1a2b3c4d5e6f70"
      }
    }
  ]
}
```
 
The destination leg (merchant network, asset, recipient, and amount) is fixed in the quote, enforced by the settlement backend, and reported in the receipt.
 
### Mapping to Standard x402 Fields
 
| x402 Field | 1Click Source | Semantics in This Scheme |
|---|---|---|
| `scheme` | — | Always `"exact"`. |
| `network` | Request `originAsset` chain | CAIP-2 of the **origin** network: where the client pays and where the proof is anchored. |
| `amount` | `quote.amountIn` | The deposit amount the client MUST send, in base units of `asset`. Includes the backend's slippage buffer; see [Amount Validation](#amount-validation). |
| `asset` | Request `originAsset` | The origin asset, in the identifier used by that network's own x402 scheme. Otherwise it is the network's canonical identifier. |
| `payTo` | `quote.depositAddress` | The single-use deposit address. With `network` and `depositMemo`, the payment instrument. |
| `maxTimeoutSeconds` | `deadline` − now − margin | Time left to deposit at issuance. The client MUST deposit before it elapses. |
 
### Extra Field Descriptions
 
| Field | Type | Required | Description |
|---|---|---|---|
| `assetTransferMethod` | string | Yes | Always `"near-intents"`. |
| `paymentFlow` | string | Yes | Always `"upfront"`. |
| `operationToken` | string | Yes | Server-issued, opaque, unguessable (≥128 bits of entropy), unique per entry. Identifies the offer and authorizes its redemption. Transmitted only in the 402 and the payment payload; MUST NOT appear on chain or in receipts. |
| `depositMemo` | string | Conditional | Present only when the origin network requires a memo or destination tag (e.g., Stellar, XRP, TON). Part of the instrument. |
 
---
 
## PaymentPayload `payload` Field
 
```jsonc
  "payload": {
    "operationToken": "b3f1c9e2-4d7a-4f0e-9c1b-7a2d6e5f8c04-9e1a2b3c4d5e6f70",
    "txHash": "0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a",
    "refundTo": "0x2527D02599Ba641c19FEa793cD0F9a6e8457C317"   // optional
  }
```
 
Full `PaymentPayload` object:
 
```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/premium-data" },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:42161",
    "amount": "1005000",
    "asset": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "payTo": "0x76b4c56085ED136a8744D52bE956396624a730E8",
    "maxTimeoutSeconds": 280,
    "extra": {
      "assetTransferMethod": "near-intents",
      "paymentFlow": "upfront",
      "operationToken": "b3f1c9e2-4d7a-4f0e-9c1b-7a2d6e5f8c04-9e1a2b3c4d5e6f70"
    }
  },
  "payload": {
    "operationToken": "b3f1c9e2-4d7a-4f0e-9c1b-7a2d6e5f8c04-9e1a2b3c4d5e6f70",
    "txHash": "0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a"
  }
}
```
 
### Field Descriptions
 
| Field | Type | Required | Description |
|---|---|---|---|
| `payload.operationToken` | string | Yes | The token from the selected `accepts[]` entry. Proves the presenter received this offer. |
| `payload.txHash` | string | Yes | The client's deposit transaction on `accepted.network`. The payment proof. |
| `payload.refundTo` | string | No | Origin-network address to receive the refund if this payment fails. MUST be a valid address on `accepted.network`. Honored only with a valid `operationToken`, it defaults to the account debited by the deposit (see [Refunds](#refunds)). |
 
The proof is observation-dependent: validation requires observing the origin network or the backend.
 
---
 
## Facilitator Behavior
 
### Quote Operation (`POST /quote`)
 
A scheme-specific facilitator operation. It mints one 1Click quote per requested origin and returns payable `accepts[]` entries. Each quote is a solver-side price commitment, so the operation MUST be authenticated and facilitators SHOULD rate-limit issuance per resource server. Resource servers SHOULD offer a small set of origins. A merchant MAY run this operation by itself with its own 1Click credentials, provided the same party performs settlement.
 
Request:
 
```jsonc
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/premium-data" },
  "destination": {
    "network": "eip155:8453",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "amount": "1000000",                         // exact amount the merchant receives
    "recipient": "0xMerchantOnBase"
  },
  "origins": [
    { "network": "eip155:42161", "asset": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
    { "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }
  ],
  "slippageTolerance": 100,                      // optional, basis points
  "deadline": "2026-09-14T15:10:00Z",            // optional, ISO 8601
  "appFees": [ { "recipient": "merchant.near", "fee": 50 } ]   // optional, 1Click AppFee
}
```
 
Response: `{ "accepts": [ <PaymentRequirements>, ... ] }`, one entry per origin the facilitator could quote, each with a fresh `operationToken`.
 
For each origin the facilitator calls `POST {apiBaseUrl}/v0/quote` with the request's fields mapped to 1Click identifiers via `GET /v0/tokens`, fixing `dry: false`, `swapType: EXACT_OUTPUT`, `depositType: ORIGIN_CHAIN`, `depositMode: MEMO` for origin networks that require a memo (otherwise `SIMPLE`), `recipientType: DESTINATION_CHAIN`, `refundTo` = the facilitator's NEAR Intents account, `refundType: INTENTS`. 

The facilitator builds the entry as: `network` = origin, `asset` = origin asset, `payTo` = `quote.depositAddress`, `amount` = `quote.amountIn`, `maxTimeoutSeconds` = `quote.deadline` − now − margin, `extra.depositMemo` = `quote.depositMemo` when present, `extra.operationToken` fresh. It records the offer, including the requesting `resource`, before returning (see [Facilitator State](#facilitator-state)). Quotes are never reused.
 
### Settlement (`POST /settle`)
 
The rules below run inside `/settle`, before the resource executes.
 
1. **Structural**: `accepted.extra.assetTransferMethod` is `near-intents`; `payload.operationToken` equals `accepted.extra.operationToken`; `payload.txHash` is well-formed for `accepted.network`.
2. **Offer**: `payload.operationToken` resolves to an offer this facilitator issued; otherwise `invalid_exact_near_intents_offer_unknown`. `accepted` MUST equal the stored entry and `paymentPayload.resource.url` MUST equal the offer's resource; otherwise `invalid_exact_near_intents_offer_mismatch`.
3. **Claim**: claim `<network>:<txHash>` as in-flight for this operation. Concurrent presentations of the same proof MUST result in exactly one claim; the others receive `settlement_pending`. on settlement_pending the resource server returns the pending receipt and MUST NOT mint new offers for that request A proof already consumed by this operation returns the recorded `SettlementResponse`; a proof consumed by a different operation is rejected with `invalid_exact_near_intents_proof_bound`. A claim MUST expire, and a worker whose claim has expired MUST NOT consume.
4. **Deposit**: `txHash` is a confirmed transaction on `accepted.network` that transfers `accepted.asset` to `accepted.payTo` (with `depositMemo` where required). A transaction confirmed on the origin network that does not pay the instrument MUST be rejected with `invalid_exact_near_intents_deposit_not_found`. A transaction not yet observable is not final: release the claim and return `settlement_pending`; a facilitator MAY reject a transaction still unknown to the origin network after a documented observation window.
5. **Outcome**: notify the backend (`POST /v0/deposit/submit`), then poll `GET /v0/status?depositAddress=<addr>[&depositMemo=<memo>]`. The response carries `status` and `swapDetails`. 
   - Statuses `KNOWN_DEPOSIT_TX`, `PENDING_DEPOSIT`, `PROCESSING` and `INCOMPLETE_DEPOSIT` are non-terminal. 
   - `SUCCESS`, `REFUNDED` and `FAILED` are terminal. 
   - The proof is **valid** only when status is `SUCCESS` and `txHash` is among `swapDetails.originChainTxHashes[].hash`: the merchant received the destination asset. 
   - `REFUNDED` and `FAILED` are failures (see [Refunds](#refunds)). Value the backend returns after `SUCCESS` does not affect validity.
6. **Consume and respond**: consume the proof, record the `SettlementResponse` against the operation, and return it. On a terminal failure, consume the proof and record and return failure. An offer serves at most one proof. The recorded response is returned unchanged to any later presentation of the same operation.

**Not yet final:** If no terminal outcome is observable within the facilitator's settlement window, it MUST NOT consume the proof, MUST release the in-flight claim, and MUST return `success: false` with `errorReason: "settlement_pending"`, `transaction` = the deposit `txHash` and `network` = `accepted.network`, per section 9 of the core specification. The client MUST retry with the same `operationToken` and `txHash`, and MUST NOT fund a new offer while this operation is pending. An abnormally terminated attempt MUST NOT leave a proof claimed.
 
**Finality** is delivery to the merchant. A facilitator MUST NOT advance settlement on its own origin-network observation.
 
**On success** — `network` and `transaction` identify the delivery to the merchant on the destination network:
```jsonc
{
  "success": true,
  "network": "eip155:8453",
  "transaction": "<destination-network delivery tx hash>",
  "payer": "<account debited on the origin network>",
  "amount": "<swapDetails.amountOut>",
  "extensions": {
    "depositAddress": "<payTo>",
    "originNetwork": "eip155:42161",
    "originTxHash": "<payload.txHash>"
  }
}
```
 
**On failure** — no transaction has been broadcast by the facilitator at settlement time; the refund is forwarded afterwards to `refundTo`, where the client can observe it:
```jsonc
{
  "success": false,
  "errorReason": "exact_near_intents_payment_failed",
  "network": "eip155:42161",
  "transaction": "",
  "payer": "<account debited on the origin network>",
  "extensions": {
    "depositAddress": "<payTo>",
    "originTxHash": "<payload.txHash>",
    "status": "<1Click status>",
    "refundReason": "<swapDetails.refundReason>",
    "refundTo": "<beneficiary address on the origin network>"
  }
}
```
 
**Not yet final**:
```jsonc
{
  "success": false,
  "errorReason": "settlement_pending",
  "network": "eip155:42161",
  "transaction": "<payload.txHash>",
  "extensions": { "depositAddress": "<payTo>", "status": "PROCESSING" }
}
```
 
Returned in `PAYMENT-RESPONSE`. Under `upfront` the receipt is returned even when the route handler fails, per the core specification. Receipts MUST NOT include the `operationToken`.
 
### Refunds
 
Refunds to the client apply only to failed payments. Two cases: a deposit whose swap ended in `REFUNDED` or `FAILED`, and a deposit that purchased nothing because its offer was already consumed. In both, the backend returns the value to the facilitator's NEAR Intents account (`refundTo`/`refundType: INTENTS`) and the facilitator forwards it.
 
- The facilitator MUST monitor every issued instrument until the backend reaches a terminal status, independently of any `/settle` call; a client that never presents a proof is still refunded.
- The beneficiary is `payload.refundTo` when presented with a valid `operationToken`.
- The amount forwarded is the backend-returned amount net of the backend's `refundFee` and the facilitator's published forwarding fee.
- A refund MUST be reported to the client as complete only after the forwarding transaction is confirmed. Refund records MUST be retained until forwarded or marked unresolved.

**Surplus.** On a successful `EXACT_OUTPUT` swap the backend returns the unused part of the slippage buffer to 1Click's param `refundTo`. This surplus is retained by the facilitator as a processing fee and is not returned to the client. Facilitators MUST document this in their fee schedule, and resource servers SHOULD set `slippageTolerance` so the buffer is small.
 
### Facilitator State
 
Keyed by `operationToken`, indexed by instrument `(network, payTo, depositMemo)` and by `(network, txHash)`:
 
| Key | Stored At | Description |
|---|---|---|
| Offer | Quote time | Instrument, `accepts[]` entry as issued, requesting `resource`, `QuoteResponse` (incl. `correlationId`, `signature`) |
| Claim / result | Settle time | In-flight claim with expiry, or the recorded `SettlementResponse` |
| Refund | Terminal failure observed | Amount owed, beneficiary, forwarding transaction, state |
 
Offer and claim/result records MUST be retained for at least 24 hours after the quote deadline, so that a payment made in time remains redeemable after the offer has expired. Refund records are retained until forwarded or marked unresolved.
 
---
 
## Additional Considerations
 
### Replay Prevention
 
- `(network, txHash)` is bound to the first `operationToken` that redeems it and rejected under any other. Presenting the same token and hash again returns the committed result and does not execute the resource again.
- The instrument is bound by the backend to the merchant's destination and recipient, so a deposit cannot be redeemed at another merchant. The `operationToken` binds redemption to the party that received the offer, so a deposit cannot be redeemed by an observer of the origin network.

### Amount Validation
 
The client sends `amount` (`quote.amountIn`), which includes the backend's slippage buffer. Sufficiency is determined by the backend: a deposit of at least `quote.minAmountIn` is executed, and the unused part of the buffer is returned to the facilitator (see [Refunds](#refunds)); a deposit below `minAmountIn` is `INCOMPLETE_DEPOSIT`, MAY be completed by a further deposit, and is refunded by the backend at its deadline. The merchant receives exactly `amountOut` in every executed case.
 
### Timing
 
The client MUST deposit before `maxTimeoutSeconds` elapses. Expiry of the offer does not affect a payment already made: a proof for a deposit the backend executed remains redeemable while the facilitator retains the offer (at least 24 hours after the quote deadline). The backend documents the quote `deadline` as the point after which the deposit address becomes inactive and funds may be lost; a deposit arriving after it is not guaranteed to be refunded. `maxTimeoutSeconds` SHOULD be calibrated per origin network (minutes for EVM and Solana origins, substantially longer for Bitcoin).
 
### Client Obligations
 
- Persist the selected `accepts[]` entry before depositing and the `txHash` after. Loss of the `operationToken` leaves a delivered payment unredeemable.
- Present the same `operationToken` and `txHash` on every retry; MUST NOT fund a new offer while an operation is pending.
- Pay from an account you control, or present `payload.refundTo`.

### Deposit Address Authenticity
 
- The facilitator MUST only serve deposit addresses obtained from authenticated 1Click calls, and SHOULD verify and retain the quote `signature`.
- No interdiction point exists after a deposit lands. Merchant and resource screening is possible before the 402; payer screening is not, since the payer is unknown until the deposit exists.
- Clients paying first bear the risk of a malicious resource server, as with any payment gateway.
---
 
## Error Codes
 
Not-yet-final settlements use the core `settlement_pending` error reason (section 9 of core specifications). Scheme-specific codes:
 
| Code | Description |
|---|---|
| `invalid_exact_near_intents_offer_unknown` | `operationToken` was not issued by this facilitator. |
| `invalid_exact_near_intents_offer_mismatch` | Submitted requirements or resource differ from the stored offer. |
| `invalid_exact_near_intents_proof_bound` | `txHash` is already bound to a different operation. |
| `invalid_exact_near_intents_deposit_not_found` | `txHash` is confirmed but does not pay the instrument, or remains unknown to the origin network after the observation window. |
| `exact_near_intents_insufficient_deposit` | `REFUNDED` with `refundReason` indicating a partial deposit; refund owed. |
| `exact_near_intents_payment_failed` | No delivery; refund owed. |
 
---
 
## References
- [`scheme_exact.md`](./scheme_exact.md)
- [x402 specification v2](../../x402-specification-v2.md)
- [`extension-crosschain-swap.md`](../../extensions/extension-crosschain-swap.md)
- [1Click API Reference](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote)
- [1Click Swap Types](https://docs.near-intents.org/integration/distribution-channels/1click-api/swap-types)
- [NEAR Intents Supported Chains](https://docs.near-intents.org/resources/chain-support)
## Appendix
 
### 1Click API Endpoint Mapping
 
| x402 Operation | 1Click API Endpoint | When Called |
|---|---|---|
| Quote operation | `POST /v0/quote` (`dry: false`) | Once per origin per 402 |
| Indicative pricing (discovery extension) | `POST /v0/quote` (`dry: true`) | Cached across requests |
| Asset mapping | `GET /v0/tokens` | Resolve (`network`, `asset`) to a 1Click `assetId` |
| Deposit notification | `POST /v0/deposit/submit` | `/settle`, optional |
| Status polling | `GET /v0/status` | `/settle`, and instrument monitoring until a terminal status |
 
### Trust Model
 
| Relationship | Trust Required | Comparable To |
|---|---|---|
| Client → deposit address | The backend delivers to the merchant or returns the funds to the facilitator's refund account | Paying a payment processor |
| Client → facilitator | The facilitator forwards returned funds to the beneficiary | Refund handling by a payment processor |
| Resource server → Facilitator | Standard x402 trust model | Other `exact` methods |
 
Settlement is not trustless. Between deposit and delivery the funds are held by the settlement backend, which enforces the deposit-address-to-recipient binding.
 
### Multi-Origin-Chain Support
 
One `accepts[]` entry per offered origin, each its own offer with its own instrument and `operationToken`. Standard client selection by `network` applies. The [`crosschain-swap`](../../extensions/extension-crosschain-swap.md) extension MAY list further origins with indicative prices; only `accepts[]` entries are payable.
 
```jsonc
"accepts": [
  { "scheme": "exact", "network": "eip155:8453",  "asset": "0x8335…", "amount": "1000000", "payTo": "0xMerchantOnBase", "maxTimeoutSeconds": 60,  "extra": { "assetTransferMethod": "eip3009" } },
  { "scheme": "exact", "network": "eip155:42161", "asset": "0xaf88…", "amount": "1005000", "payTo": "0x76b4…", "maxTimeoutSeconds": 280, "extra": { "assetTransferMethod": "near-intents", "paymentFlow": "upfront", "operationToken": "b3f1…" } },
  { "scheme": "exact", "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "asset": "EPjF…", "amount": "1006000", "payTo": "9xQe…", "maxTimeoutSeconds": 280, "extra": { "assetTransferMethod": "near-intents", "paymentFlow": "upfront", "operationToken": "7c2e…" } }
]
```
 
Each 402 mints one quote per offered origin. In practice a merchant offers a limited, curated set of origins.
 