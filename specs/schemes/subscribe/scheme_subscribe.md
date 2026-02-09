# Scheme: `subscribe`

## Summary

The `subscribe` scheme enables recurring subscription-based payments for internet resources. Unlike the `exact` scheme which transfers a specific amount per request, `subscribe` allows clients to authorize periodic payments for ongoing access to resources over a defined billing cycle.

This scheme complements `exact` by enabling hybrid monetization strategies where services can offer both pay-per-use and subscription-based pricing models. Clients (including autonomous AI agents) can intelligently choose between schemes based on usage patterns and cost optimization.

## Use Cases

- **SaaS API Access**: Monthly/annual subscriptions for API endpoints with usage limits
- **Premium Content**: Recurring access to paywalled articles, videos, or data feeds
- **AI Agent Services**: Subscription plans for agents consuming multiple tools/resources
- **Data Streams**: Continuous access to real-time market data, weather feeds, or analytics
- **Tiered Access**: Multiple subscription tiers with different rate limits or features

## Subscription Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SUBSCRIPTION LIFECYCLE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐          │
│   │ DISCOVER │───▶│SUBSCRIBE │───▶│  ACCESS  │───▶│RENEW/CANCEL  │          │
│   └──────────┘    └──────────┘    └──────────┘    └──────────────┘          │
│        │               │               │                  │                  │
│        ▼               ▼               ▼                  ▼                  │
│   402 Response    Pay First      Present Proof      Auto-renew or           │
│   with tiers      Billing        Each Request       Cancel                   │
│                   Cycle                                                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Phase 1: Discovery

The resource server advertises subscription options alongside other payment schemes in the `402 Payment Required` response. This enables clients to compare pricing models and select the most cost-effective option.

### Phase 2: Subscription Initiation

The client selects a subscription tier and submits a cryptographic authorization for the first billing period. The authorization includes:
- Selected tier identifier
- Billing cycle duration
- Maximum amount per cycle
- Renewal preferences

### Phase 3: Access with Subscription Proof

Once subscribed, the client presents a "subscription proof" with each request. This proof is verified without requiring a new payment, enabling efficient access within the subscription period.

### Phase 4: Renewal or Cancellation

Before the billing cycle ends, the subscription is either:
- **Auto-renewed**: Client pre-authorizes future payments
- **Manually renewed**: Client submits new authorization
- **Cancelled**: Subscription ends at cycle completion

## PaymentRequirements Schema

When a resource server requires subscription payment, it includes `subscribe` options in the `accepts` array:

```json
{
  "x402Version": 2,
  "error": "Payment required for premium access",
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Real-time market data API",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "1000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    },
    {
      "scheme": "subscribe",
      "network": "eip155:8453",
      "amount": "5000000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 300,
      "extra": {
        "name": "USDC",
        "version": "2",
        "subscriptionDetails": {
          "tierId": "pro",
          "tierName": "Pro Plan",
          "billingCycle": "monthly",
          "billingCycleSeconds": 2592000,
          "features": ["unlimited_requests", "priority_support", "advanced_analytics"],
          "rateLimits": {
            "requestsPerMinute": 1000,
            "requestsPerDay": 100000
          },
          "renewalPolicy": "auto",
          "gracePeriodSeconds": 86400,
          "cancellationPolicy": "end_of_cycle"
        }
      }
    },
    {
      "scheme": "subscribe",
      "network": "eip155:8453",
      "amount": "50000000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 300,
      "extra": {
        "name": "USDC",
        "version": "2",
        "subscriptionDetails": {
          "tierId": "enterprise",
          "tierName": "Enterprise Plan",
          "billingCycle": "annual",
          "billingCycleSeconds": 31536000,
          "features": ["unlimited_requests", "dedicated_support", "custom_integrations", "sla_guarantee"],
          "rateLimits": {
            "requestsPerMinute": 10000,
            "requestsPerDay": null
          },
          "renewalPolicy": "manual",
          "gracePeriodSeconds": 604800,
          "cancellationPolicy": "end_of_cycle"
        }
      }
    }
  ]
}
```

### Subscription-Specific Fields in `extra`

| Field Name             | Type     | Required | Description                                                      |
| ---------------------- | -------- | -------- | ---------------------------------------------------------------- |
| `subscriptionDetails`  | `object` | Required | Container for subscription-specific configuration                |

### `subscriptionDetails` Object

| Field Name              | Type       | Required | Description                                                                          |
| ----------------------- | ---------- | -------- | ------------------------------------------------------------------------------------ |
| `tierId`                | `string`   | Required | Unique identifier for the subscription tier                                          |
| `tierName`              | `string`   | Required | Human-readable name for the tier                                                     |
| `billingCycle`          | `string`   | Required | Billing cycle type: `"daily"`, `"weekly"`, `"monthly"`, `"annual"`, or `"custom"`    |
| `billingCycleSeconds`   | `number`   | Required | Duration of billing cycle in seconds                                                 |
| `features`              | `array`    | Optional | List of features included in this tier                                               |
| `rateLimits`            | `object`   | Optional | Rate limiting configuration for this tier                                            |
| `renewalPolicy`         | `string`   | Required | `"auto"` for automatic renewal, `"manual"` for manual renewal                        |
| `gracePeriodSeconds`    | `number`   | Optional | Time after expiry during which access continues while awaiting renewal               |
| `cancellationPolicy`    | `string`   | Required | `"immediate"` or `"end_of_cycle"`                                                    |
| `trialPeriodSeconds`    | `number`   | Optional | Duration of free trial period (if applicable)                                        |
| `maxRenewals`           | `number`   | Optional | Maximum number of automatic renewals (null for unlimited)                            |

