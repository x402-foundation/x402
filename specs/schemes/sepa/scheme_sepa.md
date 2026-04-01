# Scheme: `sepa`

## Summary

The `sepa` scheme enables **fiat EUR settlement** within the x402 protocol. When a resource server accepts the `sepa` scheme, the buyer (client) pays in USDC on-chain â€” identical to the `exact` scheme â€” but the seller (resource server) receives settlement in **EUR via SEPA Instant Credit Transfer** to their EU/EEA bank account.

This scheme extends x402 to the European banking system without changing the buyer experience. The on-chain payment remains trustless and cryptographically signed. A regulated **settlement provider** handles the post-settlement USDC â†’ EUR conversion and SEPA payout.

### Why SEPA?

- **100% of x402 settlement today is in USDC.** European businesses need EUR in their bank accounts to pay salaries, taxes, and suppliers.
- **MiCA regulation** (EU Markets in Crypto-Assets, effective July 2026) requires regulated handling of stablecoin-to-fiat conversions for EU businesses.
- **SEPA Instant** covers 36 countries, 4,000+ banks, and 450M+ people â€” the world's largest single-currency payment zone after USD.
- **x402 V2** was designed for this: the specification explicitly states compatibility with *"legacy payment rails: Facilitators for ACH, SEPA, or card networks fit into the same payment model."*

## Use Cases

### 1. European API Monetization

A European SaaS company exposes a paid API using x402. Their customers (including AI agents) pay in USDC on Base. The company receives EUR in their business bank account via SEPA Instant, typically within 10 seconds. No manual off-ramp, no exchange account, no crypto custody.

### 2. Cross-Border Agent Commerce

An AI agent operating on behalf of a US company needs market data from a European provider. The agent pays USDC (its native currency). The European provider receives EUR (their native currency). Neither party needs to handle foreign currency.

### 3. MiCA-Compliant Merchant Settlement

A European e-commerce platform accepts x402 payments. Under MiCA, they must demonstrate regulated handling of crypto-to-fiat flows. The `sepa` scheme provides a compliant settlement path through regulated off-ramp providers.

### 4. Multi-Currency Resource Pricing

A resource server can advertise both `exact` (USDC settlement) and `sepa` (EUR settlement) in their `accepts` array. Clients that prefer on-chain settlement use `exact`; European sellers that need EUR use `sepa`. The client's payment experience is identical in both cases.

## Architecture

### Settlement Flow

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”     â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  Client  â”‚â”€â”€â”€â”€â–¶â”‚  Facilitator â”‚â”€â”€â”€â”€â–¶â”‚ Settlement        â”‚â”€â”€â”€â”€â–¶â”‚  Seller     â”‚
â”‚ (Agent)  â”‚     â”‚              â”‚     â”‚ Provider          â”‚     â”‚  (EUR IBAN) â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜     â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜     â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜     â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
     â”‚                  â”‚                      â”‚                      â”‚
     â”‚  1. Sign USDC    â”‚                      â”‚                      â”‚
     â”‚  payment (Base)  â”‚                      â”‚                      â”‚
     â”‚â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–¶â”‚                      â”‚                      â”‚
     â”‚                  â”‚  2. Settle USDC      â”‚                      â”‚
     â”‚                  â”‚  on-chain            â”‚                      â”‚
     â”‚                  â”‚â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–¶â”‚                      â”‚
     â”‚                  â”‚                      â”‚  3. Convert          â”‚
     â”‚                  â”‚                      â”‚  USDC â†’ EUR          â”‚
     â”‚                  â”‚                      â”‚  (regulated)         â”‚
     â”‚                  â”‚                      â”‚                      â”‚
     â”‚                  â”‚                      â”‚  4. SEPA Instant     â”‚
     â”‚                  â”‚                      â”‚  to seller IBAN      â”‚
     â”‚                  â”‚                      â”‚â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–¶â”‚
     â”‚                  â”‚                      â”‚                      â”‚
     â”‚                  â”‚  5. Settlement        â”‚                      â”‚
     â”‚                  â”‚  confirmation        â”‚                      â”‚
     â”‚                  â”‚â—€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”‚                      â”‚
     â”‚  6. 200 OK +     â”‚                      â”‚                      â”‚
     â”‚  resource access â”‚                      â”‚                      â”‚
     â”‚â—€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”‚                      â”‚                      â”‚
