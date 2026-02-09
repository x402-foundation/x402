# Scheme: `subscribe` on `EVM`

## Summary

The `subscribe` scheme on EVM enables recurring subscription-based payments where the Facilitator pays gas costs while subscribers control the exact flow of funds via cryptographic signatures.

This is implemented via two components:

| Component                    | Purpose                                                                |
| :--------------------------- | :--------------------------------------------------------------------- |
| **1. Payment Authorization** | Uses EIP-3009 or Permit2 for each billing cycle payment                |
| **2. Subscription Registry** | On-chain or off-chain registry tracking subscription state and proofs  |

The scheme supports two subscription models:

| Model                        | Description                                                            | Recommendation                                    |
| :--------------------------- | :--------------------------------------------------------------------- | :------------------------------------------------ |
| **Pre-authorized Renewals**  | Client signs multiple future authorizations upfront                    | **Recommended** (Seamless auto-renewal)           |
| **On-demand Renewals**       | Client signs each renewal when prompted                                | **Flexible** (More control, requires interaction) |

In all cases, the Facilitator cannot modify amounts, recipients, or timing. They serve only as the transaction broadcaster and subscription state manager.

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
│        │ Signs EIP-3009       │ Broadcasts TX            │ Stores subscription   │
│        │ authorizations       │ Pays gas                 │ state on-chain        │
│        │                      │                          │                       │
│        ▼                      ▼                          ▼                       │
│   ┌──────────┐         ┌──────────────┐         ┌────────────────────┐          │
│   │  WALLET  │         │  ERC-20      │         │  RESOURCE SERVER   │          │
│   │          │         │  (USDC)      │         │                    │          │
│   └──────────┘         └──────────────┘         └────────────────────┘          │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Payment Authorization Methods

### 2.1 EIP-3009 (Recommended for USDC)

For tokens supporting `transferWithAuthorization`, each billing cycle payment uses a standard EIP-3009 signature.

**EIP-712 Domain:**

```javascript
const domain = {
  name: "USD Coin",      // Token name
  version: "2",          // Token version
  chainId: 8453,         // Base mainnet
  verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
};
```

**Authorization Types:**

```javascript
const subscribeAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" }
  ]
};
```

### 2.2 Permit2 (Universal Fallback)

For tokens without EIP-3009 support, use Permit2 with the x402SubscriptionProxy contract.

**Witness Type for Subscriptions:**

```javascript
const SUBSCRIPTION_WITNESS_TYPE_STRING =
  "SubscriptionWitness witness)SubscriptionWitness(address to,uint256 validAfter,bytes32 subscriptionId,uint256 cycleNumber,bytes extra)TokenPermissions(address token,uint256 amount)";

const SUBSCRIPTION_WITNESS_TYPEHASH = keccak256(
  "SubscriptionWitness(address to,uint256 validAfter,bytes32 subscriptionId,uint256 cycleNumber,bytes extra)"
);
```

---

## 3. PaymentPayload Structure

