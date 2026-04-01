# Scheme: `sepa` on `EVM`

## Summary

The `sepa` scheme on EVM settles payments in EUR via SEPA Instant, while the on-chain payment mechanism is identical to the `exact` scheme on EVM. The client signs a USDC transfer authorization on Base (or any supported EVM chain); the facilitator settles on-chain; then a regulated settlement provider converts USDC â†’ EUR and sends a SEPA Instant transfer to the seller's IBAN.

This document specifies the EVM-specific implementation details. For the scheme overview, trust model, and use cases, see [scheme_sepa.md](scheme_sepa.md).

### Asset Transfer Methods

The `sepa` scheme supports the same asset transfer methods as `exact` on EVM:

| AssetTransferMethod | Use Case | Recommendation |
|:--------------------|:---------|:---------------|
| **EIP-3009** | Tokens with native `transferWithAuthorization` (e.g., USDC). | **Recommended** (Simplest, truly gasless). |
| **Permit2** | Tokens without EIP-3009. Uses Proxy + Permit2. | **Universal Fallback** (Works for any ERC-20). |

The on-chain payment phase is **identical** to `exact` on EVM. The difference is in what happens after settlement.

---

## Payment Header Payload

The `PAYMENT-SIGNATURE` header payload follows the same structure as `exact` on EVM, with the addition of the `sepa` scheme identifier in the `accepted` field.

### EIP-3009 Example

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.eu/market-data",
    "description": "European market data feed",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "sepa",
    "network": "eip155:8453",
    "amount": "10000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x...",
    "maxTimeoutSeconds": 300,
    "extra": {
      "assetTransferMethod": "eip3009",
      "name": "USD Coin",
      "version": "2",
      "settlementCurrency": "EUR",
      "settlementMethod": "SEPA_INSTANT",
      "estimatedFiatAmount": "9.20",
      "fxRateSource": "ECB",
      "settlementFee": "0.01",
      "fxRateLockedUntil": 1740672389
    }
  },
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0x...",
      "to": "0x...",
      "value": "10000",
      "validAfter": "1740672089",
      "validBefore": "1740672389",
      "nonce": "0x..."
    }
  }
}
```

### Permit2 Example

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "sepa",
    "network": "eip155:8453",
    "amount": "10000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x...",
    "maxTimeoutSeconds": 300,
    "extra": {
      "assetTransferMethod": "permit2",
      "name": "USD Coin",
      "version": "2",
      "settlementCurrency": "EUR",
      "settlementMethod": "SEPA_INSTANT",
      "estimatedFiatAmount": "9.20",
      "fxRateSource": "ECB",
      "settlementFee": "0.01"
    }
  },
  "payload": {
    "signature": "0x...",
    "permit2Authorization": {
      "permitted": {
        "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "amount": "10000"
      },
      "from": "0x...",
      "spender": "0xx402Permit2ProxyAddress",
      "nonce": "0x...",
      "deadline": "1740672389",
      "witness": {
        "to": "0x...",
        "validAfter": "1740672089",
        "extra": {}
      }
    }
  }
}
```

## Verification

Verification follows the **same steps** as `exact` on EVM, with additional SEPA-specific checks:

### Phase 1: On-Chain Verification (identical to `exact`)

1. **Verify** the signature is valid and recovers to the `authorization.from` address.
2. **Verify** the client has sufficient balance of the asset.
3. **Verify** the authorization parameters (amount, validity window) meet the `PaymentRequirements`.
4. **Verify** the token and network match the requirement.
5. **Simulate** the transfer to ensure success.

### Phase 2: SEPA-Specific Verification

6. **Verify** `extra.settlementCurrency` is a supported ISO 4217 currency (currently `"EUR"`).
7. **Verify** `extra.settlementMethod` is a supported method (`"SEPA_INSTANT"` or `"SEPA_CREDIT"`).
8. **Verify** `extra.fxRateLockedUntil` has not expired (if present).
9. **Verify** the settlement provider is available and can process the conversion.

### Error Codes

| HTTP Status | Error Code | Description |
|-------------|------------|-------------|
| 402 | `PAYMENT_REQUIRED` | Standard x402 â€” payment needed |
| 412 | `PERMIT2_ALLOWANCE_REQUIRED` | Client needs one-time Permit2 approval |
| 422 | `SETTLEMENT_CURRENCY_UNSUPPORTED` | Requested currency not available |
| 422 | `FX_RATE_EXPIRED` | Quoted FX rate has expired; client should retry |
| 503 | `SETTLEMENT_PROVIDER_UNAVAILABLE` | EUR settlement temporarily unavailable |

## Settlement

Settlement is a two-phase process:

### Phase 1: On-Chain Settlement (identical to `exact`)

The facilitator settles the USDC payment on-chain using the same mechanism as `exact`:

- **EIP-3009:** Call `transferWithAuthorization` on the USDC contract.
- **Permit2:** Call `x402Permit2Proxy.settle`.

