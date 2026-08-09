# Scheme: `subscribe` on `EVM`

## Summary

The `subscribe` scheme on EVM enables recurring subscription-based payments where the Facilitator pays gas costs while subscribers control the exact flow of funds via a single cryptographic commitment over an entire billing schedule.

This is implemented via three components:

| Component | Purpose |
|:----------|:--------|
| **1. Schedule Commitment** | Client signs ONE EIP-712 commitment binding a Merkle root of the billing schedule |
| **2. Standing Allowance** | Client grants ERC-20 allowance to the registry (gaslessly via EIP-2612 permit, or direct approve) |
| **3. Subscription Registry** | Immutable on-chain contract enforcing commitment, cursor, cap, time windows, and pause |

The client signs once; the facilitator submits periodic charges with Merkle proofs. The registry enforces all safety invariants — the facilitator cannot overcharge, charge early/late, or redirect funds.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         SUBSCRIBE SCHEME - EVM ARCHITECTURE                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   ┌──────────┐         ┌──────────────┐         ┌────────────────────┐          │
│   │  CLIENT  │────────▶│  FACILITATOR │────────▶│  x402Subscription  │          │
│   │          │         │              │         │     Registry       │          │
│   └──────────┘         └──────────────┘         └────────────────────┘          │
│        │                      │                          │                       │
│        │ Signs EIP-712        │ Maintains tree           │ Immutable contract    │
│        │ commitment +         │ off-chain; submits       │ enforces: commitment, │
│        │ allowance permit     │ charges with proofs      │ cursor, cap, windows  │
│        │                      │                          │                       │
│        ▼                      ▼                          ▼                       │
│   ┌──────────┐         ┌──────────────┐         ┌────────────────────┐          │
│   │  WALLET  │         │  ERC-20      │◀────────│  transferFrom()    │          │
│   │          │         │  (any token) │         │  on each charge    │          │
│   └──────────┘         └──────────────┘         └────────────────────┘          │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Role Responsibilities

| Role | Responsibility |
|:-----|:---------------|
| **Client** | Builds Merkle tree from advertised terms; signs EIP-712 commitment over `{root, subscriber, asset, payTo, registry, chainId, tierId, start, expiry, maxPerPeriod}`; grants standing ERC-20 allowance to registry (gaslessly via EIP-2612 permit where supported, or direct approve) |
| **Facilitator** | Maintains the Merkle tree and proofs off-chain; submits `subscribe()` with commitment + allowance signature; submits `chargePeriod()` with Merkle proofs at each billing boundary; trusted for **liveness only** |
| **Registry** | Immutable on-chain contract; verifies EIP-712 commitment signature; enforces monotonic cursor, per-period cap (`fee <= maxPerPeriod`), time windows (`validFrom <= now <= validTo`), expiry, and cancel; calls `transferFrom(subscriber, payTo, fee)` on success |
| **Token** | Any ERC-20; EIP-2612 support enables gasless allowance approval |

---

## 2. Allowance Establishment Methods

The client must grant the `x402SubscriptionRegistry` contract an ERC-20 allowance covering the total committed spend. V1 supports two methods:

### 2.1 EIP-2612 Permit (Recommended)

For tokens supporting EIP-2612 (including USDC on Base), the client signs a `permit` authorizing the registry to spend tokens. The facilitator submits this signature bundled with `subscribe()`, making the flow gasless for the client.

**EIP-712 Domain (token contract):**

```javascript
const permitDomain = {
  name: "USD Coin",      // Token name
  version: "2",          // Token version
  chainId: 8453,         // Base mainnet
  verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" // USDC
};
```

**Permit Types:**

```javascript
const permitTypes = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
};
```

The `spender` is the `x402SubscriptionRegistry` address. The `value` SHOULD equal the total committed spend (sum of all period fees), making the allowance itself an on-chain aggregate cap.

### 2.2 Direct Approve (Non-Gasless Fallback)

For tokens without EIP-2612 support, the client submits a standard `ERC20.approve(registry, amount)` transaction directly, paying their own gas. The client must complete this approval before the facilitator can call `subscribe()`.

### 2.3 Future Work: Permit2 Funding (Non-Normative)

> Permit2 support is deferred to a future version. The correct approach would use **AllowanceTransfer** (specifically `PermitSingle`) to grant the registry spend permission through Permit2 — NOT SignatureTransfer with a witness, which is single-use and unsuitable for recurring charges. This requires a second pull path (`PERMIT2.transferFrom`) in the registry contract. Permit2 funding can be added later as a registry variant without changing the scheme semantics.

---

## 3. EIP-712 Commitment Structure

The client signs a single EIP-712 typed data structure that binds the entire subscription:

### 3.1 EIP-712 Domain (Registry Contract)

```javascript
const commitmentDomain = {
  name: "x402SubscriptionRegistry",
  version: "1",
  chainId: 8453,
  verifyingContract: "0x402SubscriptionRegistryAddress" // Registry address
};
```

### 3.2 Commitment Types

```javascript
const commitmentTypes = {
  SubscriptionCommitment: [
    { name: "root", type: "bytes32" },
    { name: "subscriber", type: "address" },
    { name: "asset", type: "address" },
    { name: "payTo", type: "address" },
    { name: "registry", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "tierId", type: "string" },
    { name: "start", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "maxPerPeriod", type: "uint256" },
    { name: "gracePeriodSeconds", type: "uint256" }
  ]
};
```

### 3.3 Commitment Fields

