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

## Why Not Existing Schemes?

Subscription billing requires periodic charges against a single client commitment. Existing schemes do not support this pattern:

| Scheme | Limitation for Subscriptions |
|--------|------------------------------|
| **`exact`** / raw EIP-3009 | Single-use nonce per authorization. A 12-month subscription would require 12 separate client signatures, defeating the purpose of "authorize once, charge periodically." |
| **`auth-capture`** | Authorize-once / capture-once semantics. The `preApprovalExpiry = now + maxTimeoutSeconds` construction (~60 seconds) cannot span a billing term measured in days or months. |
| **`upto`** | Single settlement per authorization. After one charge, the authorization is consumed; no mechanism for subsequent periodic charges. |
| **`batch-settlement`** | Escrow vouchers designed for micropayment aggregation. No term/tier/renewal semantics; commitment redemption is one-shot, not periodic. |

The `subscribe` scheme introduces a Merkle schedule commitment that allows one client signature to authorize an entire billing schedule, with on-chain guardrails enforcing per-period caps, time windows, and a monotonic charge cursor.

## Subscription Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SUBSCRIPTION LIFECYCLE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐          │
│   │ DISCOVER │───▶│SUBSCRIBE │───▶│  ACCESS  │───▶│ CHARGE/CANCEL│          │
│   └──────────┘    └──────────┘    └──────────┘    └──────────────┘          │
│        │               │               │                  │                  │
│        ▼               ▼               ▼                  ▼                  │
│   402 Response    Commit to       Present Proof      Facilitator             │
│   with tiers      Schedule        Each Request       charges next            │
│                   + Allowance                        period; no new          │
│                                                      client signature        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Phase 1: Discovery

The resource server advertises subscription options alongside other payment schemes in the `402 Payment Required` response. This enables clients to compare pricing models and select the most cost-effective option.

### Phase 2: Subscription Initiation

The client selects a subscription tier and:

