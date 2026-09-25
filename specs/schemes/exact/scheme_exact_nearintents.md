# `exact` Scheme for NEAR Intents

## Summary

The `exact` payment scheme for NEAR Intents uses the [NEAR Intents 1Click Swap API](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api) as the settlement backend. A client pays a source asset on any [supported origin network](https://docs.near-intents.org/resources/chain-support). The resource server (merchant) receives an exact amount of a destination asset on any supported destination network. The NEAR Intents solver network executes the cross-chain swap in between.

The asset transfer method is `near-intents`. It belongs to the **client-submitted (payment proof)** family defined in [`scheme_exact.md`](./scheme_exact.md) and satisfies its requirements. It MUST use the `upfront` payment flow (`extra.paymentFlow: "upfront"`). Unlike other methods, it is not tied to one network family: it applies to every origin and destination network 1Click supports.

---

## Protocol Flow

```
┌────────┐          ┌───────────────┐          ┌────────────────┐       ┌──────────────┐
│ Client │          │Resource Server│          │  Facilitator   │       │ 1Click Swap  │
│(Buyer) │          │  (Merchant)   │          │(x402 + 1Click) │       │     API      │
└───┬────┘          └──────┬────────┘          └───────┬────────┘       └──────┬───────┘
    │                      │                           │                       │
    │  1. GET /resource    │                           │                       │
    │─────────────────────>│                           │                       │
    │                      │                           │                       │
    │  2. 402 Payment      │                           │                       │
    │     Required         │                           │                       │
    │  PAYMENT-REQUIRED:   │                           │                       │
    │  unquoted entries,   │                           │                       │
    │  one per origin      │                           │                       │
    │<─────────────────────│                           │                       │
    │                      │                           │                       │
    │  3. GET /resource    │                           │                       │
    │  PAYMENT-SIGNATURE:  │                           │                       │
    │  {type: quote,       │                           │                       │
    │   refundTo}          │                           │                       │
    │─────────────────────>│                           │                       │
    │                      │                           │                       │
    │                      │  4. POST /verify          │                       │
    │                      │──────────────────────────>│                       │
    │                      │                           │  5. POST /v0/quote    │
    │                      │                           │     (dry: false)      │
    │                      │                           │──────────────────────>│
    │                      │                           │  depositAddress,      │
    │                      │                           │  amountIn             │
    │                      │                           │<──────────────────────│
    │                      │                           │                       │
    │                      │  VerifyResponse           │                       │
    │                      │  (quote, operationToken)  │                       │
    │                      │<──────────────────────────│                       │
    │                      │                           │                       │
    │  6. 402 Payment      │                           │                       │
    │     Required         │                           │                       │
    │  PAYMENT-REQUIRED:   │                           │                       │
    │  quoted entry        │                           │                       │
    │<─────────────────────│                           │                       │
    │                      │                           │                       │
    │  7. Client sends     │                           │                       │
    │     deposit TX on    │                           │                       │
    │     origin chain     │                           │                       │
    │     to payTo address │                           │                       │
    │  ════════════════════╪═══════════════════════════╪══(on-chain TX)════════│
    │                      │                           │                       │
    │  8. GET /resource    │                           │                       │
    │  PAYMENT-SIGNATURE:  │                           │                       │
    │  {type: deposit,     │                           │                       │
    │   operationToken,    │                           │                       │
    │   txHash}            │                           │                       │
    │─────────────────────>│                           │                       │
    │                      │                           │                       │
    │                      │  9. POST /settle          │                       │
    │                      │──────────────────────────>│                       │
    │                      │                           │ 10. POST              │
    │                      │                           │   /v0/deposit/submit  │
    │                      │                           │──────────────────────>│
    │                      │                           │      OK               │
    │                      │                           │<──────────────────────│
    │                      │                           │                       │
    │                      │                           │ 11. Poll GET          │
    │                      │                           │   /v0/status          │
    │                      │                           │──────────────────────>│
    │                      │                           │  SUCCESS, or refund   │
    │                      │                           │  to refundTo          │
    │                      │                           │<──────────────────────│
    │                      │                           │                       │
    │                      │  SettlementResponse       │                       │
    │                      │<──────────────────────────│                       │
    │                      │                           │                       │
    │                      │ 12. Execute route handler │                       │
    │                      │                           │                       │
    │  13. 200 OK          │                           │                       │
    │  + resource body     │                           │                       │
    │  + PAYMENT-RESPONSE  │                           │                       │
    │<─────────────────────│                           │                       │
```

### Step-by-step

1. **Client → Resource Server**: `GET /resource` without payment headers.
2. **Resource Server → Client**: `402 Payment Required` with one unquoted entry per origin in `PAYMENT-REQUIRED`. See [PaymentRequirements](#paymentrequirements-for-exact).
3. **Client → Resource Server**: retries with `PAYMENT-SIGNATURE` carrying a `quote` payload for the chosen entry.
4. **Resource Server → Facilitator `/verify`**: the facilitator mints the quote. See [Quote](#quote-verify).
5. **Facilitator → 1Click API**: one `POST /v0/quote` (`dry: false`, `swapType: EXACT_OUTPUT`). It yields a single-use `depositAddress`, `amountIn` and `minAmountIn`.
6. **Resource Server → Client**: a second `402` with the quoted entry in `PAYMENT-REQUIRED`. A `quote` payload never unlocks the resource.
7. **Client deposits**: a transfer of `amount` of `asset` to `payTo` on `network` (with `extra.depositMemo` where required), before `maxTimeoutSeconds` elapses.
8. **Client → Resource Server**: retries with `PAYMENT-SIGNATURE` carrying a `deposit` payload with `operationToken` and the deposit `txHash`.
9. **Resource Server → Facilitator `/settle`**: called before the route handler. See [Settlement](#settlement-settle).
10. **Facilitator → 1Click API**: `POST /v0/deposit/submit` to accelerate detection (optional).
11. **Facilitator polls `GET /v0/status`** until the merchant is paid (`SUCCESS`) or the payment has failed.
12. **Resource Server** executes the route handler only after a successful `SettlementResponse`, once per operation.
13. **Resource Server → Client**: `200 OK` with the resource and `PAYMENT-RESPONSE`.

---

## PaymentRequirements for `exact`

Each origin has an **unquoted** entry, in the first 402, and a **quoted** entry, in the second 402.

First `PaymentRequired`:

```jsonc
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
      "network": "eip155:42161",               // ORIGIN network: where the client pays
      "amount": "1005000",                     // indicative, not binding
      "asset": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // origin asset (USDC on Arbitrum)
      "payTo": "quote",                        // role constant: not quoted yet
      "maxTimeoutSeconds": 300,                // deposit window to request
      "extra": {
        "assetTransferMethod": "near-intents",
        "paymentFlow": "upfront",
        "destination": {
          "network": "eip155:8453",
          "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
          "amount": "1000000",                 // exact amount the merchant receives
          "recipient": "0xMerchantOnBase"
        }
      }
    }
    // ... one entry per offered origin
  ]
}
```

Second `PaymentRequired`: the same `resource`, and only the quoted entry:

```jsonc
{
  "scheme": "exact",
  "network": "eip155:42161",
  "amount": "1005000",                     // quote.amountIn: the amount to deposit
  "asset": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "payTo": "0x76b4c56085ED136a8744D52bE956396624a730E8", // 1Click deposit address
  "maxTimeoutSeconds": 280,                // time left to deposit
  "extra": {
    "assetTransferMethod": "near-intents",
    "paymentFlow": "upfront",
    "destination": { /* unchanged */ },
    "operationToken": "k1.1790244600.Da1hrEbt50TdIbfZb5EhYU9CnB120jf-cs0d189lrvQ"
  }
}
```

### Mapping to Standard x402 Fields

| x402 Field | Unquoted entry | Quoted entry |
|---|---|---|
| `scheme` | Always `"exact"`. | Always `"exact"`. |
| `network` | CAIP-2 of the **origin** network: where the client pays and where the proof is anchored. | Unchanged. |
| `amount` | Indicative amount, e.g., from a cached `dry: true` quote. Not binding. | `quote.amountIn`: the amount the client MUST deposit, in base units of `asset`. Includes the slippage buffer and fees. |
| `asset` | The origin asset, in the identifier used by that network's own x402 scheme. Otherwise it is the network's canonical identifier. | Unchanged. |
| `payTo` | The role constant `"quote"`: the entry cannot be paid yet. | `quote.depositAddress`: the single-use deposit address. With `network` and `depositMemo`, the payment instrument. |
| `maxTimeoutSeconds` | Deposit window the facilitator requests from 1Click. | Time left to deposit. See [Timing](#timing). |

### Extra Field Descriptions

| Field | Type | Required | Description |
|---|---|---|---|
| `assetTransferMethod` | string | Yes | Always `"near-intents"`. |
| `paymentFlow` | string | Yes | Always `"upfront"`. |
| `destination.network` | string | Yes | CAIP-2 of the network the merchant receives on. |
| `destination.asset` | string | Yes | Asset the merchant receives, in the identifier used by that network's own x402 scheme. |
| `destination.amount` | string | Yes | Exact amount the merchant receives, in base units. |
| `destination.recipient` | string | Yes | Merchant address on `destination.network`. |
| `operationToken` | string | Quoted entry | Issued by the facilitator. Authorizes redemption of this quote. See [Operation Token](#operation-token). |
| `depositMemo` | string | Conditional | Quoted entry only, when the origin network requires a memo or destination tag (e.g., Stellar, XRP, TON). Part of the instrument. |

Clients MUST skip `accepts[]` entries whose `assetTransferMethod` they do not implement, as the core specification requires for an unrecognized `paymentFlow` (section 6.1).

---

## PaymentPayload `payload` Field

The payload has two types, set in `payload.type`. Both payloads MUST carry `resource`.

### Quote payload

`accepted` is the unquoted entry.

```jsonc
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/premium-data" },
  "accepted": { /* unquoted entry */ },
  "payload": {
    "type": "quote",
    "refundTo": "0x2527D02599Ba641c19Fea793Cd0f9A6e8457c317",
    "slippageTolerance": 50                // optional, basis points
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `payload.type` | string | Yes | Always `"quote"`. |
| `payload.refundTo` | string | Yes | Client address on `accepted.network`. It receives every refund and the unused slippage buffer. MUST be valid on that network. |
| `payload.slippageTolerance` | number | No | In basis points. See [Slippage](#slippage). |

### Deposit payload

`accepted` is the quoted entry.

```jsonc
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/premium-data" },
  "accepted": { /* quoted entry */ },
  "payload": {
    "type": "deposit",
    "operationToken": "k1.1790244600.Da1hrEbt50TdIbfZb5EhYU9CnB120jf-cs0d189lrvQ",
    "txHash": "0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `payload.type` | string | Yes | Always `"deposit"`. |
| `payload.operationToken` | string | Yes | The token from the quoted entry. Proves the presenter received this quote. |
| `payload.txHash` | string | Yes | The client's deposit transaction on `accepted.network`. The payment proof. |

The proof is observation-dependent: validation requires observing the origin network or the backend.

---

## Resource Server Behavior

- Reject a payload whose `resource.url` is not the resource advertised for this request.
- Call `/verify` and `/settle` with `paymentRequirements` set to the server's own unquoted entry for `accepted.network` and `accepted.asset`, never with `accepted`. Destination terms MUST come from the server's own configuration.
- On a `quote` payload, call `/verify`. On `isValid: true`, return a second 402 with the quoted entry built from `VerifyResponse.extra`: `depositAddress` becomes `payTo`, `amountIn` becomes `amount`, `refundDeadline` sets `maxTimeoutSeconds` (see [Timing](#timing)), and `operationToken` (plus `depositMemo` where present) goes into `extra`. Do not execute the route handler.
- On a `deposit` payload, call `/settle` before the route handler. Execute the handler only after `success: true`, once per operation. On `settlement_pending`, return the pending receipt.

---

## Facilitator Behavior

### Quote (`/verify`)

`/verify` with a `quote` payload mints a quote. It commits no funds.

1. **Structural**: `accepted.extra.assetTransferMethod` is `near-intents`; `payload.type` is `quote`; `resource.url` is present; `payload.refundTo` is a valid address on `accepted.network`; `accepted.network` and `accepted.asset` equal those of `paymentRequirements`.
2. **Rate limit**: facilitators MUST rate-limit quote payloads per requester. A facilitator MAY return the same live quote for an identical (`resource`, `accepted`, `refundTo`) within its validity, instead of minting again.
3. **Quote**: `POST {apiBaseUrl}/v0/quote`, with origin and destination mapped to 1Click identifiers via `GET /v0/tokens`:
   - `dry: false`, `swapType: EXACT_OUTPUT`, `depositType: ORIGIN_CHAIN`, `depositMode: MEMO` for origin networks that require a memo (otherwise `SIMPLE`).
   - `amount` = `destination.amount`, `recipient` = `destination.recipient`, `recipientType: DESTINATION_CHAIN`.
   - `refundTo` = `payload.refundTo`, `refundType: ORIGIN_CHAIN`.
   - `slippageTolerance` per [Slippage](#slippage). `appFees` and `referral` per [Fees](#fees).
   - `deadline` = now + `paymentRequirements.maxTimeoutSeconds`. This is the refund deadline.

   Destination terms come from `paymentRequirements`. Only `refundTo` and `slippageTolerance` come from the payload.
4. **Respond**: the quote and a new `operationToken`, in `extra`:

```jsonc
{
  "isValid": true,
  "extra": {
    "depositAddress": "0x76b4c56085ED136a8744D52bE956396624a730E8",
    "amountIn": "1005000",
    "refundDeadline": "2026-09-23T10:10:00Z",   // the deadline sent in the quote request
    "operationToken": "k1.1790244600.Da1hrEbt50TdIbfZb5EhYU9CnB120jf-cs0d189lrvQ"
    // + depositMemo where the origin network requires one
  }
}
```

If 1Click returns no quote, the facilitator returns `isValid: false` with `invalid_exact_near_intents_quote_unavailable`.

### Operation Token

`operationToken` is `<keyId>.<expiry>.<mac>`:

| Part | Description |
|---|---|
| `keyId` | Identifies the facilitator key. |
| `expiry` | Unix time in seconds: the refund deadline plus a grace window of at least 24 hours. |
| `mac` | Unpadded base64url of `HMAC-SHA256(key, network:depositAddress[:depositMemo]:resource:destinationHash:expiry)`. |

- `network`, `depositAddress` and `depositMemo` are the quoted entry's `network`, `payTo` and `extra.depositMemo`. `resource` is `resource.url`.
- `destinationHash` is the lowercase hex SHA-256 of `network:asset:amount:recipient`, taken from `paymentRequirements.extra.destination`.
- The token needs no storage: the facilitator recomputes `mac` at settlement.
- A facilitator MUST keep a key while any token issued with it is unexpired.
- The token is opaque to clients and resource servers. It is transmitted only in the quoted entry and the deposit payload. It MUST NOT appear on chain or in receipts.

### Settlement (`/settle`)

The rules below run inside `/settle`, before the resource executes. An operation is identified by its `operationToken`.

1. **Structural**: `accepted.extra.assetTransferMethod` is `near-intents`; `payload.type` is `deposit`; `resource.url` is present; `payload.operationToken` equals `accepted.extra.operationToken`; `payload.txHash` is well-formed for `accepted.network`; `accepted.network` and `accepted.asset` equal those of `paymentRequirements`.
2. **Token**: a token past its `expiry` is rejected with `invalid_exact_near_intents_token_expired`, without any lookup. Otherwise the facilitator recomputes `mac` from `accepted`, `resource.url` and `paymentRequirements.extra.destination`. A mismatch or an unknown `keyId` is rejected with `invalid_exact_near_intents_token_invalid`.
3. **Quote terms**: read `GET /v0/status?depositAddress=<payTo>[&depositMemo=<memo>]`. The `recipient`, destination asset and `amount` of `quoteResponse.quoteRequest` MUST match `paymentRequirements.extra.destination`, mapped as at quote time; otherwise `invalid_exact_near_intents_quote_mismatch`.
4. **Claim**: claim `<network>:<txHash>` as in-flight for this operation. Concurrent presentations of the same proof MUST result in exactly one claim; the others receive `settlement_pending`. A proof already consumed by this operation returns the recorded `SettlementResponse`. A proof consumed by a different operation is rejected with `invalid_exact_near_intents_proof_bound`. A claim MUST expire, and a worker whose claim has expired MUST NOT consume.
5. **Deposit**: `txHash` is a confirmed transaction on `accepted.network` that transfers `accepted.asset` to `accepted.payTo` (with `depositMemo` where required). A transaction confirmed on the origin network that does not pay the instrument MUST be rejected with `invalid_exact_near_intents_deposit_not_found`. A transaction not yet observable is not final: release the claim and return `settlement_pending`. A facilitator MAY reject a transaction still unknown to the origin network after a documented observation window.
6. **Outcome**: notify the backend (`POST /v0/deposit/submit`), then poll `GET /v0/status`. The response carries `status` and `swapDetails`.
   - Statuses `KNOWN_DEPOSIT_TX`, `PENDING_DEPOSIT`, `PROCESSING` and `INCOMPLETE_DEPOSIT` are non-terminal.
   - `SUCCESS`, `REFUNDED` and `FAILED` are terminal.
   - The proof is **valid** only when status is `SUCCESS` and `txHash` is among `swapDetails.originChainTxHashes[].hash`: the merchant received the destination asset. A surplus refund after `SUCCESS` does not affect validity.
   - `REFUNDED` and `FAILED` are failures (see [Refunds](#refunds)).
7. **Consume and respond**: consume the proof, record the `SettlementResponse` against the operation, and return it. On a terminal failure, consume the proof, and record and return the failure. An operation serves at most one proof. The recorded response is returned unchanged to any later presentation of the same operation.

**Not yet final:** If no terminal outcome is observable within the facilitator's settlement window, it MUST NOT consume the proof, MUST release the in-flight claim, and MUST return `success: false` with `errorReason: "settlement_pending"`, `transaction` = the deposit `txHash` and `network` = `accepted.network`, per section 9 of the core specification. The client MUST retry with the same `operationToken` and `txHash`, and MUST NOT fund a new quote while this operation is pending. An abnormally terminated attempt MUST NOT leave a proof claimed.

**Finality** is delivery to the merchant. A facilitator MUST NOT advance settlement on its own origin-network observation.

**On success** — `network` and `transaction` identify the delivery to the merchant on the destination network:
```jsonc
{
  "success": true,
  "network": "eip155:8453",
  "transaction": "<destination-network delivery tx hash>",
  "payer": "<account debited on the origin network>",
  "amount": "1000000",                     // destination.amount
  "extra": {
    "originNetwork": "eip155:42161",
    "originTxHash": "<payload.txHash>"
  }
}
```

**On failure** — nothing was delivered. 1Click refunds `refundTo` directly:
```jsonc
{
  "success": false,
  "errorReason": "exact_near_intents_payment_failed",
  "network": "eip155:42161",
  "transaction": "",
  "extra": {
    "status": "REFUNDED",
    "refundTo": "0x2527D02599Ba641c19Fea793Cd0f9A6e8457c317"
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
  "extra": { "status": "PROCESSING" }
}
```

Returned in `PAYMENT-RESPONSE`. Under `upfront` the receipt is returned even when the route handler fails, per the core specification. Receipts MUST NOT include the `operationToken`.

### Refunds

1Click returns funds directly to the client's `refundTo` on the origin network (`refundType: ORIGIN_CHAIN`). No facilitator holds client funds or forwards refunds.

- A failed swap (`REFUNDED` or `FAILED`) returns the deposit, net of 1Click's `refundFee`.
- A deposit after the refund deadline is refunded, not swapped.
- Any value the swap does not consume returns to `refundTo`, including the unused slippage buffer. See [Amount Validation](#amount-validation).

### Retention

The facilitator keeps only used-proof records, keyed by `<network>:<txHash>`: the operation's token, and the in-flight claim or the recorded `SettlementResponse`. Each record is retained until its token's `expiry`. After that the token is rejected before any lookup, so a dropped record cannot be replayed.

---

## Additional Considerations

### Replay Prevention

- `(network, txHash)` is bound to the first `operationToken` that redeems it and rejected under any other. Presenting the same token and hash again returns the recorded result and does not execute the resource again.
- The token binds the instrument, the resource, the destination terms and an expiry. A deposit cannot be redeemed at another resource or merchant, or after `expiry`.
- The token binds redemption to the party that received the quote. An observer of the origin network cannot redeem a deposit.

### Amount Validation

The client sends `amount` (`quote.amountIn`), which includes the slippage buffer and fees. Sufficiency is determined by the backend: a deposit of at least `quote.minAmountIn` is executed, and the unused part of the buffer returns to `refundTo`. A deposit below `minAmountIn` is `INCOMPLETE_DEPOSIT`: it MAY be completed by a further deposit, and is otherwise refunded at the refund deadline. The merchant receives exactly `destination.amount` in every executed case.

### Slippage

Slippage is the client's choice. With `EXACT_OUTPUT` the merchant always receives `destination.amount`, and the unused buffer returns to `refundTo`. The tolerance only trades how much the client sends up front against the chance of a failed swap.

The facilitator publishes its permitted range and default in `/supported`, as `kinds[].extra.slippageTolerance` (`min`, `max` and `default`, in basis points). It clamps the client's `slippageTolerance` into the range, and applies the default when the value is omitted.

### Fees

`appFees` and `referral` are 1Click quote parameters. The facilitator sets them from its own configuration at quote time. 1Click takes `appFees` from the input, so they are included in `amountIn` and visible to the client in the quoted `amount`.

### Timing

- The refund deadline is the `deadline` the facilitator sends in the quote request. 1Click refunds a deposit it has not swapped by then.
- The quoted `maxTimeoutSeconds` is the refund deadline minus now, minus a margin that covers deposit confirmation on the origin network. The client MUST deposit before it elapses.
- The `deadline` in 1Click's quote response is a later time, when the deposit address becomes inactive and funds may be lost. It MUST NOT be used for `maxTimeoutSeconds`.
- `maxTimeoutSeconds` SHOULD be calibrated per origin network (minutes for EVM and Solana origins, substantially longer for Bitcoin).
- A proof for an executed deposit remains redeemable until the token's `expiry`, at least 24 hours after the refund deadline.

### Client Obligations

- Check the quoted `amount` before depositing. The unquoted `amount` is indicative only.
- Persist the quoted entry before depositing and the `txHash` after. Loss of the `operationToken` leaves a delivered payment unredeemable.
- Present the same `operationToken` and `txHash` on every retry. MUST NOT fund a new quote while an operation is pending.
- Use a `refundTo` you control on the origin network.

### Deposit Address Authenticity

- The facilitator MUST only serve deposit addresses obtained from authenticated 1Click calls, and SHOULD verify the quote `signature`.
- No interdiction point exists after a deposit lands. Merchant and resource screening is possible before the quote. Payer screening is not, since the payer is unknown until the deposit exists.
- Clients paying first bear the risk of a malicious resource server, as with any payment gateway.

---

## Error Codes

Not-yet-final settlements use the core `settlement_pending` error reason (section 9 of the core specification). Scheme-specific codes:

| Code | Description |
|---|---|
| `invalid_exact_near_intents_quote_unavailable` | 1Click returned no quote for the requested entry. |
| `invalid_exact_near_intents_token_invalid` | `operationToken` does not verify against `accepted`, `resource` and the server's destination terms, or its `keyId` is unknown. |
| `invalid_exact_near_intents_token_expired` | `operationToken` is past its `expiry`. |
| `invalid_exact_near_intents_quote_mismatch` | 1Click's `quoteRequest` does not match the server's destination terms. |
| `invalid_exact_near_intents_proof_bound` | `txHash` is already bound to a different operation. |
| `invalid_exact_near_intents_deposit_not_found` | `txHash` is confirmed but does not pay the instrument, or remains unknown to the origin network after the observation window. |
| `exact_near_intents_insufficient_deposit` | `REFUNDED` with `refundReason` indicating a partial deposit. 1Click refunds `refundTo`. |
| `exact_near_intents_payment_failed` | No delivery. 1Click refunds `refundTo`. |

---

## References
- [`scheme_exact.md`](./scheme_exact.md)
- [x402 specification v2](../../x402-specification-v2.md)
- [1Click API Reference](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote)
- [1Click Swap Types](https://docs.near-intents.org/integration/distribution-channels/1click-api/swap-types)
- [NEAR Intents Supported Chains](https://docs.near-intents.org/resources/chain-support)

## Appendix

### 1Click API Endpoint Mapping

| x402 Operation | 1Click API Endpoint | When Called |
|---|---|---|
| Indicative amount | `POST /v0/quote` (`dry: true`) | Cached across requests |
| Quote (`/verify`) | `POST /v0/quote` (`dry: false`) | Once per `quote` payload |
| Asset mapping | `GET /v0/tokens` | Resolve (`network`, `asset`) to a 1Click `assetId` |
| Deposit notification | `POST /v0/deposit/submit` | `/settle`, optional |
| Status | `GET /v0/status` | `/settle` |

### Trust Model

| Relationship | Trust Required | Comparable To |
|---|---|---|
| Client → deposit address | The backend delivers to the merchant or refunds the client's `refundTo` | Paying a payment processor |
| Resource server → Facilitator | Standard x402 trust model | Other `exact` methods |

Settlement is not trustless. Between deposit and delivery the funds are held by the settlement backend, which enforces the deposit-address-to-recipient binding.