| Field | Type | Description |
|:------|:-----|:------------|
| `root` | `bytes32` | Merkle root of the billing schedule (client MUST recompute, never blind-sign) |
| `subscriber` | `address` | Address that will be charged (signs the commitment) |
| `asset` | `address` | ERC-20 token contract address |
| `payTo` | `address` | Recipient address for all charges |
| `registry` | `address` | The `x402SubscriptionRegistry` contract address |
| `chainId` | `uint256` | EVM chain ID (prevents cross-chain replay) |
| `tierId` | `string` | Subscription tier identifier |
| `start` | `uint256` | Unix timestamp when subscription begins |
| `expiry` | `uint256` | Unix timestamp after which no charges are valid |
| `maxPerPeriod` | `uint256` | Maximum fee per charge (safety cap) |
| `gracePeriodSeconds` | `uint256` | Retry window after `validTo` for failed charges |

The `subscriptionId` is derived as `keccak256(abi.encode(commitmentStructHash))`, binding all parameters in one identifier.

---

## 4. PaymentPayload Structure

### 4.1 Subscribe Action

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
      "maxPerPeriod": "5000000",
      "gracePeriodSeconds": "86400"
    },
    "commitmentSignature": "0x...",
    "allowanceMethod": "eip2612-permit",
    "allowanceSignature": "0x...",
    "schedule": [
      { "periodIndex": 0, "fee": "5000000", "validFrom": "1740672089", "validTo": "1743350489" },
      { "periodIndex": 1, "fee": "5000000", "validFrom": "1743264089", "validTo": "1745942489" },
      { "periodIndex": 2, "fee": "5000000", "validFrom": "1745856089", "validTo": "1748534489" }
    ]
  }
}
```

**Note:** The `schedule` array is transported so the facilitator can rebuild the Merkle tree and generate proofs. The `root` in the signed commitment is what cryptographically binds it — the facilitator cannot alter the schedule without invalidating the signature.

### 4.2 Subscribe Payload Fields

| Field | Type | Required | Description |
|:------|:-----|:---------|:------------|
| `action` | `string` | Required | `"subscribe"` for new subscriptions |
| `commitment` | `object` | Required | The EIP-712 commitment struct |
| `commitmentSignature` | `string` | Required | EIP-712 signature over the commitment (65 bytes, hex) |
| `allowanceMethod` | `string` | Required | `"eip2612-permit"` or `"direct-approve"` |
| `allowanceSignature` | `string` | Conditional | Required if `allowanceMethod` is `"eip2612-permit"` |
| `schedule` | `array` | Required | Array of `{periodIndex, fee, validFrom, validTo}` objects |

### 4.3 Schedule Leaf Structure

Each element in the `schedule` array represents one billing period:

| Field | Type | Description |
|:------|:-----|:------------|
| `periodIndex` | `number` | Zero-indexed billing period number |
| `fee` | `string` | Amount to charge for this period (in token atomic units) |
| `validFrom` | `string` | Unix timestamp when this period's charge becomes valid |
| `validTo` | `string` | Unix timestamp when this period's charge expires (includes grace) |

The Merkle leaf is computed as: `keccak256(keccak256(abi.encode(periodIndex, fee, validFrom, validTo)))` (OpenZeppelin double-hash convention).

### 4.4 Renewal Within Committed Schedule

**Renewal is NOT a client action within a committed schedule.** Once the client signs a commitment covering N periods, the facilitator submits `chargePeriod()` for each period using the stored Merkle proofs. No new client signature is needed until the schedule expires or the client wishes to change tiers.

### 4.5 Cancel Action

To cancel a subscription, the client signs a cancellation request with replay protection:

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "subscribe",
    "network": "eip155:8453",
    "amount": "5000000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 300,
    "extra": {
      "registry": "0x402SubscriptionRegistryAddress",
      "subscriptionDetails": { "tierId": "pro" }
    }
  },
  "payload": {
    "action": "cancel",
    "subscriptionId": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    "subscriber": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    "nonce": "12345",
    "signature": "0x..."
  }
}
```

**Cancel Payload Fields:**

| Field | Type | Required | Description |
|:------|:-----|:---------|:------------|
| `action` | `string` | Required | `"cancel"` |
| `subscriptionId` | `string` | Required | The subscription to cancel (bytes32, hex) |
| `subscriber` | `string` | Required | Subscriber address (must match commitment) |
| `nonce` | `string` | Required | Client-chosen nonce for replay protection |
| `signature` | `string` | Required | EIP-712 signature over `{subscriptionId, nonce}` |

The registry records used nonces; resubmitting the same `(subscriptionId, nonce)` pair reverts.

### 4.6 Update-Root Action (Tier Change / Re-commitment)