1. **Builds the Merkle schedule** from the advertised terms (see [Merkle Schedule Commitment](#merkle-schedule-commitment))
2. **Signs an EIP-712 commitment** binding the schedule root, subscriber, asset, payTo, registry, chainId, tierId, start, expiry, and maxPerPeriod
3. **Establishes a standing ERC-20 allowance** to the registry (gaslessly via EIP-2612 permit or Permit2, submitted by the facilitator)

### Phase 3: Access with Subscription Proof

Once subscribed, the client presents an active-subscription proof via the `subscription` extension echoed in `PaymentPayload.extensions`. The resource server verifies the proof against the on-chain registry. No payment is required for access requests within an active subscription period.

### Phase 4: Periodic Charges and Cancellation

At each billing period boundary:

- **Charge**: The facilitator submits the next scheduled charge with a Merkle proof. No new client signature is needed — the original commitment covers the entire schedule.
- **Cancel**: The client signs a cancellation request (with replay protection). The registry records the cancellation; no charges after the current period are possible.

## Core Properties (MUST)

The `subscribe` scheme MUST enforce the following properties across ALL network implementations:

### 1. Per-Period Single Settlement (Monotonic Cursor)

Each billing period MUST be settled at most once. The registry maintains a monotonic cursor; a charge succeeds only when `periodIndex == cursor`, and `cursor` increments on success.

- Rationale: Prevents double-charging and enforces sequential billing.
- Implementation: On EVM, the registry stores `cursor` per subscription; `chargePeriod` reverts if `periodIndex != cursor`.

### 2. Time-Window Validity

Each charge MUST fall within the chargeable window: `validFrom <= block.timestamp <= validTo + gracePeriodSeconds`. The grace period extends the window to allow retries on failed charges without advancing to the next period.

- Rationale: Prevents early charges (before the period starts) and ensures charges happen within a bounded retry window.
- Implementation: The Merkle leaf encodes `(periodIndex, fee, validFrom, validTo)`; the registry extends the window by `gracePeriodSeconds` (a signed commitment field) for retry tolerance.

### 3. Commitment Binding

The client's EIP-712 commitment MUST cryptographically bind:

- `subscriber` — the paying address
- `payTo` — the recipient address
- `asset` — the token contract
- `registry` — the subscription registry contract
- `chainId` — the network
- `tierId` — the subscription tier
- `root` — the Merkle root of the billing schedule

The facilitator cannot redirect funds, change the asset, or substitute the registry.

- Rationale: All critical parameters are signed; tampering is cryptographically detectable.
- Implementation: The registry verifies the EIP-712 signature in `subscribe()` and stores the commitment hash.

### 4. Per-Period Cap Enforcement

The charged fee MUST NOT exceed `maxPerPeriod` from the signed commitment, regardless of what the Merkle leaf claims.

- Rationale: Bounds worst-case per-charge exposure even if the facilitator provides a malicious proof.
- Implementation: `chargePeriod` reverts if `leaf.fee > commitment.maxPerPeriod`.

### 5. Aggregate Spend Bound

Cumulative spend is bounded by:

- The sum of fees in the signed Merkle schedule (client recomputes before signing)
- The standing ERC-20 allowance to the registry (SHOULD equal total committed spend)

When the allowance depletes or balance is insufficient, the charge fails and the subscription enters grace period.

- Rationale: The allowance doubles as an on-chain aggregate cap; the client controls total exposure.
- Implementation: The registry calls `transferFrom`; ERC-20 reverts if allowance or balance is insufficient.

### 6. Expiry and Cancel Halt All Future Charges

After `expiry` timestamp or a recorded `cancel`, no further charges are valid regardless of otherwise-valid Merkle proofs.

- Rationale: Hard boundary on subscription lifetime; client retains exit control.
- Implementation: `chargePeriod` checks `block.timestamp <= expiry` and `!cancelled` before any transfer.

## Trust Model

The facilitator is trusted for **liveness only**: it operates the Merkle tree and proofs off-chain and submits charges on-chain. The facilitator has **no safety authority** — it cannot:

- Overcharge (fee <= maxPerPeriod, fee matches leaf, cursor is monotonic)
- Charge early (before validFrom) or late (after validTo + gracePeriodSeconds)
- Charge past expiry or cancel (hard on-chain checks)
- Redirect funds (payTo/asset/registry bound in commitment)
- Double-charge (cursor increments only on successful transfer)

**Facilitator compromise degrades to denial of service, never theft beyond the signed schedule.**

## Merkle Schedule Commitment

### Leaf Structure

Each leaf in the Merkle tree represents one billing period:

```
leaf = keccak256(keccak256(abi.encode(periodIndex, fee, validFrom, validTo)))
```

The double-hash follows the OpenZeppelin MerkleProof convention to prevent second-preimage attacks.

| Field | Type | Description |
|-------|------|-------------|
| `periodIndex` | `uint256` | Zero-indexed billing period number |
| `fee` | `uint256` | Amount to charge for this period (in token atomic units) |
| `validFrom` | `uint256` | Unix timestamp when this period's charge becomes valid |
| `validTo` | `uint256` | Unix timestamp when this period's charge expires |

### Tree Construction

Clients MUST build the Merkle tree themselves from the advertised `subscriptionDetails`:

1. For each period `i` from `0` to `N-1`:
   - `validFrom = start + (i * billingCycleSeconds)`
   - `validTo = start + ((i + 1) * billingCycleSeconds) + gracePeriodSeconds`
   - `fee = amount` (from `PaymentRequirements`)
2. Compute each leaf using the double-hash formula
3. Build a binary Merkle tree; the root is `root`

**Critical**: Clients MUST NOT sign a root they did not recompute. Blind-signing a facilitator-provided root would allow arbitrary charges.

### EIP-712 Commitment

The client signs an EIP-712 typed data structure:

```
SubscriptionCommitment {
  bytes32 root;
  address subscriber;
  address asset;
  address payTo;
  address registry;
  uint256 chainId;
  string tierId;
  uint256 start;
  uint256 expiry;
  uint256 maxPerPeriod;
  uint256 gracePeriodSeconds;
}
```

The `subscriptionId` is the keccak256 hash of the ABI-encoded commitment struct, ensuring uniqueness and binding all parameters. Note that `gracePeriodSeconds` is client-signed because it extends the chargeable window and thus affects fund exposure.

### Funding: Standing Allowance

The client establishes an ERC-20 allowance from `subscriber` to `registry` for the total committed spend. Gasless options:

- **EIP-2612 Permit**: Client signs a permit; facilitator submits it bundled with `subscribe()`
- **Permit2**: Client signs a Permit2 allowance; facilitator submits via the Permit2 contract

The allowance SHOULD equal the sum of all `fee` values in the schedule. This makes the allowance itself an on-chain aggregate cap — when it depletes, charges fail.

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
        "registry": "0x402SubscriptionRegistryAddress",
        "subscriptionDetails": {
          "tierId": "pro",
          "tierName": "Pro Plan",
          "billingCycle": "monthly",
          "billingCycleSeconds": 2592000,
          "periodCount": 12,
          "features": ["unlimited_requests", "priority_support", "advanced_analytics"],
          "rateLimits": {
            "requestsPerMinute": 1000,
            "requestsPerDay": 100000
          },
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
        "registry": "0x402SubscriptionRegistryAddress",
        "subscriptionDetails": {
          "tierId": "enterprise",
          "tierName": "Enterprise Plan",
          "billingCycle": "annual",
          "billingCycleSeconds": 31536000,
          "periodCount": 1,
          "features": ["unlimited_requests", "dedicated_support", "custom_integrations", "sla_guarantee"],
          "rateLimits": {
            "requestsPerMinute": 10000,
            "requestsPerDay": null
          },
          "gracePeriodSeconds": 604800,
          "cancellationPolicy": "end_of_cycle"
        }
      }
    }
  ]
}
```

### Subscription-Specific Fields in `extra`

| Field Name | Type | Required | Description |
|------------|------|----------|-------------|
| `registry` | `string` | Required | Address of the on-chain SubscriptionRegistry contract |
| `subscriptionDetails` | `object` | Required | Container for subscription-specific configuration |

### `subscriptionDetails` Object

| Field Name | Type | Required | Description |
|------------|------|----------|-------------|
| `tierId` | `string` | Required | Unique identifier for the subscription tier |
| `tierName` | `string` | Required | Human-readable name for the tier |
| `billingCycle` | `string` | Required | Billing cycle type: `"daily"`, `"weekly"`, `"monthly"`, `"annual"`, or `"custom"` |
| `billingCycleSeconds` | `number` | Required | Duration of billing cycle in seconds |
| `periodCount` | `number` | Required | Number of billing periods in the subscription term |
| `features` | `array` | Optional | List of features included in this tier |
| `rateLimits` | `object` | Optional | Rate limiting configuration for this tier |
| `gracePeriodSeconds` | `number` | Optional | Time after a failed charge during which access continues |
| `cancellationPolicy` | `string` | Required | `"immediate"` or `"end_of_cycle"` |
| `trialPeriodSeconds` | `number` | Optional | Duration of free trial period (if applicable) |

## PaymentPayload Schema

### Subscribe Action

When subscribing, the client sends a `PaymentPayload` with the schedule commitment:

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
      "registry": "0x402SubscriptionRegistryAddress",
      "subscriptionDetails": {
        "tierId": "pro",
        "tierName": "Pro Plan",
        "billingCycle": "monthly",
        "billingCycleSeconds": 2592000,
        "periodCount": 12,
        "gracePeriodSeconds": 86400,
        "cancellationPolicy": "end_of_cycle"
      }
    }
  },
  "payload": {
    "action": "subscribe",
    "commitment": {
      "root": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      "subscriber": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "registry": "0x402SubscriptionRegistryAddress",
      "chainId": 8453,
      "tierId": "pro",
      "start": "1740672089",
      "expiry": "1772208089",
      "maxPerPeriod": "5000000"
    },
    "commitmentSignature": "0x...",
    "allowanceMethod": "eip2612-permit",
    "bundledPermitSignature": "0x..."
  }
}
```