The USDC is transferred from the client to the `payTo` address (which is the settlement provider's receiving address).

### Phase 2: Fiat Settlement (SEPA-specific)

After on-chain settlement confirms:

1. The settlement provider detects the incoming USDC (via event monitoring or webhook).
2. The provider converts USDC â†’ EUR at the locked FX rate.
3. The provider initiates a SEPA Instant Credit Transfer to the seller's registered IBAN.
4. The provider returns a `SettlementResponse` with fiat settlement details.

```
On-chain settlement          Fiat settlement
    (< 5 sec)              (< 10 sec typical)
        â”‚                        â”‚
  â”Œâ”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”            â”Œâ”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”
  â”‚ USDC      â”‚            â”‚ USDCâ†’EUR  â”‚
  â”‚ transfer  â”‚â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–¶â”‚ + SEPA    â”‚â”€â”€â”€â”€â”€â”€â–¶ EUR in seller's bank
  â”‚ on Base   â”‚            â”‚ Instant   â”‚
  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜            â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

### SettlementResponse

The facilitator returns an extended `SettlementResponse` that includes both on-chain and fiat settlement details:

```json
{
  "success": true,
  "transaction": "0xabc123def456...",
  "network": "eip155:8453",
  "settlement": {
    "currency": "EUR",
    "amount": "9.20",
    "method": "SEPA_INSTANT",
    "fxRate": "0.9200",
    "fxRateSource": "ECB",
    "fee": "0.092",
    "sepaReference": "AP20260216183010001",
    "estimatedArrival": "2026-02-16T18:30:20Z",
    "status": "SENT"
  }
}
```

### Settlement Failure Handling

If fiat settlement fails after on-chain settlement succeeds:

1. The settlement provider MUST retain the USDC.
2. The settlement provider MUST retry the SEPA transfer (up to 3 attempts).
3. If all retries fail, the settlement provider MUST notify the facilitator with status `"FAILED"`.
4. The facilitator MAY initiate a USDC refund to the client, depending on the resource server's refund policy.

### Settlement Timeout

The `maxTimeoutSeconds` for the `sepa` scheme SHOULD be set to at least `300` (5 minutes) to account for:
- On-chain confirmation: ~2 seconds (Base L2)
- USDC â†’ EUR conversion: ~5â€“30 seconds
- SEPA Instant transfer: ~1â€“10 seconds
- Buffer for provider processing: ~60 seconds

Typical end-to-end settlement: **< 30 seconds**.

## Settlement Provider Interface

Settlement providers MUST implement the following interface for facilitator integration:

### POST `/v1/settlement/sepa`

Initiates a USDC â†’ EUR â†’ SEPA settlement.

**Request:**
```json
{
  "transactionHash": "0xabc123...",
  "network": "eip155:8453",
  "amount": "10000",
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "sellerIban": "DE89370400440532013000",
  "sellerBic": "COBADEFFXXX",
  "reference": "x402-payment-001"
}
```

**Response:**
```json
{
  "settlementId": "sp_001",
  "status": "SENT",
  "currency": "EUR",
  "amount": "9.20",
  "fxRate": "0.9200",
  "sepaReference": "AP20260216183010001",
  "estimatedArrival": "2026-02-16T18:30:20Z"
}
```

### GET `/v1/settlement/sepa/{settlementId}`

Returns the current status of a settlement.

**Response:**
```json
{
  "settlementId": "sp_001",
  "status": "COMPLETED",
  "completedAt": "2026-02-16T18:30:18Z",
  "bankConfirmation": "SEPA-REF-20260216-001"
}
```

## Appendix

### Supported Networks

The `sepa` scheme is initially supported on:

| Network | CAIP-2 ID | USDC Address |
|---------|-----------|-------------|
| Base Mainnet | `eip155:8453` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Base Sepolia (testnet) | `eip155:84532` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Additional EVM networks (Ethereum mainnet, Arbitrum, Optimism, Polygon) MAY be added as settlement providers expand coverage.

### SEPA Instant Coverage

As of 2026, SEPA Instant covers:
- **36 countries**: All EU/EEA member states
- **4,000+ banks**: Representing >99% of EU payment accounts
- **Transaction limit**: â‚¬100,000 per transfer (January 2025 regulation)
- **Availability**: 24/7/365
- **Speed**: Funds credited within 10 seconds

### Comparison with `exact` Scheme

| Aspect | `exact` | `sepa` |
|--------|---------|--------|
| Client payment | USDC on-chain | USDC on-chain (identical) |
| Settlement currency | USDC | EUR |
| Settlement rail | On-chain transfer | SEPA Instant |
| Settlement speed | ~2 seconds | ~10â€“30 seconds |
| Trust model | Trust-minimized | Requires trusted settlement provider |
| Geographic scope | Global | EU/EEA (36 countries) |
| Regulatory | Minimal | MiCA-compliant |
| Seller requirements | Wallet address | IBAN + KYB verification |
| FX risk | None | Locked at payment time |