To change tiers, extend a subscription, or modify the schedule, the client signs a new commitment:

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "subscribe",
    "network": "eip155:8453",
    "amount": "10000000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 300,
    "extra": {
      "registry": "0x402SubscriptionRegistryAddress",
      "subscriptionDetails": {
        "tierId": "enterprise",
        "tierName": "Enterprise Plan",
        "billingCycle": "monthly",
        "billingCycleSeconds": 2592000,
        "periodCount": 12
      }
    }
  },
  "payload": {
    "action": "update-root",
    "previousSubscriptionId": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    "commitment": {
      "root": "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
      "subscriber": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "registry": "0x402SubscriptionRegistryAddress",
      "chainId": 8453,
      "tierId": "enterprise",
      "start": "1772208089",
      "expiry": "1803744089",
      "maxPerPeriod": "10000000"
    },
    "commitmentSignature": "0x...",
    "allowanceMethod": "eip2612-permit",
    "allowanceSignature": "0x...",
    "schedule": [
      { "periodIndex": 0, "fee": "10000000", "validFrom": "1772208089", "validTo": "1774886489" }
    ]
  }
}
```

**Update-Root Payload Fields:**

| Field | Type | Required | Description |
|:------|:-----|:---------|:------------|
| `action` | `string` | Required | `"update-root"` |
| `previousSubscriptionId` | `string` | Optional | Links to previous subscription (for tier migration) |
| `commitment` | `object` | Required | New EIP-712 commitment struct |
| `commitmentSignature` | `string` | Required | EIP-712 signature over the new commitment |
| `allowanceMethod` | `string` | Required | How allowance is established for new schedule |
| `allowanceSignature` | `string` | Conditional | Required if gasless allowance method |
| `schedule` | `array` | Required | New billing schedule |

---

## 5. `extra` Field Reference

### 5.1 Fields in `PaymentRequirements.extra`

| Field | Type | Required | Description |
|:------|:-----|:---------|:------------|
| `name` | `string` | Conditional | EIP-712 domain name of the token. Required for EIP-2612 permit. |
| `version` | `string` | Conditional | EIP-712 domain version of the token. Required for EIP-2612 permit. |
| `registry` | `string` | Required | Address of the `x402SubscriptionRegistry` contract. |
| `subscriptionDetails` | `object` | Required | Subscription tier configuration (see below). |

### 5.2 Fields in `subscriptionDetails`

| Field | Type | Required | Description |
|:------|:-----|:---------|:------------|
| `tierId` | `string` | Required | Unique identifier for the subscription tier. |
| `tierName` | `string` | Required | Human-readable name for the tier. |
| `billingCycle` | `string` | Required | `"daily"`, `"weekly"`, `"monthly"`, `"annual"`, or `"custom"`. |
| `billingCycleSeconds` | `number` | Required | Duration of billing cycle in seconds. |
| `periodCount` | `number` | Required | Number of billing periods in the subscription term. |
| `features` | `array` | Optional | List of features included in this tier. |
| `rateLimits` | `object` | Optional | Rate limiting configuration for this tier. |
| `gracePeriodSeconds` | `number` | Optional | Time after a failed charge during which access continues. |
| `cancellationPolicy` | `string` | Required | `"immediate"` or `"end_of_cycle"`. |
| `trialPeriodSeconds` | `number` | Optional | Duration of free trial period (if applicable). |

---

## 6. Subscription Extension (Access Verification)

Once subscribed, clients present an active-subscription proof for subsequent requests without requiring new payments. The proof travels as the `subscription` extension in `PaymentPayload.extensions`, following the V2 extension pattern (see `payment-identifier` for reference).

### 6.1 Extension Key

```
subscription
```

### 6.2 Extension Info Structure

```json
{
  "extensions": {
    "subscription": {
      "info": {
        "subscriptionId": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        "subscriber": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        "network": "eip155:8453"
      }
    }
  }
}
```

### 6.3 Verification

The resource server verifies the proof by calling `isActive(subscriptionId)` on the on-chain registry. The extension info is a **pointer to verify**, never a trusted claim.

```javascript
const isValid = await registry.isActive(subscriptionId);
if (!isValid) {
  return { status: 402, error: "subscription_not_found" };
}
```

---

## 7. Verification Logic

### 7.1 Subscribe Verification

The facilitator MUST perform these checks in order:

1. **Verify** the `commitmentSignature` is valid and recovers to `commitment.subscriber`

2. **Verify** the Merkle root:
   - Rebuild the tree from the `schedule` array
   - Confirm the computed root matches `commitment.root`

3. **Verify** commitment parameters match `PaymentRequirements`:
   - `commitment.asset` == `accepted.asset`
   - `commitment.payTo` == `accepted.payTo`
   - `commitment.registry` == `accepted.extra.registry`
   - `commitment.chainId` == chain ID from `accepted.network`
   - `commitment.tierId` == `accepted.extra.subscriptionDetails.tierId`

4. **Verify** allowance:
   - If `allowanceMethod` is `"eip2612-permit"`: validate permit signature
   - If `allowanceMethod` is `"direct-approve"`: confirm on-chain allowance exists
   - Confirm allowance >= total committed spend

5. **Verify** the subscriber has sufficient balance for at least the first period

6. **Simulate** the `subscribe()` call on the registry

### 7.2 Charge Verification (Facilitator-side, per period)

Before calling `chargePeriod()`:

1. **Construct** Merkle proof for the current `periodIndex`
2. **Verify** `periodIndex == cursor` (monotonic)
3. **Verify** `validFrom <= block.timestamp <= validTo`
4. **Verify** `fee <= maxPerPeriod`
5. **Verify** `!cancelled && block.timestamp <= expiry`
6. **Verify** subscriber has sufficient balance and allowance

### 7.3 Cancel Verification

1. **Verify** the `signature` over `{subscriptionId, nonce}` recovers to `subscriber`
2. **Verify** `nonce` has not been used before
3. **Verify** subscription exists and is not already cancelled

---

## 8. Settlement Logic

### 8.1 Subscribe Settlement

```solidity
// 1. If gasless allowance, execute permit first
if (allowanceMethod == "eip2612-permit") {
    IERC20Permit(asset).permit(subscriber, registry, totalAmount, deadline, v, r, s);
}