## PaymentPayload Schema

### Initial Subscription

When subscribing, the client sends a `PaymentPayload` with subscription authorization:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Real-time market data API",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "subscribe",
    "network": "eip155:8453",
    "amount": "5000000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 300,
    "extra": {
      "name": "USDC",
      "version": "2",
      "subscriptionDetails": {
        "tierId": "pro",
        "tierName": "Pro Plan",
        "billingCycle": "monthly",
        "billingCycleSeconds": 2592000,
        "renewalPolicy": "auto",
        "gracePeriodSeconds": 86400,
        "cancellationPolicy": "end_of_cycle"
      }
    }
  },
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "to": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "value": "5000000",
      "validAfter": "1740672089",
      "validBefore": "1743264089",
      "nonce": "0x..."
    },
    "subscriptionPayload": {
      "action": "subscribe",
      "tierId": "pro",
      "startTimestamp": "1740672089",
      "renewalAuthorizations": []
    }
  }
}
```

### Subscription Payload Fields

| Field Name               | Type     | Required | Description                                                      |
| ------------------------ | -------- | -------- | ---------------------------------------------------------------- |
| `action`                 | `string` | Required | `"subscribe"`, `"renew"`, or `"cancel"`                          |
| `tierId`                 | `string` | Required | The tier being subscribed to                                     |
| `startTimestamp`         | `string` | Required | Unix timestamp when subscription begins                          |
| `renewalAuthorizations`  | `array`  | Optional | Pre-signed authorizations for future billing cycles              |

### Pre-authorized Renewals (Optional)

For `auto` renewal subscriptions, clients MAY include pre-signed authorizations for future billing cycles:

```json
{
  "renewalAuthorizations": [
    {
      "cycleNumber": 2,
      "signature": "0x...",
      "authorization": {
        "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        "to": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        "value": "5000000",
        "validAfter": "1743264089",
        "validBefore": "1745856089",
        "nonce": "0x..."
      }
    },
    {
      "cycleNumber": 3,
      "signature": "0x...",
      "authorization": {
        "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        "to": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        "value": "5000000",
        "validAfter": "1745856089",
        "validBefore": "1748448089",
        "nonce": "0x..."
      }
    }
  ]
}
```

## Subscription Proof (Access Verification)

Once subscribed, clients present a subscription proof for subsequent requests without requiring new payments:

### X-SUBSCRIPTION-PROOF Header

```json
{
  "subscriptionId": "sub_abc123xyz",
  "subscriber": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "tierId": "pro",
  "network": "eip155:8453",
  "currentCycleStart": "1740672089",
  "currentCycleEnd": "1743264089",
  "signature": "0x..."
}
```

The signature is over the subscription proof fields, signed by the subscriber's wallet, enabling cryptographic verification without blockchain queries for each request.

### Subscription Proof Fields

| Field Name          | Type     | Required | Description                                           |
| ------------------- | -------- | -------- | ----------------------------------------------------- |
| `subscriptionId`    | `string` | Required | Unique identifier issued by the resource server       |
| `subscriber`        | `string` | Required | Wallet address of the subscriber                      |
| `tierId`            | `string` | Required | Active subscription tier                              |
| `network`           | `string` | Required | Network identifier in CAIP-2 format                   |
| `currentCycleStart` | `string` | Required | Unix timestamp of current billing cycle start         |
| `currentCycleEnd`   | `string` | Required | Unix timestamp of current billing cycle end           |
| `signature`         | `string` | Required | Subscriber's signature over the proof fields          |

## SettlementResponse Schema

### Initial Subscription Settlement

```json
{
  "success": true,
  "transaction": "0x1234567890abcdef...",
  "network": "eip155:8453",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "subscriptionDetails": {
    "subscriptionId": "sub_abc123xyz",
    "tierId": "pro",
    "status": "active",
    "currentCycleStart": "1740672089",
    "currentCycleEnd": "1743264089",
    "nextRenewalDate": "1743264089",
    "autoRenewEnabled": true
  }
}
```

### Renewal Settlement

```json
{
  "success": true,
  "transaction": "0xabcdef1234567890...",
  "network": "eip155:8453",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "subscriptionDetails": {
    "subscriptionId": "sub_abc123xyz",
    "tierId": "pro",
    "status": "active",
    "cycleNumber": 3,
    "currentCycleStart": "1745856089",
    "currentCycleEnd": "1748448089",
    "nextRenewalDate": "1748448089",
    "autoRenewEnabled": true
  }
}
```

## Verification

Facilitators and resource servers MUST perform the following verification steps:

### Initial Subscription Verification

1. **Signature Validation**: Verify the payment signature is valid and signed by `authorization.from`
2. **Balance Verification**: Confirm the subscriber has sufficient token balance
3. **Amount Validation**: Ensure payment amount matches the tier's billing amount
4. **Time Window Check**: Verify authorization is within its valid time range
5. **Tier Validation**: Confirm the selected `tierId` exists and is available
6. **Parameter Matching**: Ensure all parameters match the advertised `PaymentRequirements`
7. **Transaction Simulation**: Simulate the transfer to ensure it would succeed

### Subscription Proof Verification

1. **Signature Validation**: Verify the proof signature matches the subscriber address
2. **Subscription Status**: Check subscription is active (not cancelled or expired)
3. **Time Validation**: Verify current time is within `currentCycleStart` and `currentCycleEnd`
4. **Tier Matching**: Confirm the tier grants access to the requested resource
5. **Rate Limit Check**: Verify subscriber hasn't exceeded tier rate limits

### Renewal Verification

1. **Pre-authorization Validation**: If using pre-signed renewals, verify the authorization for the current cycle
2. **Subscription Continuity**: Verify the subscription was active in the previous cycle
3. **Amount Consistency**: Ensure renewal amount matches the tier pricing

## Settlement

### Initial Subscription Settlement

Settlement for the first billing cycle follows the same pattern as the `exact` scheme:

1. Call `transferWithAuthorization` (EIP-3009) or `permitWitnessTransferFrom` (Permit2) with the subscription payment
2. Record subscription details in the resource server's subscription registry
3. Issue a `subscriptionId` to the client
4. Return the `SettlementResponse` with subscription details

### Renewal Settlement

For subscriptions with pre-authorized renewals:

1. At the start of each billing cycle, the facilitator executes the pre-signed authorization
2. If the authorization fails (insufficient funds, revoked, etc.), enter grace period
3. Notify the subscriber of renewal success or failure
4. Update subscription status accordingly

### Cancellation

Cancellation does not involve a blockchain transaction but updates the subscription registry:

1. Client sends cancellation request with signed proof of intent
2. Server marks subscription for non-renewal
3. Access continues until `currentCycleEnd` (for `end_of_cycle` policy)
4. No refunds are processed (unless explicitly supported by the service)

## Security Considerations

### Replay Attack Prevention

- Each authorization includes a unique nonce preventing reuse
- Pre-signed renewal authorizations have non-overlapping validity windows
- Subscription proofs include cycle timestamps preventing cross-cycle replay

### Authorization Scope

- Subscribers control the exact amount and duration of each authorization
- Pre-signed renewals can be revoked by spending the nonce before the validity window
- Facilitators cannot modify amounts, recipients, or timing

### Subscription State Management

- Resource servers MUST maintain accurate subscription state
- Grace periods provide buffer for failed renewals without immediate access loss
- Subscribers can query their subscription status at any time

### Rate Limiting

- Tier-based rate limits prevent abuse even with valid subscriptions
- Resource servers SHOULD implement per-subscriber tracking
- Exceeded limits SHOULD return appropriate error responses, not payment requests

## Agent Optimization

AI agents can automatically optimize payment strategy by comparing costs:

```
IF (expected_requests_per_cycle * exact_price) > subscription_price THEN
    USE subscribe scheme
