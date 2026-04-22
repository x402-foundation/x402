# `exact` Scheme for NEAR Intents

## Summary

The `exact` payment scheme for Near Intents uses the [NEAR Intents 1Click Swap API](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api) as the settlement backend. This scheme facilitates cross-chain payments where a client pays a specified amount of a source asset on any [supported origin chain](https://docs.near-intents.org/resources/chain-support), and the resource server (merchant) receives an exact amount of a destination asset on any supported destination chain, with the NEAR Intents solver network executing the cross-chain swap in between.

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
    │                      │                           │  quote response with │
    │                      │                           │  depositAddress,     │
    │                      │                           │ maxAmountIn...       │
    │                      │                           │<─────────────────────│
    │                      │  PaymentRequirements      │                      │
    │                      │  (payTo=depositAddress)   │                      │
    │                      │<──────────────────────────│                      │
    │                      │                           │                      │
    │  4. 402 Payment      │                           │                      │
    │     Required         │                           │                      │
    │  (payTo = deposit    │                           │                      │
    │   address, extra =   │                           │                      │
    │   quote metadata)    │                           │                      │
    │<─────────────────────│                           │                      │
    │                      │                           │                      │
    │                      │                           │                      │
    │  5. Client sends     │                           │                      │
    │     deposit TX on    │                           │                      │
    │     origin chain     │                           │                      │
    │     to payTo address │                           │                      │
    │  ════════════════════╪═══════════════════════════╪══(on-chain TX)═══════│
    │                      │                           │                      │
    │  6. GET /resource    │                           │                      │
    │  X-PAYMENT: {payload │                           │                      │
    │   with txHash}       │                           │                      │
    │─────────────────────>│                           │                      │
    │                      │                           │                      │
    │                      │  7. POST /verify          │                      │
    │                      │──────────────────────────>│                      │
    │                      │                           │ Validate txHash,     │
    │                      │                           │ check depositAddress │
    │                      │                           │ matches, optionally  │
    │                      │                           │ verify on-chain      │
    │                      │  VerifyResponse (valid)   │                      │
    │                      │<──────────────────────────│                      │
    │                      │                           │                      │
    │                      │  8. POST /settle          │                      │
    │                      │──────────────────────────>│                      │
    │                      │                           │ 9. POST             │
    │                      │                           │   /v0/deposit/submit │
    │                      │                           │─────────────────────>│
    │                      │                           │      OK              │
    │                      │                           │<─────────────────────│
    │                      │                           │                      │
    │                      │                           │ 10. Poll GET         │
    │                      │                           │   /v0/status         │
    │                      │                           │─────────────────────>│
    │                      │                           │  status: SUCCESS     │
    │                      │                           │<─────────────────────│
    │                      │                           │                      │
    │                      │  SettlementResponse       │                      │
    │                      │  (success,                │                      │
    │                      │ destinationChainTxHashes) │                      │
    │                      │<──────────────────────────│                      │
    │                      │                           │                      │
    │  11. 200 OK          │                           │                      │
    │  + resource body     │                           │                      │
    │  + X-PAYMENT-RESPONSE│                           │                      │
    │<─────────────────────│                           │                      │
```

### Step-by-step

1. **Client → Resource Server**: Client makes an HTTP request (e.g., `GET /resource`) without payment headers.

2. **Resource Server → Facilitator**: The resource server's x402 middleware invokes the facilitator to construct `PaymentRequirements`. The facilitator calls the 1Click API `quote` endpoint with `dry: false` and the merchant's swap configuration (origin asset, destination asset, amount, recipient address, refund policy, fees).

3. **Facilitator → 1Click API**: `POST /v0/quote` with `dry: false` and `swapType: EXACT_OUTPUT` returns the full quote including a unique `depositAddress`, `depositMemo` (if applicable), `maxAmountIn`, `amountOut`, `deadline`, and `timeEstimate`.

4. **Resource Server → Client**: The resource server responds `402 Payment Required` with the `PaymentRequirements` object. Critically, `payTo` is set to the 1Click `depositAddress`. The `extra` field embeds all quote metadata the client needs: the origin asset, required deposit amount, deposit memo (if any), and the quote deadline.

5. **Client sends deposit**: The client constructs and submits a native transaction on the origin chain, transferring the required `amount` to the `payTo` address (plus `depositMemo` if required, e.g., for Stellar).

6. **Client → Resource Server**: The client resends the original request with the `X-PAYMENT` header containing a `PaymentPayload` that includes the deposit `txHash`.

7. **Resource Server → Facilitator `/verify`**: The facilitator validates the payload: checks the `txHash` is well-formed, verifies `depositAddress` matches `payTo`, confirms the quote has not expired, and optionally verifies the on-chain deposit.

8. **Resource Server → Facilitator `/settle`**: Upon successful verification, the resource server calls `/settle`.

9. **Facilitator → 1Click API**: The facilitator calls `POST /v0/deposit/submit` with the `txHash` and `depositAddress` to notify the 1Click service and speed up processing.

10. **Facilitator polls status**: The facilitator polls `GET /v0/status?depositAddress=<addr>[&depositMemo=<memo>]` until a terminal status: `SUCCESS`, `FAILED`, `REFUNDED`, or `INCOMPLETE_DEPOSIT`.

11. **Resource Server → Client**: On `SUCCESS`, the resource server responds `200 OK` with the requested resource and the `X-PAYMENT-RESPONSE` header containing the `SettlementResponse`.

---

## PaymentRequirements for `exact`

```jsonc
{
  "scheme": "exact",
  "network": "near:mainnet",
  "amount": "1005000",                     // Deposit amount the client must send (in smallest unit of origin asset)
  "asset": "arb",                          // Origin asset the client pays WITH (CAIP-2 or contract address)
  "payTo": "0x76b4c56085ED136a8744D52bE956396624a730E8",
                                            // 1Click deposit address (on the origin chain)
  "maxTimeoutSeconds": 300,
  "extra": {
    "assetTransferMethod": "1click-swap",
    "originChain": "arb",                  // Short chain ID where payTo lives
    "depositMemo": "1111111",              // Required if present in quote (e.g. Stellar); null otherwise
    "minAmountIn": "1000000",              // Minimum accepted deposit (from 1Click quote)
    "destinationAsset": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",  // What the merchant receives
    "amountOut": "1000000",                // Expected output to merchant (informational)
    "slippageTolerance": 100,              // Basis points (100 = 1%)
    "deadline": "2026-03-25T15:10:00Z",    // Quote expiry (from 1Click)
    "timeEstimate": 120,                   // Estimated swap time in seconds
    "refundTo": "0x2527D02599Ba641c19FEa793cD0F9a6e8457C317" // Pre-configured refund address (set by client registration or default)                       
  }
}
```

and the full `paymentRequirements` object:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Cross-chain premium market data access",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "near:mainnet",
    "amount": "1005000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Arbitrum
    "payTo": "0x76b4c56085ED136a8744D52bE956396624a730E8",
    "maxTimeoutSeconds": 300,
    "extra": {
      "assetTransferMethod": "1click-swap",
      "originChain": "arb",
      "depositMemo": null,
      "minAmountIn": "1000000",
      "destinationAsset": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      "amountOut": "1000000",
      "slippageTolerance": 100,
      "deadline": "2026-03-25T15:10:00Z",
      "timeEstimate": 120,
      "refundTo": "0x2527D02599Ba641c19FEa793cD0F9a6e8457C317"
    }
  }
}
```

### Mapping to Standard x402 Fields

| x402 Field | 1Click Source | Semantics in This Scheme |
|---|---|---|
| `scheme` | — | Always `"exact"`. |
| `network` | — | Always `"near:mainnet"` — the NEAR Intents settlement layer. |
| `amount` | `quote.maxAmountIn` | The **deposit amount** the client must send on the origin chain. |
| `asset` | Request `originAsset` | The **origin asset** identifier as CAIP-2 identifier  or contract address). This is what the client is paying with. |
| `payTo` | `quote.depositAddress` | The **1Click deposit address** on the origin chain. The client sends tokens here. |
| `maxTimeoutSeconds` | `deadline` − now + buffer | Max time the resource server will wait for full settlement. |