// 2. Execute subscribe on registry
bytes32 subscriptionId = registry.subscribe(commitment, commitmentSignature);

// 3. Optionally charge period 0 immediately
registry.chargePeriod(subscriptionId, 0, fee, validFrom, validTo, proof);
```

### 8.2 Periodic Charge Settlement

```solidity
// Facilitator calls at each billing boundary
registry.chargePeriod(
    subscriptionId,
    periodIndex,
    fee,
    validFrom,
    validTo,
    merkleProof
);

// Registry internally:
// 1. Verifies Merkle proof
// 2. Checks periodIndex == cursor
// 3. Checks validFrom <= now <= validTo
// 4. Checks fee <= maxPerPeriod
// 5. Checks !cancelled && now <= expiry
// 6. Calls transferFrom(subscriber, payTo, fee)
// 7. Increments cursor
```

### 8.3 Grace Period Handling

If `chargePeriod` fails due to insufficient balance/allowance:

1. Registry enters grace state: `inGracePeriod = true`
2. `gracePeriodEnd = validTo + gracePeriodSeconds`
3. Access continues during grace period
4. A successful charge within grace restores active status
5. If `block.timestamp > gracePeriodEnd` without successful charge, `isActive()` returns false

### 8.4 Cancellation Settlement

```solidity
registry.cancel(subscriptionId, nonce, signature);