ELSE
    USE exact scheme
END IF
```

This enables autonomous cost optimization without human intervention.

## Appendix

### Standard Billing Cycles

| Cycle     | Seconds     | Description         |
| --------- | ----------- | ------------------- |
| `daily`   | 86400       | 24 hours            |
| `weekly`  | 604800      | 7 days              |
| `monthly` | 2592000     | 30 days             |
| `annual`  | 31536000    | 365 days            |
| `custom`  | (variable)  | Custom duration     |

### Error Codes

| Error Code                        | Description                                            |
| --------------------------------- | ------------------------------------------------------ |
| `subscription_not_found`          | No active subscription for the subscriber              |
| `subscription_expired`            | Subscription has ended and was not renewed             |
| `subscription_cancelled`          | Subscription was cancelled                             |
| `tier_not_available`              | Requested tier is not currently available              |
| `rate_limit_exceeded`             | Subscriber exceeded tier rate limits                   |
| `renewal_failed`                  | Automatic renewal failed (insufficient funds, etc.)    |
| `invalid_subscription_proof`      | Subscription proof signature or data is invalid        |
| `grace_period_expired`            | Grace period ended without successful renewal          |

### References

- [EIP-3009: Transfer With Authorization](https://eips.ethereum.org/EIPS/eip-3009)
- [Permit2 Documentation](https://docs.uniswap.org/contracts/permit2/overview)
- [x402 Protocol Specification](../../x402-specification-v2.md)
- [Exact Scheme Specification](../exact/scheme_exact.md)