### 3.1 Initial Subscription (EIP-3009)

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
      "assetTransferMethod": "eip3009",
      "name": "USDC",
      "version": "2",
      "subscriptionDetails": {
        "tierId": "pro",
        "tierName": "Pro Plan",
        "billingCycle": "monthly",
        "billingCycleSeconds": 2592000,
        "renewalPolicy": "auto",
        "gracePeriodSeconds": 86400
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
      "nonce": "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480"
    },
    "subscriptionPayload": {
      "action": "subscribe",
      "tierId": "pro",
      "startTimestamp": "1740672089",
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
        }
      ]
    }
  }
}
```

### 3.2 Initial Subscription (Permit2)

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
      "assetTransferMethod": "permit2",
      "name": "USDC",
      "version": "2",
      "subscriptionDetails": {
        "tierId": "pro",
        "billingCycle": "monthly",
        "billingCycleSeconds": 2592000,
        "renewalPolicy": "auto"
      }
    }
  },
  "payload": {
    "signature": "0x...",
    "permit2Authorization": {
      "permitted": {
        "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "amount": "5000000"
      },
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "spender": "0x_x402SubscriptionProxyAddress",
      "nonce": "0x...",
      "deadline": "1743264089",
      "witness": {
        "to": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        "validAfter": "1740672089",
        "subscriptionId": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "cycleNumber": "1",
        "extra": "0x"
      }
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

### 3.3 Subscription Proof Header

For subsequent requests within an active subscription period:

**X-SUBSCRIPTION-PROOF Header (Base64 encoded):**

```json
{
  "subscriptionId": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "subscriber": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "tierId": "pro",
  "network": "eip155:8453",
  "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  "currentCycleNumber": 1,
  "currentCycleStart": "1740672089",
  "currentCycleEnd": "1743264089",
  "signature": "0x..."
}
```

**EIP-712 Subscription Proof Types:**

```javascript
const subscriptionProofTypes = {
  SubscriptionProof: [
    { name: "subscriptionId", type: "bytes32" },
    { name: "subscriber", type: "address" },
    { name: "tierId", type: "string" },
    { name: "payTo", type: "address" },
    { name: "currentCycleNumber", type: "uint256" },
    { name: "currentCycleStart", type: "uint256" },
    { name: "currentCycleEnd", type: "uint256" }
  ]
};
```

---

## 4. Verification Logic

### 4.1 Initial Subscription Verification

The facilitator MUST perform these checks in order:

1. **Verify** the `payload.signature` is valid and recovers to `authorization.from`

2. **Verify** the subscriber has sufficient balance of the `asset`:
   ```solidity
   require(IERC20(asset).balanceOf(from) >= amount, "insufficient_funds");
   ```

3. **Verify** the authorization parameters meet requirements:
   - `authorization.value` >= `accepted.amount`
   - `authorization.to` == `accepted.payTo`
   - `block.timestamp` >= `authorization.validAfter`
   - `block.timestamp` < `authorization.validBefore`

4. **Verify** the subscription details:
   - `tierId` is valid and available
   - `billingCycleSeconds` matches the tier configuration
   - `startTimestamp` is within acceptable range (not in distant past/future)

5. **Verify** renewal authorizations (if provided):
   - Each authorization has non-overlapping validity windows
   - Validity windows align with billing cycle boundaries
   - All authorizations are from the same `from` address

6. **Simulate** the transaction:
   ```solidity
   // For EIP-3009
   token.transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature);
   ```

### 4.2 Subscription Proof Verification

For requests with `X-SUBSCRIPTION-PROOF` header:

1. **Decode** the Base64 subscription proof

2. **Verify** the proof signature:
   ```javascript
   const recoveredAddress = ethers.verifyTypedData(
     domain,
     subscriptionProofTypes,
     proofData,
     proof.signature
   );
   require(recoveredAddress === proof.subscriber, "invalid_subscription_proof");
   ```

3. **Verify** subscription is active:
   - `block.timestamp` >= `currentCycleStart`
   - `block.timestamp` < `currentCycleEnd`
   - Subscription not cancelled

4. **Verify** payment was settled for current cycle:
   - Query on-chain registry OR
   - Verify against facilitator's off-chain records

5. **Verify** rate limits (if applicable):
   - Check subscriber hasn't exceeded tier limits

### 4.3 Renewal Verification

When processing automatic renewals:

1. **Verify** the renewal authorization matches the expected cycle:
   - `cycleNumber` matches expected next cycle
   - `validAfter` aligns with cycle start
   - `validBefore` extends to cycle end

2. **Verify** the subscriber still has sufficient balance

3. **Verify** subscription is in good standing (not cancelled)

4. **Simulate** the renewal transaction

---

## 5. Settlement Logic

### 5.1 Initial Subscription Settlement (EIP-3009)

```solidity
// 1. Execute the payment
IERC3009(asset).transferWithAuthorization(
    authorization.from,
    authorization.to,
    authorization.value,
    authorization.validAfter,
    authorization.validBefore,
    authorization.nonce,
    signature
);

// 2. Register the subscription (on-chain or off-chain)
bytes32 subscriptionId = keccak256(abi.encodePacked(
    subscriber,
    payTo,
    tierId,
    block.timestamp
));

// 3. Store renewal authorizations (if provided)
for (uint i = 0; i < renewalAuthorizations.length; i++) {
    storeRenewalAuth(subscriptionId, renewalAuthorizations[i]);
}