// Registry internally:
// 1. Verifies signature recovers to subscriber
// 2. Checks nonce not used
// 3. Records cancelled = true
// 4. Stores nonce as used
// 5. All future chargePeriod calls revert
```

---

## 9. Reference Implementation: `x402SubscriptionRegistry`

This contract manages subscription state on-chain for trustless verification. It is the **canonical reference implementation**; production deployments will use CREATE2 for deterministic addresses across networks.

### 9.1 Immutability Guarantees

The `x402SubscriptionRegistry` is designed as an **immutable, non-upgradeable contract**:

- **No proxy pattern**: The contract is deployed directly, not behind a proxy.
- **No upgrade path**: There is no mechanism to replace or modify the contract logic.
- **No owner over fund logic**: No administrative function can redirect payments, modify stored commitments, or alter fund flows.
- **No selfdestruct/delegatecall**: The contract cannot be destroyed or delegate execution to arbitrary code.
- **Guardian pause is narrowly scoped**: The sole intervention mechanism is `pause()`/`unpause()`, which ONLY blocks `chargePeriod()`. The guardian cannot move funds, change terms, or redirect payments.

### 9.2 Design Rationale: Why No Stored Pre-Signed Authorizations

Earlier drafts stored `renewalAuthorizations[]` — pre-signed EIP-3009 or Permit2 signatures for future billing cycles. This approach was removed because:

**Public signatures are directly submittable.** Once a pre-signed `transferWithAuthorization` signature is stored on-chain (or even transmitted to the facilitator), anyone can extract and submit it directly to the token contract. This creates a race condition where the registry's state (cursor, subscription status) can desync from actual token transfers. The Merkle schedule commitment model avoids this by having the registry itself call `transferFrom` — the subscriber's allowance to the registry is the only authorization, and the registry enforces all invariants before pulling funds.

### 9.3 Migration Note: Commitment Signature Verification

The previous draft's `SubscribeParams.signature` field was **never verified** against the commitment terms — the contract accepted any signature without checking it recovered to the subscriber or bound the advertised parameters. This implementation **fixes that flaw**: `subscribe()` verifies the EIP-712 commitment signature recovers to `commitment.subscriber`, and the `subscriptionId` is derived deterministically from the commitment struct hash, cryptographically binding all terms.

**gracePeriodSeconds is now client-signed.** The grace period extends the chargeable window to `[validFrom, validTo + gracePeriodSeconds]`, allowing retries on failed charges. Since this affects fund exposure (how long the registry can attempt charges), it is a fund-relevant term and must be signed by the client as part of the commitment.

### 9.4 Contract Implementation

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title x402SubscriptionRegistry
 * @notice Immutable on-chain registry for x402 subscribe scheme.
 * @dev Reference implementation — canonical deployments TBD via CREATE2.
 *
 * IMMUTABILITY INVARIANTS:
 * - No proxy, no upgrade path, no selfdestruct, no delegatecall.
 * - Guardian pause() ONLY blocks chargePeriod(); it CANNOT move funds,
 *   change stored terms, or redirect payments.
 * - No administrative function can modify commitments after storage.
 */
contract x402SubscriptionRegistry is EIP712, ReentrancyGuard {
    using ECDSA for bytes32;

    // ============ Constants ============

    bytes32 public constant COMMITMENT_TYPEHASH = keccak256(
        "SubscriptionCommitment(bytes32 root,address subscriber,address asset,address payTo,address registry,uint256 chainId,string tierId,uint256 start,uint256 expiry,uint256 maxPerPeriod,uint256 gracePeriodSeconds)"
    );

    bytes32 public constant CANCELLATION_TYPEHASH = keccak256(
        "CancelSubscription(bytes32 subscriptionId,uint256 nonce)"
    );

    // ============ Structs ============

    struct Commitment {
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

    struct Leaf {
        uint256 periodIndex;
        uint256 fee;
        uint256 validFrom;
        uint256 validTo;
    }

    struct Subscription {
        bytes32 root;
        address subscriber;
        address asset;
        address payTo;
        string tierId;
        uint256 start;
        uint256 expiry;
        uint256 maxPerPeriod;
        uint256 gracePeriodSeconds;
        uint256 cursor;
        bool cancelled;
        bool inGracePeriod;
        uint256 gracePeriodEnd;
    }

    // ============ State ============

    /// @notice Guardian address authorized to pause/unpause chargePeriod.
    /// @dev Immutable; recommend setting to a timelock contract.
    address public immutable guardian;

    /// @notice Whether chargePeriod is paused.
    bool public paused;

    /// @notice Subscription storage by subscriptionId.
    mapping(bytes32 => Subscription) public subscriptions;

    /// @notice Replay protection for cancellation nonces.
    /// @dev subscriptionId => nonce => used
    mapping(bytes32 => mapping(uint256 => bool)) public usedCancelNonces;

    // ============ Events ============

    event SubscriptionCreated(
        bytes32 indexed subscriptionId,
        address indexed subscriber,
        address indexed payTo,
        string tierId,
        uint256 expiry
    );

    event PeriodCharged(
        bytes32 indexed subscriptionId,
        uint256 indexed periodIndex,
        uint256 fee,
        address indexed chargedBy
    );

    event ChargeFailed(
        bytes32 indexed subscriptionId,
        uint256 indexed periodIndex,
        string reason
    );

    event GracePeriodEntered(
        bytes32 indexed subscriptionId,
        uint256 gracePeriodEnd
    );

    event GracePeriodCleared(bytes32 indexed subscriptionId);

    event SubscriptionCancelled(
        bytes32 indexed subscriptionId,
        uint256 accessEndsAt
    );

    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // ============ Errors ============

    error InvalidCommitmentSignature();
    error SubscriptionAlreadyExists();
    error SubscriptionNotFound();
    error SubscriptionCancelled();
    error SubscriptionExpired();
    error ChargePaused();
    error InvalidPeriodIndex();
    error ChargeWindowNotOpen();
    error ChargeWindowExpired();
    error FeeExceedsMax();
    error InvalidMerkleProof();
    error CancelNonceUsed();
    error InvalidCancelSignature();
    error NotGuardian();
    error InvalidRegistry();
    error InvalidChainId();
    error AssetNotContract();

    // ============ Modifiers ============

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ChargePaused();
        _;
    }

    // ============ Constructor ============

    /// @param _guardian Address authorized to pause/unpause. Recommend a timelock.
    constructor(address _guardian) EIP712("x402SubscriptionRegistry", "1") {
        guardian = _guardian;
    }

    // ============ External Functions ============

    /**
     * @notice Create a new subscription from a signed commitment.
     * @dev subscribe() may register during pause but must not move funds.
     *      If initialProof is provided while paused, reverts ChargePaused.
     * @param commitment The subscription commitment struct (includes gracePeriodSeconds).
     * @param signature EIP-712 signature over the commitment, by commitment.subscriber.
     * @param initialLeaf Optional: leaf for period 0 to charge immediately.
     * @param initialProof Optional: Merkle proof for initialLeaf.
     * @return subscriptionId The unique subscription identifier.
     */
    function subscribe(
        Commitment calldata commitment,
        bytes calldata signature,
        Leaf calldata initialLeaf,
        bytes32[] calldata initialProof
    ) external nonReentrant returns (bytes32 subscriptionId) {
        // Validate commitment binds to this registry and chain
        if (commitment.registry != address(this)) revert InvalidRegistry();
        if (commitment.chainId != block.chainid) revert InvalidChainId();

        // Prevent free-subscription attack via EOA asset: a low-level call to a
        // codeless address returns success with empty data, which _safeTransferFrom
        // would misread as a USDT-style successful transfer. Checked once at registration.
        if (commitment.asset.code.length == 0) revert AssetNotContract();

        // Derive subscriptionId from commitment struct hash
        bytes32 structHash = _hashCommitment(commitment);
        subscriptionId = structHash;

        // Verify EIP-712 signature recovers to commitment.subscriber
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        if (signer != commitment.subscriber) revert InvalidCommitmentSignature();

        // Reject duplicates
        if (subscriptions[subscriptionId].subscriber != address(0)) {
            revert SubscriptionAlreadyExists();
        }

        // Store subscription (gracePeriodSeconds from signed commitment)
        subscriptions[subscriptionId] = Subscription({
            root: commitment.root,
            subscriber: commitment.subscriber,
            asset: commitment.asset,
            payTo: commitment.payTo,
            tierId: commitment.tierId,
            start: commitment.start,
            expiry: commitment.expiry,
            maxPerPeriod: commitment.maxPerPeriod,
            gracePeriodSeconds: commitment.gracePeriodSeconds,
            cursor: 0,
            cancelled: false,
            inGracePeriod: false,
            gracePeriodEnd: 0
        });

        emit SubscriptionCreated(
            subscriptionId,
            commitment.subscriber,
            commitment.payTo,
            commitment.tierId,
            commitment.expiry
        );

        // Optionally charge period 0 immediately (respects pause via _chargePeriod)
        if (initialProof.length > 0) {
            _chargePeriod(subscriptionId, initialLeaf, initialProof);
        }

        return subscriptionId;
    }

    /**
     * @notice Charge a billing period. PERMISSIONLESS — anyone can call.
     * @dev The facilitator typically calls this, but permissionless design ensures
     *      liveness is not dependent on a single operator. Pause check is in _chargePeriod.
     * @param subscriptionId The subscription to charge.
     * @param leaf The billing period leaf (periodIndex, fee, validFrom, validTo).
     * @param proof Merkle proof for the leaf against the stored root.
     */
    function chargePeriod(
        bytes32 subscriptionId,
        Leaf calldata leaf,
        bytes32[] calldata proof
    ) external nonReentrant {
        _chargePeriod(subscriptionId, leaf, proof);
    }

    /**
     * @notice Cancel a subscription. Halts all future charges.
     * @param subscriptionId The subscription to cancel.
     * @param nonce Signer-chosen nonce for replay protection.
     * @param signature EIP-712 signature over CancelSubscription(subscriptionId, nonce).
     */
    function cancel(
        bytes32 subscriptionId,
        uint256 nonce,
        bytes calldata signature
    ) external nonReentrant {
        Subscription storage sub = subscriptions[subscriptionId];
        if (sub.subscriber == address(0)) revert SubscriptionNotFound();
        if (sub.cancelled) revert SubscriptionCancelled();

        // Check nonce not used
        if (usedCancelNonces[subscriptionId][nonce]) revert CancelNonceUsed();

        // Verify EIP-712 signature
        // NOTE: nonce is signer-chosen, NOT block.timestamp — this fixes the
        // previous draft's broken cancellation verification where timestamp
        // was included in the signed struct but was unpredictable at sign time.
        bytes32 structHash = keccak256(abi.encode(
            CANCELLATION_TYPEHASH,
            subscriptionId,
            nonce
        ));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        if (signer != sub.subscriber) revert InvalidCancelSignature();

        // Record nonce as used
        usedCancelNonces[subscriptionId][nonce] = true;

        // Mark cancelled
        sub.cancelled = true;

        // Access continues until current period ends (per cancellationPolicy)
        // The exact semantics depend on off-chain interpretation; on-chain,
        // isActive() will return true until the current period's validTo.
        emit SubscriptionCancelled(subscriptionId, sub.expiry);
    }

    /**
     * @notice Replace a subscription with a new commitment (tier change, extension).
     * @dev The old subscription is cancelled; a new subscriptionId is derived from
     *      the new commitment. Cursor resets to 0 for the new schedule.
     * @param oldSubscriptionId The subscription being replaced.
     * @param newCommitment The new commitment struct (includes gracePeriodSeconds).
     * @param signature EIP-712 signature over newCommitment, by newCommitment.subscriber.
     * @return newSubscriptionId The new subscription identifier.
     */
    function updateRoot(
        bytes32 oldSubscriptionId,
        Commitment calldata newCommitment,
        bytes calldata signature
    ) external nonReentrant returns (bytes32 newSubscriptionId) {
        // Validate old subscription exists and belongs to the same subscriber
        Subscription storage oldSub = subscriptions[oldSubscriptionId];
        if (oldSub.subscriber == address(0)) revert SubscriptionNotFound();
        if (oldSub.subscriber != newCommitment.subscriber) {
            revert InvalidCommitmentSignature(); // subscriber mismatch
        }

        // Cancel the old subscription
        if (!oldSub.cancelled) {
            oldSub.cancelled = true;
            emit SubscriptionCancelled(oldSubscriptionId, block.timestamp);
        }

        // Create new subscription via full commitment verification
        // Cursor resets to 0; new periodIndex space starts fresh
        Leaf memory emptyLeaf;
        bytes32[] memory emptyProof;
        newSubscriptionId = this.subscribe(
            newCommitment,
            signature,
            emptyLeaf,
            emptyProof
        );

        return newSubscriptionId;
    }

    // ============ Guardian Functions ============

    /**
     * @notice Pause chargePeriod. Guardian-only.
     * @dev INVARIANT: pause() ONLY blocks chargePeriod. It CANNOT:
     *      - Move funds
     *      - Change any stored commitment or subscription terms
     *      - Redirect payments
     *      - Affect subscribe(), cancel(), or view functions
     */
    function pause() external onlyGuardian {
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Unpause chargePeriod. Guardian-only.
     */
    function unpause() external onlyGuardian {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ============ View Functions ============

    /**
     * @notice Check if a subscription is currently active.
     * @param subscriptionId The subscription to check.
     * @return active True if subscription grants access.
     */
    function isActive(bytes32 subscriptionId) external view returns (bool active) {
        Subscription storage sub = subscriptions[subscriptionId];

        // Not found
        if (sub.subscriber == address(0)) {
            return false;
        }

        // Cancelled and past expiry
        if (sub.cancelled && block.timestamp >= sub.expiry) {
            return false;
        }

        // In grace period — check if grace has expired
        if (sub.inGracePeriod) {
            return block.timestamp < sub.gracePeriodEnd;
        }

        // Normal active check: not expired
        return block.timestamp <= sub.expiry;
    }

    /**
     * @notice Check if a subscriber has an active subscription.
     * @param subscriber The subscriber address.
     * @param subscriptionId The subscription to check.
     * @return active True if the subscription is active and belongs to subscriber.
     */
    function isActiveFor(
        address subscriber,
        bytes32 subscriptionId
    ) external view returns (bool active) {
        Subscription storage sub = subscriptions[subscriptionId];
        if (sub.subscriber != subscriber) {
            return false;
        }
        return this.isActive(subscriptionId);
    }

    /**
     * @notice Get full subscription details.
     * @param subscriptionId The subscription to query.
     * @return sub The subscription struct.
     */
    function getSubscription(
        bytes32 subscriptionId
    ) external view returns (Subscription memory sub) {
        return subscriptions[subscriptionId];
    }

    // ============ Internal Functions ============

    /**
     * @dev Internal charge logic with whenNotPaused check.
     *      Reentrancy is handled by nonReentrant on all external entry points.
     *
     * CURSOR SEMANTICS: cursor increments ONLY on successful transfer.
     * The chargeable window is [validFrom, validTo + gracePeriodSeconds] — the
     * grace period is a per-leaf retry buffer allowing failed charges to be retried
     * without advancing to the next period.
     */
    function _chargePeriod(
        bytes32 subscriptionId,
        Leaf calldata leaf,
        bytes32[] calldata proof
    ) internal whenNotPaused {
        Subscription storage sub = subscriptions[subscriptionId];

        // Existence check
        if (sub.subscriber == address(0)) revert SubscriptionNotFound();

        // Cancelled check
        if (sub.cancelled) revert SubscriptionCancelled();

        // Expiry check
        if (block.timestamp > sub.expiry) revert SubscriptionExpired();

        // Cursor check (monotonic, one settlement per period, in order)
        if (leaf.periodIndex != sub.cursor) revert InvalidPeriodIndex();

        // Time window check: chargeable window is [validFrom, validTo + gracePeriodSeconds]
        // The grace period extends the window to allow retries on failed charges.
        if (block.timestamp < leaf.validFrom) revert ChargeWindowNotOpen();
        if (block.timestamp > leaf.validTo + sub.gracePeriodSeconds) {
            revert ChargeWindowExpired();
        }

        // Fee cap check
        if (leaf.fee > sub.maxPerPeriod) revert FeeExceedsMax();

        // Merkle proof verification (OpenZeppelin double-hash convention)
        bytes32 leafHash = keccak256(bytes.concat(keccak256(abi.encode(
            leaf.periodIndex,
            leaf.fee,
            leaf.validFrom,
            leaf.validTo
        ))));
        if (!MerkleProof.verify(proof, sub.root, leafHash)) {
            revert InvalidMerkleProof();
        }

        // Attempt transfer (cursor increments ONLY on success)
        bool success = _safeTransferFrom(
            sub.asset,
            sub.subscriber,
            sub.payTo,
            leaf.fee
        );

        if (success) {
            // Increment cursor on success
            sub.cursor++;

            // Clear grace period if we were in one
            if (sub.inGracePeriod) {
                sub.inGracePeriod = false;
                sub.gracePeriodEnd = 0;
                emit GracePeriodCleared(subscriptionId);
            }

            emit PeriodCharged(subscriptionId, leaf.periodIndex, leaf.fee, msg.sender);
        } else {
            // On failure: cursor UNCHANGED, enter/remain in grace period
            // gracePeriodEnd is idempotent if already set
            if (!sub.inGracePeriod) {
                sub.inGracePeriod = true;
                sub.gracePeriodEnd = leaf.validTo + sub.gracePeriodSeconds;
                emit GracePeriodEntered(subscriptionId, sub.gracePeriodEnd);
            }

            emit ChargeFailed(subscriptionId, leaf.periodIndex, "transfer_failed");
        }
    }

    function _hashCommitment(
        Commitment calldata c
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            COMMITMENT_TYPEHASH,
            c.root,
            c.subscriber,
            c.asset,
            c.payTo,
            c.registry,
            c.chainId,
            keccak256(bytes(c.tierId)),
            c.start,
            c.expiry,
            c.maxPerPeriod,
            c.gracePeriodSeconds
        ));
    }

    /**
     * @dev Safe transferFrom with non-reverting bool semantics.
     *      Handles: call failure, returns-false tokens, no-return tokens (USDT).
     * @return success True if transfer succeeded, false otherwise (triggers grace period).
     */
    function _safeTransferFrom(
        address token,
        address from,
        address to,
        uint256 amount
    ) internal returns (bool success) {
        // Low-level call to handle tokens that don't return bool (e.g., USDT)
        (bool callSuccess, bytes memory data) = token.call(
            abi.encodeWithSelector(
                IERC20.transferFrom.selector,
                from,
                to,
                amount
            )
        );

        // Success requires:
        // 1. Call did not revert (callSuccess == true)
        // 2. Either no return data (USDT-style) OR exactly 32 bytes decoding to true
        // The exact length check prevents malformed return data from being misinterpreted.
        success = callSuccess && (data.length == 0 || (data.length == 32 && abi.decode(data, (bool))));
    }
}
```