### Subscription Payload Fields

| Field Name | Type | Required | Description |
|------------|------|----------|-------------|
| `action` | `string` | Required | `"subscribe"`, `"cancel"`, or `"updateRoot"` |
| `commitment` | `object` | Required | The EIP-712 commitment struct (for subscribe/updateRoot) |
| `commitmentSignature` | `string` | Required | EIP-712 signature over the commitment |
| `allowanceMethod` | `string` | Required | `"eip2612-permit"`, `"permit2"`, or `"direct-approve"` |
| `bundledPermitSignature` | `string` | Conditional | Required if `allowanceMethod` is `"eip2612-permit"` or `"permit2"` |

### Cancel Action

```json
{
  "x402Version": 2,
  "accepted": { "scheme": "subscribe", "..." : "..." },
  "payload": {
    "action": "cancel",
    "subscriptionId": "0xabcdef...",
    "nonce": "12345",
    "signature": "0x..."
  }
}
```

Cancellation uses a client-chosen `nonce` for replay protection; the registry records used nonces.

## Active-Subscription Proof (Access Verification)

Once subscribed, clients present an active-subscription proof for subsequent requests without requiring new payments. The proof travels as the `subscription` extension in `PaymentPayload.extensions`.

The resource server verifies the proof by calling `isActive(subscriptionId)` on the on-chain registry. The extension info is a **pointer to verify**, never a trusted claim.