```

### Key Properties

| Property | Value | Rationale |
|----------|-------|-----------|
| On-chain payment | Unchanged from `exact` | Buyer experience is identical |
| Settlement currency | EUR | Native currency for EU/EEA businesses |
| Settlement rail | SEPA Instant (SCT Inst) | Real-time, < 10 seconds, pan-European |
| FX rate | Locked at payment time | Predictable settlement for seller |
| FX source | ECB reference rate or market rate | Transparent, auditable |
| Conversion | Off-chain, via regulated provider | MiCA compliance, banking integration |
| Compliance | MiCA-aligned, KYB required for sellers | EU regulatory requirement |

### Trust Model

The `sepa` scheme introduces a **settlement provider** role that does not exist in the `exact` scheme. This is an intentional design trade-off:

- **On-chain phase (steps 1â€“2):** Identical to `exact`. The client signs a cryptographic authorization; the facilitator cannot modify amount or destination. Trust-minimized.
- **Off-chain phase (steps 3â€“5):** The settlement provider converts USDC to EUR and initiates a SEPA transfer. This phase requires trust in the settlement provider, similar to how traditional payment processors operate.

**Mitigations:**
- Settlement providers MUST be regulated entities (MiCA-licensed or equivalent)
- FX rate MUST be locked at payment time and included in the `SettlementResponse`
- Settlement confirmation MUST include a SEPA transaction reference (end-to-end ID)
- The facilitator MAY verify settlement completion via the provider's API

This trust model is consistent with x402 V2's stated goal of supporting *"legacy payment rails"* where some off-chain trust is inherent in the settlement mechanism.

## PaymentRequirements

The `sepa` scheme extends `PaymentRequirements` with settlement-specific fields in the `extra` object:

```json
{
  "scheme": "sepa",
  "network": "eip155:8453",
  "amount": "10000",
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "payTo": "0x...",
  "maxTimeoutSeconds": 300,
  "extra": {
    "name": "USD Coin",
    "version": "2",
    "settlementCurrency": "EUR",
    "settlementMethod": "SEPA_INSTANT",
    "estimatedFiatAmount": "9.20",
    "fxRateSource": "ECB",
    "settlementFee": "0.01",
    "fxRateLockedUntil": 1740672389
  }
}
```

### Extra Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `settlementCurrency` | `string` | MUST | ISO 4217 currency code. Currently `"EUR"`. |
| `settlementMethod` | `string` | MUST | Settlement rail. `"SEPA_INSTANT"` or `"SEPA_CREDIT"`. |
| `estimatedFiatAmount` | `string` | SHOULD | Estimated EUR amount the seller will receive, as a decimal string. |
| `fxRateSource` | `string` | SHOULD | Source of the FX rate (e.g., `"ECB"`, `"market"`). |
| `settlementFee` | `string` | SHOULD | Fee as a decimal (e.g., `"0.01"` = 1%). |
| `fxRateLockedUntil` | `number` | SHOULD | Unix timestamp until which the quoted FX rate is valid. |

### Multi-Scheme Advertisement

Resource servers SHOULD advertise both `exact` and `sepa` schemes to maximize compatibility:

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "10000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x...",
      "maxTimeoutSeconds": 60,
      "extra": { "name": "USD Coin", "version": "2" }
    },
    {
      "scheme": "sepa",
      "network": "eip155:8453",
      "amount": "10000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x...",
      "maxTimeoutSeconds": 300,
      "extra": {
        "name": "USD Coin",
        "version": "2",
        "settlementCurrency": "EUR",
        "settlementMethod": "SEPA_INSTANT",
        "estimatedFiatAmount": "9.20",
        "fxRateSource": "ECB",
        "settlementFee": "0.01"
      }
    }
  ]
}
```

## SettlementResponse Extension

The `sepa` scheme extends the standard `SettlementResponse` with fiat settlement details:

```json
{
  "success": true,
  "transaction": "0xabc123...",
  "network": "eip155:8453",
  "settlement": {
    "currency": "EUR",
    "amount": "9.20",
    "method": "SEPA_INSTANT",
    "fxRate": "0.9200",
    "fxRateSource": "ECB",
    "fee": "0.0092",
    "sepaReference": "NOTPROVIDED/20260216/AP001",
    "estimatedArrival": "2026-02-16T18:30:10Z",
    "status": "SENT"
  }
}
```

### Settlement Status Values

| Status | Description |
|--------|-------------|
| `PENDING` | USDC received, EUR conversion initiated |
| `SENT` | SEPA Instant transfer submitted to banking network |
| `COMPLETED` | EUR credited to seller's IBAN (confirmed by bank) |
| `FAILED` | Settlement failed â€” USDC refund initiated |

## Security Considerations

### Replay Attack Prevention

Identical to `exact` scheme. The on-chain payment uses nonces and validity windows.

### FX Rate Manipulation

- The FX rate MUST be locked at the time of the 402 response (`fxRateLockedUntil`)
- The settlement provider MUST NOT settle at a rate worse than the quoted rate
- The actual rate MUST be included in the `SettlementResponse` for auditability

### Settlement Provider Trust

- Settlement providers MUST be regulated entities with appropriate licenses (MiCA, or equivalent in their jurisdiction)
- The facilitator SHOULD verify settlement completion via the provider's API
- Failed settlements MUST result in USDC being returned to the facilitator for client refund

### Compliance

- Sellers using the `sepa` scheme MUST complete KYB (Know Your Business) with the settlement provider
- The settlement provider MUST perform AML/CFT checks as required by EU regulation
- Transaction records MUST be retained per MiCA and local regulatory requirements

## Future Extensions

### ACH Settlement (USD)

The same architecture supports `"settlementCurrency": "USD"` with `"settlementMethod": "ACH"` for US-based sellers. This would use the same on-chain payment flow with USD settlement via ACH or FedNow.

### Multi-Currency

The scheme is designed to be currency-agnostic. Future implementations could support GBP (Faster Payments), JPY (Zengin), or other local payment rails by adding new `settlementMethod` values.

### Streaming Settlements

For high-volume resource servers, batch settlement (periodic EUR payouts rather than per-transaction) could reduce costs and banking fees.

## References

- [SEPA Instant Credit Transfer (SCT Inst)](https://www.europeanpaymentscouncil.eu/what-we-do/sepa-instant-credit-transfer)
- [MiCA Regulation â€” Official Text](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32023R1114)
- [x402 V2 Specification](../x402-specification-v2.md)
- [x402 `exact` Scheme](exact/scheme_exact_evm.md)
- [European Central Bank â€” Euro FX Reference Rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)
- [ISO 20022 â€” SEPA Message Standards](https://www.iso20022.org/)

## Appendix

### Glossary

| Term | Definition |
|------|------------|
| **SEPA** | Single Euro Payments Area â€” pan-European payment integration |
| **SCT Inst** | SEPA Credit Transfer Instant â€” real-time EUR transfers |
| **IBAN** | International Bank Account Number |
| **MiCA** | Markets in Crypto-Assets Regulation (EU) |
| **KYB** | Know Your Business â€” identity verification for companies |
| **Settlement Provider** | Regulated entity that converts USDC to EUR and initiates SEPA transfers |
| **FX Rate** | Foreign exchange rate between USDC and EUR |
| **ECB** | European Central Bank |

### Regulatory Context

The EU's MiCA regulation comes into full effect on **1 July 2026**. Key implications for x402:

- **Crypto-Asset Service Providers (CASPs)** handling USDC-to-EUR conversions must be MiCA-licensed
- **Stablecoin reserves** must meet specific requirements (relevant for USDC issuers in EU)
- **Transaction reporting** requirements apply to all crypto-to-fiat conversions above certain thresholds
- **Consumer protection** provisions require transparent fee and FX rate disclosure

The `sepa` scheme's design â€” with explicit FX rate sources, fee disclosure, and regulated settlement providers â€” is intentionally aligned with these requirements.