### 9.5 Function Summary

| Function | Access | Description |
|:---------|:-------|:------------|
| `subscribe()` | Public | Create subscription from verified commitment; optionally charge period 0 |
| `chargePeriod()` | **Permissionless** | Charge a billing period with Merkle proof |
| `cancel()` | Public (subscriber signature) | Halt all future charges |
| `updateRoot()` | Public (subscriber signature) | Replace subscription with new commitment |
| `pause()` | Guardian only | Block `chargePeriod()` — fund-safe emergency stop |
| `unpause()` | Guardian only | Resume `chargePeriod()` |
| `isActive()` | View | Check subscription status (grace-aware) |
| `isActiveFor()` | View | Check status for specific subscriber |
| `getSubscription()` | View | Retrieve full subscription details |

### 9.6 Permissionless `chargePeriod` Design

`chargePeriod()` is **permissionless** — anyone can call it with a valid Merkle proof. This design choice ensures:

1. **Liveness independence**: If the facilitator goes offline, any third party (including the subscriber or payTo) can submit charges.
2. **No front-running advantage**: The charge either succeeds (funds move to `payTo`) or fails (grace period). There is no value to extract by front-running.
3. **MEV resistance**: The outcome is deterministic given the Merkle proof; reordering does not change who receives funds.

The facilitator remains the expected caller for convenience (they maintain the Merkle tree off-chain), but the system does not depend on facilitator honesty for correctness.