// 4. Return subscription details
emit SubscriptionCreated(subscriptionId, subscriber, tierId, cycleEnd);
```

### 5.2 Initial Subscription Settlement (Permit2)

```solidity
// Call x402SubscriptionProxy.subscribe()
x402SubscriptionProxy.subscribe(
    permit,
    amount,
    owner,
    subscriptionWitness,
    signature,
    tierId,
    billingCycleSeconds
);
```

### 5.3 Renewal Settlement

For automatic renewals at cycle boundaries:

```solidity
function processRenewal(bytes32 subscriptionId) external {
    Subscription storage sub = subscriptions[subscriptionId];
    require(block.timestamp >= sub.currentCycleEnd, "cycle_not_ended");
    require(!sub.cancelled, "subscription_cancelled");

    // Get pre-stored renewal authorization
    RenewalAuth memory auth = renewalAuths[subscriptionId][sub.cycleNumber + 1];
    require(auth.signature.length > 0, "no_renewal_auth");

    // Execute the renewal payment
    IERC3009(sub.asset).transferWithAuthorization(
        auth.from,
        auth.to,
        auth.value,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.signature
    );

    // Update subscription state
    sub.cycleNumber++;
    sub.currentCycleStart = sub.currentCycleEnd;
    sub.currentCycleEnd = sub.currentCycleStart + sub.billingCycleSeconds;

    emit SubscriptionRenewed(subscriptionId, sub.cycleNumber, sub.currentCycleEnd);
}
```

### 5.4 Cancellation Settlement

Cancellation is recorded but does not trigger a blockchain payment:

```solidity
function cancelSubscription(
    bytes32 subscriptionId,
    bytes calldata cancellationSignature
) external {
    Subscription storage sub = subscriptions[subscriptionId];

    // Verify cancellation is signed by subscriber
    bytes32 cancellationHash = keccak256(abi.encodePacked(
        subscriptionId,
        "cancel",
        block.timestamp
    ));
    address signer = ECDSA.recover(cancellationHash, cancellationSignature);
    require(signer == sub.subscriber, "unauthorized");

    // Mark as cancelled (access continues until cycle end)
    sub.cancelled = true;
    sub.cancellationTimestamp = block.timestamp;

    // Delete unused renewal authorizations
    for (uint i = sub.cycleNumber + 1; i <= maxStoredCycles; i++) {
        delete renewalAuths[subscriptionId][i];
    }

    emit SubscriptionCancelled(subscriptionId, sub.currentCycleEnd);
}
```

---

## 6. Grace Period Handling

When a renewal fails (insufficient funds, expired auth, etc.):

```solidity
function handleFailedRenewal(bytes32 subscriptionId) internal {
    Subscription storage sub = subscriptions[subscriptionId];

    // Enter grace period
    sub.inGracePeriod = true;
    sub.gracePeriodEnd = sub.currentCycleEnd + sub.gracePeriodSeconds;

    emit SubscriptionGracePeriod(subscriptionId, sub.gracePeriodEnd);
}