Full extension definition and field tables are in [`scheme_subscribe_evm.md`](./scheme_subscribe_evm.md).

## SettlementResponse Schema

### Initial Subscription Settlement

```json
{
  "success": true,
  "transaction": "0x1234567890abcdef...",
  "network": "eip155:8453",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "extra": {
    "subscriptionId": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    "tierId": "pro",
    "status": "active",
    "cursor": 0,
    "currentPeriodStart": "1740672089",
    "currentPeriodEnd": "1743264089",
    "expiry": "1772208089"
  }
}
```

### Charge Settlement

```json
{
  "success": true,
  "transaction": "0xabcdef1234567890...",
  "network": "eip155:8453",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "extra": {
    "subscriptionId": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    "tierId": "pro",
    "status": "active",
    "cursor": 3,
    "periodIndex": 3,
    "fee": "5000000",
    "currentPeriodStart": "1748448089",
    "currentPeriodEnd": "1751040089"
  }
}
```

## Verification

Facilitators and resource servers MUST perform the following verification steps:

### Subscription Initiation Verification

1. **Commitment Signature**: Verify the EIP-712 signature over `commitment` recovers to `commitment.subscriber`
2. **Root Recomputation**: Verify the client-provided `root` matches a tree built from the advertised `subscriptionDetails`
3. **Parameter Binding**: Ensure `commitment.payTo`, `commitment.asset`, `commitment.registry`, `commitment.chainId` match the `PaymentRequirements`
4. **Allowance Check**: Verify sufficient allowance exists (or bundled permit is valid)
5. **Balance Verification**: Confirm the subscriber has sufficient token balance for at least the first period
6. **Tier Validation**: Confirm the selected `tierId` exists and is available

### Charge Verification (per period)

1. **Merkle Proof**: Verify the leaf `(periodIndex, fee, validFrom, validTo)` with the stored root
2. **Cursor Check**: Verify `periodIndex == cursor`
3. **Time Window**: Verify `validFrom <= block.timestamp <= validTo + gracePeriodSeconds`
4. **Fee Cap**: Verify `fee <= maxPerPeriod`
5. **Not Cancelled/Expired**: Verify `!cancelled && block.timestamp <= expiry`
6. **Balance/Allowance**: Verify sufficient funds for `transferFrom`

### Active-Subscription Proof Verification