---

## 10. Facilitator API Extensions

Subscribe, cancel, and update-root operations flow through the standard `/verify` and `/settle` endpoints using the `action` field in the payload. Status queries are non-normative facilitator conveniences.

> **Note:** Full facilitator API documentation will be specified in a subsequent commit.

---

## 11. Security Considerations

### 11.1 Liveness vs. Safety Trust Model

The facilitator is trusted for **liveness only**:

- **Liveness**: The facilitator maintains the Merkle tree off-chain and submits `chargePeriod()` calls at billing boundaries. If the facilitator fails, charges don't happen — but `chargePeriod()` is permissionless, so any party (subscriber, payTo, third party) can submit valid proofs.
- **Safety**: The facilitator has no safety authority. It cannot overcharge (fee ≤ maxPerPeriod, fee matches Merkle leaf, cursor is monotonic), charge early (before validFrom), charge late (after validTo + gracePeriodSeconds), charge past expiry/cancel (hard on-chain checks), redirect funds (payTo/asset bound in commitment), or double-charge (cursor increments only on successful transfer).

**Facilitator compromise degrades to denial of service, never theft beyond the signed schedule.**

### 11.2 Replay Attack Prevention

- **Commitment uniqueness**: Each commitment produces a unique `subscriptionId` (the struct hash). Duplicate commitments are rejected.
- **Monotonic cursor**: `chargePeriod()` requires `periodIndex == cursor` and increments cursor on success. Each period can be charged at most once.
- **Cancellation nonces**: `cancel()` uses signer-chosen nonces recorded in a mapping. Each `(subscriptionId, nonce)` pair can only be used once.
- **Cross-chain protection**: The commitment binds `chainId`; replay on other chains fails.

