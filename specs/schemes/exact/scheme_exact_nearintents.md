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
    │                      │  2. Request quote         │                      │
    │                      │──────────────────────────>│                      │
    │                      │                           │  3. POST /v0/quote   │
    │                      │                           │     (dry: false)     │
    │                      │                           │─────────────────────>│
    │                      │                           │  depositAddress,     │
    │                      │                           │  amount, deadline    │
    │                      │                           │<─────────────────────│
    │                      │  PaymentRequirements      │                      │
    │                      │  (payTo=depositAddress)   │                      │
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
    │  {payload: txHash}   │                           │                      │
    │─────────────────────>│                           │                      │
    │                      │                           │                      │
    │                      │  7. POST /settle          │                      │
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
    │                      │                           │  to sender           │
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
2. **Resource Server → Facilitator**: the middleware requests `PaymentRequirements` for each origin network the merchant offers.
3. **Facilitator → 1Click API**: `POST /v0/quote` with `dry: false` and `swapType: EXACT_OUTPUT`, or a cached, unexpired, unfunded quote for that (resource, origin). The quote yields a single-use `depositAddress`, the required input amount, and a `deadline`. See [Quote Generation](#quote-generation-402-construction-time).
4. **Resource Server → Client**: `402 Payment Required`. Each entry has `network` = origin network and `payTo` = the deposit address.
5. **Client sends deposit**: a native transfer of `amount` of `asset` to `payTo` on `network` (with `extra.depositMemo` where required), before `maxTimeoutSeconds` elapses.
6. **Client → Resource Server**: retries with `PAYMENT-SIGNATURE` carrying the deposit `txHash`.
7. **Resource Server → Facilitator `/settle`**: called directly and before the route handler; verification runs inside settle. See [Settlement](#settlement-post-settle).
8. **Facilitator → 1Click API**: `POST /v0/deposit/submit` to accelerate detection (optional).
9. **Facilitator polls `GET /v0/status`** until a terminal outcome: `SUCCESS` (destination asset delivered to the merchant), or a refund (payment failed; funds returned to the deposit sender).
10. **Resource Server** executes the route handler only after a successful `SettlementResponse`.
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
  "maxTimeoutSeconds": 280,                // remaining validity of the deposit address
  "extra": {
    "assetTransferMethod": "near-intents",
    "paymentFlow": "upfront"
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
        "paymentFlow": "upfront"
      }
    }
  ]
}
```

The destination leg (merchant network, asset, recipient, and amount) is fixed in the quote, enforced by the settlement backend, recoverable by any facilitator from the backend by deposit address, and reported in the receipt.

### Mapping to Standard x402 Fields

| x402 Field | 1Click Source | Semantics in This Scheme |
|---|---|---|
| `scheme` | — | Always `"exact"`. |
| `network` | Request `originAsset` chain | CAIP-2 of the **origin** network: where the client pays and where the proof is anchored. |
| `amount` | `quote.maxAmountIn` | The deposit amount the client MUST send, in base units of `asset`. |
| `asset` | Request `originAsset` | The origin asset, in the identifier used by that network's own x402 scheme. Otherwise it is the network's canonical identifier. |
| `payTo` | `quote.depositAddress` | The single-use deposit address. The payment instrument. |
| `maxTimeoutSeconds` | `deadline` − now | Remaining validity of the deposit address at issuance. |

### Extra Field Descriptions

| Field | Type | Required | Description |
|---|---|---|---|
| `assetTransferMethod` | string | Yes | Always `"near-intents"`. |
| `paymentFlow` | string | Yes | Always `"upfront"`. |
| `depositMemo` | string | Conditional | Present only when the origin network requires a memo or destination tag (e.g., Stellar, XRP, TON). Part of the instrument. |

---

## PaymentPayload `payload` Field

```jsonc
  "payload": {
    "txHash": "0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a"
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
      "paymentFlow": "upfront"
    }
  },
  "payload": {
    "txHash": "0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a"
  }
}
```

### Field Descriptions

| Field | Type | Required | Description |
|---|---|---|---|
| `payload.txHash` | string | Yes | The client's deposit transaction on `accepted.network`. The payment proof. |

The deposit address is `accepted.payTo` and is not repeated. The proof is observation-dependent, validation requires observing origin-network.

---

## Facilitator Behavior

### Quote Generation (402 Construction Time)

The facilitator obtains deposit addresses from the 1Click API.

1. Call `POST {apiBaseUrl}/v0/quote`:
   ```jsonc
   {
     "dry": false,
     "originAsset": "<offered origin asset>",
     "destinationAsset": "<merchant's destination asset>",
     "amount": "<merchant's required output>",
     "swapType": "EXACT_OUTPUT",
     "slippageTolerance": 100,
     "depositType": "ORIGIN_CHAIN",
     "recipientType": "DESTINATION_CHAIN",
     "recipient": "<merchant wallet>",
     "refundTo": "<facilitator refund account on NEAR Intents>",
     "refundType": "INTENTS",
     "deadline": "<now + configured TTL>",
     "referral": "<x402-near-intents>",
     "appFees": [...]
   }
   ```
2. Build the `accepts[]` entry: `network` = origin, `payTo` = `quote.depositAddress`, `amount` = `quote.maxAmountIn`, `maxTimeoutSeconds` = remaining validity.

The facilitator resolves (`network`, `asset`) to the 1Click `assetId` via `GET /v0/tokens` endpoint.

**Reuse and rotation.** A facilitator MAY serve one quote per (resource, origin) in every 402 until it expires or is funded. Quote cost then scales with offered origins and payments, not with unpaid requests. A facilitator serving a shared quote MUST rotate it on **first deposit detection**, any deposit observed on the address, confirmed or not, so later 402s carry a fresh address. A facilitator MAY instead issue a unique quote per 402, which is collision-free at one quote per 402 per offered origin. `maxTimeoutSeconds` MUST be recomputed at each issuance.

### Settlement (`POST /settle`)

The checks below run inside `/settle`, before the resource executes.

1. **Structural**: `accepted.extra.assetTransferMethod` is `near-intents`; `payload.txHash` is well-formed for `accepted.network`.
2. **Instrument**: `accepted.payTo` is a deposit address this facilitator issued, and its deadline has not passed.
3. **Claim**: claim `<network>:<txHash>` as in-flight. Concurrent presentations of the same proof MUST result in exactly one claim.
4. **Deposit**: `txHash` is confirmed on `accepted.network` and transfers at least `accepted.amount` of `accepted.asset` to `accepted.payTo` (with `depositMemo` where required). Confirm via `GET /v0/status` for the deposit address or via the origin network.
5. **Outcome**: notify the backend (`POST /v0/deposit/submit`), then poll `GET /v0/status?depositAddress=<addr>[&depositMemo=<memo>]`. The proof is **valid** only when status is `SUCCESS` and `txHash` is among the deposits attributed to the quote: the merchant received the destination asset. Any refund is a failure (see [Refunds](#refunds)).
6. **Consume and respond**: consume the proof and return the `SettlementResponse`. On a refund or other terminal failure, consume the proof and return failure. A quote serves at most one proof.

**Not yet final:** If no terminal outcome is observable within the facilitator's settlement window, it MUST NOT consume the proof, MUST release the in-flight claim, and MUST return `exact_near_intents_not_final`. The client MAY retry with the same proof while the deadline holds. An abnormally terminated attempt MUST NOT leave a proof claimed.

**Finality** is delivery to the merchant. A facilitator MUST NOT advance settlement on its own origin-network observation.

**On success:**
```jsonc
{
  "success": true,
  "network": "eip155:42161",
  "transaction": "<destination-network tx hash>",
  "payer": "<deposit sender>",
  "extensions": {
    "depositAddress": "<accepted.payTo>",
    "originTxHash": "<payload.txHash>"
  }
}
```

**On failure:**
```jsonc
{
  "success": false,
  "network": "eip155:42161",
  "error": "<error_code>",
  "extensions": {
    "depositAddress": "<accepted.payTo>",
    "status": "<1Click status>",
    "refundTxHash": "<forwarding tx to the sender, where known>"
  }
}
```

Returned in `PAYMENT-RESPONSE`. Under `upfront` the receipt is returned even when the route handler fails, per the core specification.

### Facilitator State

Keyed by `depositAddress`:

| Key | Stored At | Description |
|---|---|---|
| `depositAddress`, `depositMemo` | Quote time | The instrument |
| `QuoteResponse`, `deadline` | Quote time | Quote and expiry |
| `accepts[]` entry | Quote time | As served |
| rotation flag | First deposit detected | Whether the quote is still served |
| in-flight / consumed keys | Settle time | `<network>:<txHash>` lifecycle |
| refund forwarding | Refund observed | Sender account and forwarding transaction |

Retained until `deadline` plus the settlement window.

---

## Additional Considerations

### Replay Prevention

- Consumption key: `<CAIP-2>:<txHash>`. A consumed key MUST be rejected across all resources served by the facilitator.
- The instrument is bound by the backend to the merchant's destination and recipient, so a proof cannot be redeemed at another merchant. Where a quote is shared across 402s, the instrument is unique to the (resource, origin, quote window), not to a single request. Per-request replay is prevented by the consumption key.
- Retention is bounded: the instrument expires at the quote deadline.

### Deposit Address Validity Window

- The client MUST deposit before `maxTimeoutSeconds` elapses. A deposit after the quote deadline is refunded to the sender.
- `maxTimeoutSeconds` SHOULD be calibrated per origin network (minutes for EVM and Solana origins, substantially longer for Bitcoin).

### Amount Validation

Acceptance follows `exact`: the client sends `amount`. A deposit below `amount` is refunded to the sender and the proof is invalid. A deposit above `amount` is swap input, the excess is refunded to the sender.

### Refunds

A refund is always a failed payment: the client is not served and is made whole.

- At quote time the facilitator sets `refundTo` to a facilitator-controlled account on NEAR Intents (`refundType: INTENTS`), so refunds from every origin network are collected in one place. Merchants configure nothing on origin networks.
- On any refund (swap failure, insufficient or late deposit, excess, or a second deposit to a shared address) the facilitator MUST forward the refunded amount to the origin-network account that funded the deposit: the transaction sender on account-based networks, the first input address on UTXO networks. The sender is established by the chain, not by the presenter of the proof.
- Forwarding does not require the client to present the proof. The facilitator holds refunds only transiently; unforwarded amounts are held per facilitator policy.
- Clients MUST pay from an account they control. A deposit sent from a custodial or exchange wallet is refunded to that wallet and MUST be recovered through it.

### Concurrent Deposits

Because the deposit address does not depend on the client, two clients may fund a shared address. One deposit becomes swap input and that client is served; the other is refunded to its sender and that client is not served. Where the backend aggregates both deposits into one swap, the facilitator serves the first proof claimed and forwards the other deposit's amount to its sender. Facilitators MUST rotate on first deposit detection to keep this rare.

### Deposit Address Authenticity

- The facilitator MUST only serve deposit addresses obtained from authenticated 1Click calls.
- No interdiction point exists after a deposit lands, any screening MUST occur before the 402 is issued.
- Clients paying first bear the risk of a malicious resource server, as with any payment gateway.

---

## Error Codes

| Code | Description |
|---|---|
| `invalid_exact_near_intents_instrument` | `payTo` is not a deposit address issued by this facilitator, or its deadline passed. |
| `invalid_exact_near_intents_deposit_not_found` | `txHash` not observed as a deposit to `payTo`. |
| `invalid_exact_near_intents_insufficient_deposit` | Deposit below `amount`; refunded to the sender. |
| `invalid_exact_near_intents_proof_reused` | Consumption key already in-flight or consumed. |
| `exact_near_intents_not_final` | No terminal outcome yet; retry with the same proof. |
| `exact_near_intents_settlement_failed` | Swap did not complete; deposit refunded to the sender. |

---

## References
- [`scheme_exact.md`](./scheme_exact.md)
- [x402 specification v2](../../x402-specification-v2.md)
- [`extension-crosschain-swap.md`](../../extensions/extension-crosschain-swap.md)
- [1Click API Reference](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api)
- [NEAR Intents Supported Chains](https://docs.near-intents.org/resources/chain-support)

## Appendix

### 1Click API Endpoint Mapping

| x402 Operation | 1Click API Endpoint | When Called |
|---|---|---|
| Construct PaymentRequirements | `POST /v0/quote` (`dry: false`) | 402 construction, or cached |
| Indicative pricing (discovery extension) | `POST /v0/quote` (`dry: true`) | Cached across requests |
| Token/asset discovery | `GET /v0/tokens` | Configuration |
| Deposit notification | `POST /v0/deposit/submit` | `/settle` |
| Status polling | `GET /v0/status` | `/settle`, until terminal |

### Trust Model

| Relationship | Trust Required | Comparable To |
|---|---|---|
| Client → deposit address | The backend delivers to the merchant or refunds to the facilitator, which forwards to the sender | Paying a payment processor |
| Resource server → Facilitator | Standard x402 trust model | Other `exact` methods |

Settlement is not trustless: between deposit and delivery the funds are custodied by the settlement backend, which enforces the deposit-address-to-recipient binding, and refunds are held transiently by the facilitator before forwarding. Clients and agent policies can identify this from `assetTransferMethod`.

### Multi-Origin-Chain Support

One `accepts[]` entry per offered origin, each on its own `network` with its own deposit address. Standard client selection by `network` applies. The [`crosschain-swap`](../../extensions/extension-crosschain-swap.md) extension MAY list further origins with indicative prices; only `accepts[]` entries are payable.

```jsonc
"accepts": [
  { "scheme": "exact", "network": "eip155:8453",  "asset": "0x8335…", "amount": "1000000", "payTo": "0xMerchantOnBase", "maxTimeoutSeconds": 60,  "extra": { "assetTransferMethod": "eip3009" } },
  { "scheme": "exact", "network": "eip155:42161", "asset": "0xaf88…", "amount": "1005000", "payTo": "0x76b4…",          "maxTimeoutSeconds": 280, "extra": { "assetTransferMethod": "near-intents", "paymentFlow": "upfront" } },
  { "scheme": "exact", "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "asset": "EPjF…", "amount": "1006000", "payTo": "9xQe…", "maxTimeoutSeconds": 280, "extra": { "assetTransferMethod": "near-intents", "paymentFlow": "upfront" } }
]
```

In practice a merchant offers a limited, curated set of origins.