function isSubscriptionActive(bytes32 subscriptionId) public view returns (bool) {
    Subscription storage sub = subscriptions[subscriptionId];

    if (sub.cancelled && block.timestamp >= sub.currentCycleEnd) {
        return false;
    }

    if (sub.inGracePeriod) {
        return block.timestamp < sub.gracePeriodEnd;
    }

    return block.timestamp < sub.currentCycleEnd;
}
```

---

## 7. Reference Implementation: `x402SubscriptionRegistry`

This contract manages subscription state on-chain for trustless verification.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

contract x402SubscriptionRegistry is EIP712, ReentrancyGuard {
    using ECDSA for bytes32;

    // ============ Constants ============

    bytes32 public constant SUBSCRIPTION_PROOF_TYPEHASH = keccak256(
        "SubscriptionProof(bytes32 subscriptionId,address subscriber,string tierId,address payTo,uint256 currentCycleNumber,uint256 currentCycleStart,uint256 currentCycleEnd)"
    );

    bytes32 public constant CANCELLATION_TYPEHASH = keccak256(
        "CancelSubscription(bytes32 subscriptionId,uint256 timestamp)"
    );

    // ============ Structs ============

    struct Subscription {
        address subscriber;
        address payTo;
        address asset;
        string tierId;
        uint256 amount;
        uint256 billingCycleSeconds;
        uint256 gracePeriodSeconds;
        uint256 cycleNumber;
        uint256 currentCycleStart;
        uint256 currentCycleEnd;
        bool cancelled;
        bool inGracePeriod;
        uint256 gracePeriodEnd;
    }

    struct RenewalAuthorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        bytes signature;
    }

    struct SubscribeParams {
        address subscriber;
        address payTo;
        address asset;
        string tierId;
        uint256 amount;
        uint256 billingCycleSeconds;
        uint256 gracePeriodSeconds;
        uint256 startTimestamp;
        bytes signature;
        RenewalAuthorization initialAuth;
        RenewalAuthorization[] renewalAuths;
    }

    // ============ State ============

    mapping(bytes32 => Subscription) public subscriptions;
    mapping(bytes32 => mapping(uint256 => RenewalAuthorization)) public renewalAuthorizations;
    mapping(address => bytes32[]) public subscriberSubscriptions;

    // ============ Events ============

    event SubscriptionCreated(
        bytes32 indexed subscriptionId,
        address indexed subscriber,
        address indexed payTo,
        string tierId,
        uint256 amount,
        uint256 cycleEnd
    );

    event SubscriptionRenewed(
        bytes32 indexed subscriptionId,
        uint256 cycleNumber,
        uint256 cycleEnd,
        bytes32 transactionHash
    );

    event SubscriptionCancelled(
        bytes32 indexed subscriptionId,
        uint256 accessEndsAt
    );

    event SubscriptionGracePeriod(
        bytes32 indexed subscriptionId,
        uint256 gracePeriodEnd
    );

    event RenewalFailed(
        bytes32 indexed subscriptionId,
        uint256 cycleNumber,
        string reason
    );

    // ============ Constructor ============

    constructor() EIP712("x402SubscriptionRegistry", "1") {}

    // ============ External Functions ============

    /**
     * @notice Create a new subscription with initial payment
     * @param params Subscription parameters including payment authorization
     */
    function subscribe(SubscribeParams calldata params)
        external
        nonReentrant
        returns (bytes32 subscriptionId)
    {
        // Generate unique subscription ID
        subscriptionId = keccak256(abi.encodePacked(
            params.subscriber,
            params.payTo,
            params.tierId,
            params.startTimestamp,
            block.chainid
        ));

        require(subscriptions[subscriptionId].subscriber == address(0), "subscription_exists");

        // Execute initial payment via EIP-3009
        IERC3009(params.asset).transferWithAuthorization(
            params.initialAuth.from,
            params.initialAuth.to,
            params.initialAuth.value,
            params.initialAuth.validAfter,
            params.initialAuth.validBefore,
            params.initialAuth.nonce,
            params.initialAuth.signature
        );

        // Create subscription record
        uint256 cycleEnd = params.startTimestamp + params.billingCycleSeconds;

        subscriptions[subscriptionId] = Subscription({
            subscriber: params.subscriber,
            payTo: params.payTo,
            asset: params.asset,
            tierId: params.tierId,
            amount: params.amount,
            billingCycleSeconds: params.billingCycleSeconds,
            gracePeriodSeconds: params.gracePeriodSeconds,
            cycleNumber: 1,
            currentCycleStart: params.startTimestamp,
            currentCycleEnd: cycleEnd,
            cancelled: false,
            inGracePeriod: false,
            gracePeriodEnd: 0
        });

        // Store renewal authorizations
        for (uint256 i = 0; i < params.renewalAuths.length; i++) {
            renewalAuthorizations[subscriptionId][i + 2] = params.renewalAuths[i];
        }

        subscriberSubscriptions[params.subscriber].push(subscriptionId);

        emit SubscriptionCreated(
            subscriptionId,
            params.subscriber,
            params.payTo,
            params.tierId,
            params.amount,
            cycleEnd
        );

        return subscriptionId;
    }

    /**
     * @notice Process automatic renewal for a subscription
     * @param subscriptionId The subscription to renew
     */
    function processRenewal(bytes32 subscriptionId) external nonReentrant {
        Subscription storage sub = subscriptions[subscriptionId];

        require(sub.subscriber != address(0), "subscription_not_found");
        require(!sub.cancelled, "subscription_cancelled");
        require(block.timestamp >= sub.currentCycleEnd, "cycle_not_ended");

        uint256 nextCycle = sub.cycleNumber + 1;
        RenewalAuthorization storage auth = renewalAuthorizations[subscriptionId][nextCycle];

        require(auth.signature.length > 0, "no_renewal_authorization");
        require(block.timestamp >= auth.validAfter, "renewal_not_valid_yet");
        require(block.timestamp < auth.validBefore, "renewal_expired");

        // Check balance before attempting
        if (IERC20(sub.asset).balanceOf(auth.from) < auth.value) {
            _enterGracePeriod(subscriptionId);
            emit RenewalFailed(subscriptionId, nextCycle, "insufficient_funds");
            return;
        }

        // Execute renewal payment
        try IERC3009(sub.asset).transferWithAuthorization(
            auth.from,
            auth.to,
            auth.value,
            auth.validAfter,
            auth.validBefore,
            auth.nonce,
            auth.signature
        ) {
            // Update subscription state
            sub.cycleNumber = nextCycle;
            sub.currentCycleStart = sub.currentCycleEnd;
            sub.currentCycleEnd = sub.currentCycleStart + sub.billingCycleSeconds;
            sub.inGracePeriod = false;
            sub.gracePeriodEnd = 0;

            // Clear used authorization
            delete renewalAuthorizations[subscriptionId][nextCycle];

            emit SubscriptionRenewed(
                subscriptionId,
                nextCycle,
                sub.currentCycleEnd,
                bytes32(0) // Transaction hash not available in contract
            );
        } catch {
            _enterGracePeriod(subscriptionId);
            emit RenewalFailed(subscriptionId, nextCycle, "transfer_failed");
        }
    }

    /**
     * @notice Add renewal authorizations for future cycles
     * @param subscriptionId The subscription to add renewals for
     * @param startCycle First cycle number for the new authorizations
     * @param auths Array of renewal authorizations
     */
    function addRenewalAuthorizations(
        bytes32 subscriptionId,
        uint256 startCycle,
        RenewalAuthorization[] calldata auths
    ) external {
        Subscription storage sub = subscriptions[subscriptionId];
        require(msg.sender == sub.subscriber, "unauthorized");
        require(!sub.cancelled, "subscription_cancelled");

        for (uint256 i = 0; i < auths.length; i++) {
            require(auths[i].from == sub.subscriber, "invalid_from");
            require(auths[i].to == sub.payTo, "invalid_to");
            require(auths[i].value == sub.amount, "invalid_amount");

            renewalAuthorizations[subscriptionId][startCycle + i] = auths[i];
        }
    }

    /**
     * @notice Cancel a subscription
     * @param subscriptionId The subscription to cancel
     * @param signature Subscriber's signature authorizing cancellation
     */
    function cancelSubscription(
        bytes32 subscriptionId,
        bytes calldata signature
    ) external nonReentrant {
        Subscription storage sub = subscriptions[subscriptionId];
        require(sub.subscriber != address(0), "subscription_not_found");
        require(!sub.cancelled, "already_cancelled");

        // Verify cancellation signature
        bytes32 structHash = keccak256(abi.encode(
            CANCELLATION_TYPEHASH,
            subscriptionId,
            block.timestamp
        ));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        require(signer == sub.subscriber, "invalid_signature");

        // Mark as cancelled
        sub.cancelled = true;

        // Clear future renewal authorizations
        for (uint256 i = sub.cycleNumber + 1; i <= sub.cycleNumber + 12; i++) {
            delete renewalAuthorizations[subscriptionId][i];
        }

        emit SubscriptionCancelled(subscriptionId, sub.currentCycleEnd);
    }

    // ============ View Functions ============

    /**
     * @notice Check if a subscription is currently active
     * @param subscriptionId The subscription to check
     * @return active Whether the subscription is active
     */
    function isActive(bytes32 subscriptionId) external view returns (bool active) {
        Subscription storage sub = subscriptions[subscriptionId];

        if (sub.subscriber == address(0)) {
            return false;
        }

        if (sub.cancelled && block.timestamp >= sub.currentCycleEnd) {
            return false;
        }

        if (sub.inGracePeriod) {
            return block.timestamp < sub.gracePeriodEnd;
        }

        return block.timestamp < sub.currentCycleEnd;
    }

    /**
     * @notice Get subscription details for proof generation
     * @param subscriptionId The subscription ID
     */
    function getSubscription(bytes32 subscriptionId)
        external
        view
        returns (Subscription memory)
    {
        return subscriptions[subscriptionId];
    }

    /**
     * @notice Verify a subscription proof without state changes
     * @param subscriptionId The subscription ID
     * @param subscriber The subscriber address
     * @param cycleNumber The claimed cycle number
     * @param cycleStart The claimed cycle start
     * @param cycleEnd The claimed cycle end
     * @param signature The proof signature
     */
    function verifySubscriptionProof(
        bytes32 subscriptionId,
        address subscriber,
        string calldata tierId,
        address payTo,
        uint256 cycleNumber,
        uint256 cycleStart,
        uint256 cycleEnd,
        bytes calldata signature
    ) external view returns (bool valid, string memory reason) {
        Subscription storage sub = subscriptions[subscriptionId];

        // Check subscription exists
        if (sub.subscriber == address(0)) {
            return (false, "subscription_not_found");
        }

        // Check subscription matches
        if (sub.subscriber != subscriber) {
            return (false, "subscriber_mismatch");
        }

        if (keccak256(bytes(sub.tierId)) != keccak256(bytes(tierId))) {
            return (false, "tier_mismatch");
        }

        if (sub.payTo != payTo) {
            return (false, "payTo_mismatch");
        }

        // Check cycle matches
        if (sub.cycleNumber != cycleNumber ||
            sub.currentCycleStart != cycleStart ||
            sub.currentCycleEnd != cycleEnd) {
            return (false, "cycle_mismatch");
        }

        // Check timing
        if (block.timestamp < cycleStart) {
            return (false, "cycle_not_started");
        }

        if (block.timestamp >= cycleEnd && !sub.inGracePeriod) {
            return (false, "cycle_ended");
        }

        if (sub.inGracePeriod && block.timestamp >= sub.gracePeriodEnd) {
            return (false, "grace_period_expired");
        }

        // Verify signature
        bytes32 structHash = keccak256(abi.encode(
            SUBSCRIPTION_PROOF_TYPEHASH,
            subscriptionId,
            subscriber,
            keccak256(bytes(tierId)),
            payTo,
            cycleNumber,
            cycleStart,
            cycleEnd
        ));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);

        if (signer != subscriber) {
            return (false, "invalid_signature");
        }

        return (true, "");
    }

    // ============ Internal Functions ============

    function _enterGracePeriod(bytes32 subscriptionId) internal {
        Subscription storage sub = subscriptions[subscriptionId];
        sub.inGracePeriod = true;
        sub.gracePeriodEnd = sub.currentCycleEnd + sub.gracePeriodSeconds;

        emit SubscriptionGracePeriod(subscriptionId, sub.gracePeriodEnd);
    }
}
```