1. **Registry Query**: Call `isActive(subscriptionId)` on-chain
2. **Tier Matching**: Confirm the tier grants access to the requested resource
3. **Rate Limit Check**: Verify subscriber hasn't exceeded tier rate limits

## Settlement

### Initial Subscription Settlement

1. Verify the EIP-712 commitment signature
2. If gasless allowance: execute the bundled EIP-2612 permit or Permit2 approval
3. Execute `subscribe(commitment, signature)` on the registry
4. Registry stores commitment, sets `cursor = 0`, records `start` and `expiry`
5. Optionally charge period 0 immediately (or defer to first `chargePeriod` call)
6. Return `SettlementResponse` with `subscriptionId`

### Periodic Charge Settlement

1. Facilitator constructs the Merkle proof for the current `periodIndex`
2. Execute `chargePeriod(subscriptionId, periodIndex, fee, validFrom, validTo, proof)` on the registry
3. Registry verifies proof, time window, cursor, fee cap; calls `transferFrom(subscriber, payTo, fee)`
4. Registry increments `cursor`
5. Return `SettlementResponse` with updated status

### Grace Period Handling

If `chargePeriod` fails (insufficient balance/allowance):

1. Registry enters grace state: `inGracePeriod = true`, `gracePeriodEnd = validTo + gracePeriodSeconds`
2. Access continues during grace period
3. A successful charge within grace restores active status
4. If `block.timestamp > gracePeriodEnd` without successful charge, subscription becomes inactive

### Cancellation

1. Client signs `{ subscriptionId, nonce }` (replay-protected by client-chosen nonce)
2. Facilitator submits `cancel(subscriptionId, nonce, signature)` to registry
3. Registry verifies signature, records `cancelled = true`, stores used nonce
4. Access continues until current period ends (for `end_of_cycle` policy)
5. All future `chargePeriod` calls revert

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

| Cycle | Seconds | Description |
|-------|---------|-------------|
| `daily` | 86400 | 24 hours |
| `weekly` | 604800 | 7 days |
| `monthly` | 2592000 | 30 days |
| `annual` | 31536000 | 365 days |
| `custom` | (variable) | Custom duration |

### Error Codes

Error codes follow the V2 `invalid_<scheme>_<detail>` naming convention where applicable.

| Error Code | Description |
|------------|-------------|
| `invalid_subscribe_commitment` | Commitment signature invalid or parameter mismatch |
| `invalid_subscribe_proof` | Merkle proof does not verify against stored root |
| `invalid_subscribe_cursor` | periodIndex does not match current cursor |
| `invalid_subscribe_window` | Charge attempted outside chargeable window [validFrom, validTo + gracePeriodSeconds] |
| `invalid_subscribe_fee` | fee exceeds maxPerPeriod |
| `subscription_not_found` | No subscription for the given subscriptionId |
| `subscription_expired` | Subscription has passed its expiry timestamp |
| `subscription_cancelled` | Subscription was cancelled |
| `charge_failed` | Periodic charge failed (insufficient funds/allowance) |
| `tier_not_available` | Requested tier is not currently available |
| `rate_limit_exceeded` | Subscriber exceeded tier rate limits |
| `grace_period_expired` | Grace period ended without successful charge |

### Network-Specific Implementation

Network-specific rules and implementation details are defined in the per-network scheme documents:

- EVM chains: See [`scheme_subscribe_evm.md`](./scheme_subscribe_evm.md)

### References

- [EIP-712: Typed Structured Data Hashing and Signing](https://eips.ethereum.org/EIPS/eip-712)
- [EIP-2612: Permit Extension for ERC-20](https://eips.ethereum.org/EIPS/eip-2612)
- [OpenZeppelin MerkleProof](https://docs.openzeppelin.com/contracts/4.x/api/utils#MerkleProof)
- [Permit2 Documentation](https://docs.uniswap.org/contracts/permit2/overview)
- [x402 Protocol Specification](../../x402-specification-v2.md)
- [Exact Scheme Specification](../exact/scheme_exact.md)
- [Upto Scheme Specification](../upto/scheme_upto.md)