### Extra Field Descriptions

| Field | Type | Required | Description |
|---|---|---|---|
| `assetTransferMethod` | string | Yes | Always `"1click-swap"`. |
| `originChain` | string | Yes | Short chain identifier where the `payTo` deposit address lives (e.g., `"arb"`, `"eth"`, `"sol"`, `"btc"`, `"near"`). |
| `depositMemo` | string \| null | Yes | Deposit memo if required by the origin chain (e.g., Stellar). `null` if not needed. |
| `minAmountIn` | string | Yes | Minimum deposit amount accepted by the 1Click quote. Deposits below this are refunded. |
| `amountOut` | string | Yes | Expected output amount to the merchant (in smallest unit of destination asset). |
| `slippageTolerance` | integer | Yes | Slippage tolerance in basis points. |
| `deadline` | string (ISO 8601) | Yes | Quote expiry timestamp from 1Click. Client MUST deposit before this time. |
| `timeEstimate` | integer | Yes | Estimated swap completion time in seconds (from 1Click). |
| `refundTo` | string | Yes | Address on the origin chain where funds are refunded if the swap fails or exceess exist. |

---

## PaymentPayload `payload` Field

```jsonc
  "payload": {
    "txHash": "0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a",
    "depositAddress": "0x76b4c56085ED136a8744D52bE956396624a730E8",
    "depositMemo": "null",
    "originChain": "arb",
    "clientAddress": "0x2527D02599Ba641c19FEa793cD0F9a6e8457C317"
  }
```
and the full `PaymentPayload` object:

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "near:mainnet",
  "payload": {
    "txHash": "0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a",
    "depositAddress": "0x76b4c56085ED136a8744D52bE956396624a730E8",
    "depositMemo": null,
    "originChain": "arb",
    "clientAddress": "0x2527D02599Ba641c19FEa793cD0F9a6e8457C317"
  }
}
```

### Field Descriptions

| Field | Type | Required | Description |
|---|---|---|---|
| `payload.txHash` | string | Yes | Transaction hash of the client's deposit on the origin chain. This is the proof-of-deposit — analogous to the `signature` field in EVM `exact`. |
| `payload.depositAddress` | string | Yes | Must match `payTo` from `PaymentRequirements`. Included for self-contained verification. |
| `payload.depositMemo` | string \| null | Conditional | Must match `extra.depositMemo` from requirements. Required if non-null. |
| `payload.originChain` | string | Yes | Must match `extra.originChain` from requirements. Identifies which chain the `txHash` belongs to. |
| `payload.clientAddress` | string | Yes | The client's address on the origin chain (sender of the deposit TX). Used for audit and on-chain verification. |

---

## Facilitator Behavior

### Quote Generation (402 Construction Time)

When the resource server needs to construct a `402 Payment Required` response, it invokes the facilitator with the merchant's swap configuration. The facilitator:

1. Calls `POST {apiBaseUrl}/v0/quote` with `dry: false`:
   ```jsonc
   {
     "dry": false,
     "originAsset": "<configured origin asset>",
     "destinationAsset": "<merchant's destination asset>",
     "amount": "<merchant's desired output amount>",
     "swapType": "EXACT_OUTPUT", 
     "slippageTolerance": 100,
     "depositType": "ORIGIN_CHAIN",
     "recipientType": "DESTINATION_CHAIN",
     "refundTo": "<configured refund address>",
     "recipient": "<merchant wallet>",
     "deadline": "<now + configured TTL>",
     "referral": "<x402-1click>",
     "appFees": [...]
   }
   ```
2. Validates the quote response has a `depositAddress` and `maxAmountIn`.
3. Constructs the `PaymentRequirements` with `payTo = quote.depositAddress` and embeds all quote metadata in `extra`.

> **Note**: Because the quote generates a time-limited deposit address, the resource server SHOULD cache the `PaymentRequirements` for the duration of the quote's `deadline` and serve the same `depositAddress` for repeated 402 responses to the same resource, regenerating only when the deadline expires.

### Verification (`POST /verify`)

When the facilitator receives a `PaymentPayload`:

1. **Validate structural consistency**:
   - `payload.depositAddress` MUST equal `paymentRequirements.payTo`.
   - `payload.depositMemo` MUST equal `paymentRequirements.extra.depositMemo`.
   - `payload.originChain` MUST equal `paymentRequirements.extra.originChain`.
   - `payload.txHash` MUST be a non-empty, well-formed transaction hash for the declared chain.

2. **Check quote expiry**:
   - Current time MUST be before `paymentRequirements.extra.deadline`.

3. **On-chain verification** (RECOMMENDED but optional):
   - Query the origin chain's RPC/explorer to confirm the `txHash` is a confirmed transaction that transfers ≥ `paymentRequirements.extra.minAmountIn` of the correct token to the `depositAddress`.

4. **Return `VerifyResponse`**:
   ```jsonc
   {
     "isValid": true,
     "invalidReason": null,
     "payer": "0x2527D02599Ba641c19FEa793cD0F9a6e8457C317"
   }
   ```

### Settlement (`POST /settle`)

1. **Notify 1Click** by calling `POST {apiBaseUrl}/v0/deposit/submit`:
   ```jsonc
   {
     "txHash": "<payload.txHash>",
     "depositAddress": "<payload.depositAddress>"
   }
   ```
   This is optional, as 1Click detects deposits automatically, but accelerates processing.

2. **Poll for terminal status** via `GET {apiBaseUrl}/v0/status?depositAddress=<addr>[&depositMemo=<memo>]` at 3–5 second intervals until terminal or `maxTimeoutSeconds` is exceeded.

3. **Return `SettlementResponse`**:

   **On `SUCCESS`:**
   ```jsonc
   {
     "success": true,
     "network": "near:mainnet",
     "transaction": "<destinationChainTxHashes from 1Click status>",
     "payer": "<payload.clientAddress>",
     "exteonsions": {
       "depositAddress": "<depositAddress>",
       "originTxHash": "<payload.txHash>",
       "nearTxHashes": ["6XqqDwoa...", "EVcgKukw..."],
       "amountInFormatted": "1.005",
       "amountOutFormatted": "1.00",
       "status": "SUCCESS"
     }
   }
   ```

   **On failure (`FAILED` / `REFUNDED` / `INCOMPLETE_DEPOSIT` / timeout):**
   ```jsonc
   {
     "success": false,
     "network": "near:mainnet",
     "error": "<error_code>",
     "extensions": {
       "depositAddress": "<depositAddress>",
       "status": "<terminal status from 1Click>",
       "refundTo": "<extra.refundTo>"
     }
   }
   ```

### Facilitator State

The facilitator MUST maintain transient state for active quotes, keyed by `depositAddress`:

| Key | Stored At | Description |
|---|---|---|
| `depositAddress` | Quote time | The unique deposit address |
| `depositMemo` | Quote time | Memo, if applicable |
| `QuoteResponse` | Quote time | Full 1Click quote response |
| `paymentRequirements` | Quote time | The PaymentRequirements served to the client |
| `deadline` | Quote time | Quote expiry |
| `txHash` | Verify time | Client's deposit TX hash |
| `clientAddress` | Verify time | Client's origin chain address |

State SHOULD be garbage-collected after `deadline` + `maxTimeoutSeconds` + grace period, or after terminal status.

---

## Additional Considerations

### Replay Prevention

- Each quote generates a **unique `depositAddress`** which serves as a natural nonce.
- A given `depositAddress` can only be used for one swap — the 1Click backend rejects duplicate deposits.
- The facilitator MUST reject payloads where `depositAddress` does not correspond to an active, non-expired, non-settled quote in its state.

### Deposit Address Validity Window

- The `deadline` field from the 1Click quote defines when the deposit address becomes inactive.
- The `maxTimeoutSeconds` in `PaymentRequirements` SHOULD be set to: `(deadline - now) + timeEstimate + buffer`.
- Clients MUST submit their deposit transaction **before** the `deadline`. Deposits after the deadline may be refunded instead of swapped.

### Amount Validation

- The facilitator SHOULD verify (on-chain or via 1Click status) that the deposited amount is ≥ `extra.minAmountIn`.
- Deposits below `minAmountIn` result in the 1Click status `INCOMPLETE_DEPOSIT` and are refunded.
- Deposits above `minAmountIn` are processed normally and excess may be refunded.

### Deposit Address Authenticity

- The facilitator MUST only serve deposit addresses obtained from authenticated calls to the 1Click API (using a valid JWT).
- The facilitator MUST NOT relay deposit addresses from untrusted sources.
- Clients interacting with an untrusted resource server bear the risk of sending funds to a malicious address — this is the same trust model as any payment gateway integration.

---

## Error Codes

In addition to standard x402 error codes:

| Code | Description |
|---|---|
| `quote_expired` | The `deadline` has passed; the deposit address is no longer active. |
| `deposit_not_found` | The 1Click status API does not recognize the deposit address. |
| `incomplete_deposit` | Deposited amount is below `minAmountIn`. |
| `swap_failed` | 1Click swap reached `FAILED` terminal status. |
| `swap_refunded` | Swap could not be completed; funds refunded to `refundTo`. |
| `settlement_timeout` | Swap did not reach terminal status within `maxTimeoutSeconds`. |
| `deposit_address_mismatch` | `payload.depositAddress` does not match `paymentRequirements.payTo`. |
| `origin_chain_mismatch` | `payload.originChain` does not match `paymentRequirements.extra.originChain`. |
| `memo_mismatch` | `payload.depositMemo` does not match `paymentRequirements.extra.depositMemo`. |

---

## References

- [1Click API Reference](https://docs.near-intents.org/near-intents/integration/distribution-channels/1click-api)
- [NEAR Intents Supported Chains](https://docs.near-intents.org/resources/chain-support)

## Appendix

### 1Click API Endpoint Mapping

| x402 Operation | 1Click API Endpoint | When Called |
|---|---|---|
| Construct PaymentRequirements | `POST /v0/quote` (`dry: false`) | Resource server builds 402 response |
| Token/asset discovery | `GET /v0/tokens` | Initial configuration |
| Deposit notification | `POST /v0/deposit/submit` | Facilitator `/settle` |
| Status polling | `GET /v0/status` | Facilitator `/settle` — poll until terminal |

### Trust Model

| Relationship | Trust Required | Comparable To |
|---|---|---|
| Client → 1Click deposit address | Client trusts 1Click to either complete the swap or refund | User trusting Stripe/PayPal with payment |
| Resource server → Facilitator | Standard x402 trust model | Same as EVM/SVM schemes |

Unlike the EVM/SVM `exact` schemes where settlement is **trustless** (the on-chain contract enforces transfer constraints), this scheme relies on the **1Click backend and NEAR Intents solver network** to faithfully execute the swap. The `refundTo` mechanism provides a safety net: if the swap cannot be completed, the 1Click system automatically refunds the client.

### Multi-Origin-Chain Support

A resource server MAY advertise multiple `PaymentRequirements` in its 402 response, each with a different origin chain/asset and its own `depositAddress`. This allows the client to choose their preferred payment method:

```jsonc
{
  "x402Version": 2,
  "paymentRequirements": [
    {
      "scheme": "exact",
      "network": "near:mainnet",
      "amount": "1005000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",   // USDC on Arbitrum
      "payTo": "0x76b4c560...",                     // Arbitrum deposit address
      "maxTimeoutSeconds": 300,
      "extra": { "originChain": "arb", /* ... */ }
    },
    {
      "scheme": "exact",
      "network": "near:mainnet",
      "amount": "1005000",
      "asset": "0x036CbD53842c5423634e7929541eC2318f3dCF7e",   // USDC on Ethereum
      "payTo": "0xA1B2C3D4...",                     // Ethereum deposit address
      "maxTimeoutSeconds": 600,
      "extra": { "originChain": "eth", /* ... */ }
    },
    {
      "scheme": "exact",
      "network": "near:mainnet",
      "amount": "38000",
      "asset": "BTC",  // BTC
      "payTo": "bc1qxy2kgd...",                    // Bitcoin deposit address
      "maxTimeoutSeconds": 3600,
      "extra": { "originChain": "btc", /* ... */ }
    }
  ]
}
```

Each entry requires a separate `POST /v0/quote` (`dry: false`) call. Resource servers SHOULD limit the number of concurrent quotes to manage deposit address TTL overhead.

### Deposit Address TTL Management

The 1Click deposit address is valid until the `deadline` (typically configurable, defaults to ~1 hour). The resource server's x402 middleware should:

- Generate quotes on-demand when a client first hits the 402-protected endpoint.
- Cache the `PaymentRequirements` (keyed by resource URL or session) for the remaining TTL.
- Regenerate when the cached quote expires or after successful settlement.

### `refundTo` Configuration

The `refundTo` address in the 1Click quote determines where failed swaps are refunded. There are two strategies:

- **Client-provided**: The resource server collects the client's refund address (e.g., via a registration step or a pre-flight request) and includes it in the quote. 
- **Facilitator-default**: The facilitator uses a default refund address (e.g., a custodial address that the facilitator manages, later disbursing refunds to clients).

> **Recommendation**: For production deployments, use a pre-registration flow where the client provides their refund address before the 402 handshake, OR allow the `refundTo` to be the same as `clientAddress` (the client's origin wallet).

---