---

## 8. Reference Implementation: `x402SubscriptionProxy` (Permit2)

For tokens without EIP-3009, use this Permit2-based proxy:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract x402SubscriptionProxy {
    ISignatureTransfer public immutable PERMIT2;

    // EIP-712 Type for Subscription Witness
    string public constant SUBSCRIPTION_WITNESS_TYPE_STRING =
        "SubscriptionWitness witness)SubscriptionWitness(address to,uint256 validAfter,bytes32 subscriptionId,uint256 cycleNumber,bytes extra)TokenPermissions(address token,uint256 amount)";

    bytes32 public constant SUBSCRIPTION_WITNESS_TYPEHASH = keccak256(
        "SubscriptionWitness(address to,uint256 validAfter,bytes32 subscriptionId,uint256 cycleNumber,bytes extra)"
    );

    struct SubscriptionWitness {
        address to;
        uint256 validAfter;
        bytes32 subscriptionId;
        uint256 cycleNumber;
        bytes extra;
    }

    event x402SubscriptionPayment(
        bytes32 indexed subscriptionId,
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 cycleNumber
    );

    constructor(address _permit2) {
        PERMIT2 = ISignatureTransfer(_permit2);
    }

    /**
     * @notice Process a subscription payment via Permit2
     */
    function processPayment(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        uint256 amount,
        address owner,
        SubscriptionWitness calldata witness,
        bytes calldata signature
    ) external {
        require(block.timestamp >= witness.validAfter, "payment_not_valid_yet");
        require(amount <= permit.permitted.amount, "amount_exceeds_permitted");

        ISignatureTransfer.SignatureTransferDetails memory transferDetails =
            ISignatureTransfer.SignatureTransferDetails({
                to: witness.to,
                requestedAmount: amount
            });

        bytes32 witnessHash = keccak256(abi.encode(
            SUBSCRIPTION_WITNESS_TYPEHASH,
            witness.to,
            witness.validAfter,
            witness.subscriptionId,
            witness.cycleNumber,
            keccak256(witness.extra)
        ));

        PERMIT2.permitWitnessTransferFrom(
            permit,
            transferDetails,
            owner,
            witnessHash,
            SUBSCRIPTION_WITNESS_TYPE_STRING,
            signature
        );

        emit x402SubscriptionPayment(
            witness.subscriptionId,
            owner,
            witness.to,
            amount,
            witness.cycleNumber
        );
    }
}
```

---

## 9. Facilitator API Extensions

### 9.1 POST /subscribe

Create a new subscription:

**Request:**
```json
{
  "paymentPayload": { /* PaymentPayload with subscriptionPayload */ },
  "paymentRequirements": { /* PaymentRequirements with subscriptionDetails */ }
}
```

**Response:**
```json
{
  "success": true,
  "subscriptionId": "0x1234...",
  "transaction": "0xabcd...",
  "network": "eip155:8453",
  "payer": "0x857b...",
  "subscriptionDetails": {
    "tierId": "pro",
    "status": "active",
    "currentCycleStart": "1740672089",
    "currentCycleEnd": "1743264089",
    "autoRenewEnabled": true,
    "storedRenewalCycles": 3
  }
}
```

### 9.2 GET /subscription/{subscriptionId}

Query subscription status:

**Response:**
```json
{
  "subscriptionId": "0x1234...",
  "subscriber": "0x857b...",
  "payTo": "0x2096...",
  "tierId": "pro",
  "status": "active",
  "network": "eip155:8453",
  "asset": "0x8335...",
  "amount": "5000000",
  "currentCycle": {
    "number": 2,
    "start": "1743264089",
    "end": "1745856089"
  },
  "nextRenewal": {
    "date": "1745856089",
    "authorized": true
  },
  "cancelled": false
}
```

### 9.3 POST /subscription/{subscriptionId}/cancel

Cancel a subscription:

**Request:**
```json
{
  "signature": "0x...",
  "timestamp": "1740700000"
}
```

**Response:**
```json
{
  "success": true,
  "subscriptionId": "0x1234...",
  "accessEndsAt": "1743264089",
  "refundAmount": "0"
}
```

---

## 10. Security Considerations

### 10.1 Replay Attack Prevention

- Each billing cycle uses a unique nonce
- Pre-signed renewals have non-overlapping `validAfter`/`validBefore` windows
- Subscription proofs include cycle-specific timestamps

### 10.2 Authorization Scope

- Subscribers control exact amounts per cycle
- Pre-signed renewals can be invalidated by:
  - Spending the nonce with a different transaction
  - Reducing token balance below required amount
  - Revoking Permit2 allowance (for Permit2 method)

### 10.3 Facilitator Trust Model

- Facilitators CANNOT modify payment amounts or recipients
- Facilitators CAN delay renewal execution (mitigated by validity windows)
- On-chain registry provides trustless verification fallback

### 10.4 Front-running Protection

- Renewal transactions can only be executed by the designated facilitator
- Subscription IDs are deterministic and verifiable

---

## Appendix

### Canonical Contract Addresses

| Contract                    | Address                                      | Networks           |
| --------------------------- | -------------------------------------------- | ------------------ |
| `x402SubscriptionRegistry`  | TBD (CREATE2 deployment)                     | All supported EVM  |
| `x402SubscriptionProxy`     | TBD (CREATE2 deployment)                     | All supported EVM  |
| `Permit2`                   | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | All supported EVM  |

### Supported Networks

| Network         | Chain ID | CAIP-2 Identifier  |
| --------------- | -------- | ------------------ |
| Base Mainnet    | 8453     | `eip155:8453`      |
| Base Sepolia    | 84532    | `eip155:84532`     |
| Ethereum        | 1        | `eip155:1`         |
| Arbitrum One    | 42161    | `eip155:42161`     |
| Optimism        | 10       | `eip155:10`        |
| Polygon         | 137      | `eip155:137`       |

### References

- [EIP-3009: Transfer With Authorization](https://eips.ethereum.org/EIPS/eip-3009)
- [EIP-712: Typed Structured Data Hashing](https://eips.ethereum.org/EIPS/eip-712)
- [Permit2 Documentation](https://docs.uniswap.org/contracts/permit2/overview)
- [x402 Protocol Specification v2](../../x402-specification-v2.md)
- [Subscribe Scheme Overview](./scheme_subscribe.md)