### 11.3 Allowance Exposure

The subscriber grants a standing ERC-20 allowance to the registry. The worst-case exposure is bounded by:

1. **Allowance amount**: The subscriber controls the allowance; setting it equal to total committed spend caps total exposure.
2. **maxPerPeriod**: Each charge is capped regardless of the Merkle leaf claim.
3. **Merkle root binding**: Only leaves matching the signed root can be charged.
4. **Time windows**: Charges outside `validFrom..validTo` revert.
5. **Expiry**: No charges after `expiry` timestamp.

### 11.4 Guardian Pause Scope

The guardian can call `pause()` to halt `chargePeriod()` as an emergency measure (e.g., if a critical bug is discovered). The pause is **fund-safe**:

- Pause does NOT move funds
- Pause does NOT change stored commitments or subscription terms
- Pause does NOT redirect payments
- Pause does NOT affect `subscribe()`, `cancel()`, `updateRoot()`, or view functions

The guardian is recommended to be a timelock contract to prevent abuse.

### 11.5 Codeless Asset Attack Prevention

A low-level `call()` to an address with no bytecode (EOA or undeployed address) returns success with empty return data. This would be misinterpreted by `_safeTransferFrom` as a USDT-style successful transfer, allowing an attacker to register a "free subscription" by specifying a codeless `commitment.asset`.

**Mitigation:** `subscribe()` checks `commitment.asset.code.length == 0` and reverts with `AssetNotContract()` if true. This check is performed once at registration time; the asset cannot change afterward.

### 11.6 Return Data Hardening

The `_safeTransferFrom` function uses exact length checking for return data:

```solidity
success = callSuccess && (data.length == 0 || (data.length == 32 && abi.decode(data, (bool))));
```

This prevents malformed return data (e.g., non-32-byte responses from proxy contracts or hook-modified tokens) from being decoded as a boolean. Charges with unexpected return data are routed to the grace period path, allowing retry without permanently locking the period.

> **Note:** Additional analysis (MEV, frontrunning resistance, gas optimization) may be added in subsequent commits.

---

## Appendix

### Canonical Contract Addresses

| Contract | Address | Networks |
|:---------|:--------|:---------|
| `x402SubscriptionRegistry` | TBD (CREATE2 deployment) | All supported EVM |

### Supported Networks

| Network | Chain ID | CAIP-2 Identifier |
|:--------|:---------|:------------------|
| Base Mainnet | 8453 | `eip155:8453` |
| Base Sepolia | 84532 | `eip155:84532` |
| Ethereum | 1 | `eip155:1` |
| Arbitrum One | 42161 | `eip155:42161` |
| Optimism | 10 | `eip155:10` |
| Polygon | 137 | `eip155:137` |

### References

- [EIP-712: Typed Structured Data Hashing](https://eips.ethereum.org/EIPS/eip-712)
- [EIP-2612: Permit Extension for ERC-20](https://eips.ethereum.org/EIPS/eip-2612)
- [OpenZeppelin MerkleProof](https://docs.openzeppelin.com/contracts/4.x/api/utils#MerkleProof)
- [x402 Protocol Specification v2](../../x402-specification-v2.md)
- [Subscribe Scheme Overview](./scheme_subscribe.md)
