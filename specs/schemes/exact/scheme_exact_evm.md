# Scheme: `exact` on `EVM`

## Summary

The `exact` scheme on EVM executes a transfer where the Facilitator (server) pays the gas, but the Client (user) controls the exact flow of funds via cryptographic signatures.

This is implemented via one of three asset transfer methods, depending on the token's capabilities:

| AssetTransferMethod | Use Case                                                     | Recommendation                                 | Usage Semantics                     |
| :------------------ | :----------------------------------------------------------- | :--------------------------------------------- | :---------------------------------- |
| **1. EIP-3009**     | Tokens with native `transferWithAuthorization` (e.g., USDC). | **Recommended** (Simplest, truly gasless).     | One-time use                        |
| **2. Permit2**      | Tokens without EIP-3009. Uses a Proxy + Permit2.             | **Universal Fallback** (Works for any ERC-20). | One-time use                        |
| **3. ERC-7710**      | Smart accounts with delegation support.                              | **Smart Account Option** (Paid from ERC-7710 compatible account). | One-time use and multi-use |

If no `assetTransferMethod` is specified in `PaymentRequired.extra`, clients should default to `"eip3009"`. Payment payloads that use a non-default transfer method should echo the selected `assetTransferMethod` in `accepted.extra`.

In all cases, the Facilitator cannot modify the amount or destination. They serve only as the transaction broadcaster.

---

## 1. AssetTransferMethod: `EIP-3009`

The `eip3009` asset transfer method uses the `transferWithAuthorization` function directly on token contracts that support it.

### Phase 1: `PAYMENT-SIGNATURE` Header Payload

The `payload` field must contain:

- `signature`: The 65-byte signature of the `transferWithAuthorization` operation.
- `authorization`: The parameters required to reconstruct the signed message.

**Example PaymentPayload:**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "10000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "extra": {
      "assetTransferMethod": "eip3009",
      "name": "USDC",
      "version": "2"
    }
  },
  "payload": {
    "signature": "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
    "authorization": {
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "to": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "value": "10000",
      "validAfter": "1740672089",
      "validBefore": "1740672154",
      "nonce": "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480"
    }
  }
}
```

**`extra` field definitions specific to `eip3009`:**

- `extra.assetTransferMethod` (optional in `PaymentRequired`, default `"eip3009"`): if present, MUST be `"eip3009"`.
- `extra.name` (required): The EIP-712 domain name of the token contract. Used for `transferWithAuthorization` signature construction.
- `extra.version` (required): The EIP-712 domain version of the token contract. Used for `transferWithAuthorization` signature construction.

### Phase 2: Verification Logic

1.  **Verify** the signature is valid and recovers to the `authorization.from` address.
2.  **Verify** the `client` has sufficient balance of the `asset`.
3.  **Verify** the authorization parameters (Amount, Validity Window) meet the `PaymentRequirements`.
4.  **Verify** the Token and Network match the requirement.
5.  **Simulate** `token.transferWithAuthorization(...)` to ensure success.

### Phase 3: Settlement Logic

Settlement is performed via the facilitator calling the `transferWithAuthorization` function on the `EIP-3009` compliant contract with the `payload.signature` and `payload.authorization` parameters from the `PAYMENT-SIGNATURE` header.

If the transaction broadcasts successfully but its confirmation cannot be established (e.g. a node/RPC error or timeout while waiting for the receipt), the facilitator MAY return `settlement_pending` (see [§9 Error Handling](../../x402-specification-v2.md#9-error-handling)) with the broadcast transaction hash in `transaction`, so the caller can reconcile on chain before retrying.

---

## 2. AssetTransferMethod: `Permit2`

This asset transfer method uses the `permitWitnessTransferFrom` from the [canonical **Permit2** contract](#canonical-permit2) combined with a [`x402ExactPermit2Proxy`](#reference-implementation-x402ExactPermit2Proxy) to enforce receiver address security via the "Witness" pattern.

### Phase 1: One-Time Gas Approval

Permit2 requires the user to approve the [**Permit2 Contract** (Canonical Address)](#canonical-permit2) to spend their tokens. This is a one-time setup. The specification supports three ways to handle this:

#### Option A: Direct User Approval (Standard)

The user submits a standard on-chain `approve(Permit2)` transaction paying their own gas.

- _Prerequisite:_ User must have Native Gas currency.

#### Option B: Sponsored ERC20 Approval (Extension: [`erc20ApprovalGasSponsoring`](../../extensions/erc20_gas_sponsoring.md))

The Facilitator pays the gas for the approval transaction on the user's behalf.

- _Prerequisite:_ Server supports this extension.
- _Flow:_ Facilitator batches the following transactions: `from.transfer(gas_amount)` -> `ERC20.approve(Permit2)` -> `settle`.

#### Option C: EIP2612 Permit (Extension: [`eip2612GasSponsoring`](../../extensions/eip2612_gas_sponsoring.md))

If the token supports EIP-2612, the user signs a permit authorizing Permit2.

- _Prerequisite:_ Token supports EIP-2612.
- _Flow:_ Facilitator calls `x402ExactPermit2Proxy.settleWithPermit()`

### Phase 2: `PAYMENT-SIGNATURE` Header Payload

The `payload` field must contain:

- `signature`: The signature for `permitWitnessTransferFrom`.
- `permit2Authorization`: Parameters to reconstruct the message.

**Important Logic:** The `spender` in the signature is the [**x402ExactPermit2Proxy**](#reference-implementation-x402ExactPermit2Proxy), not the Facilitator. This Proxy enforces that funds are only sent to the `witness.to` address.

> **Requirement**: This contract will be deployed to the same address across all supported EVM chains using `CREATE2` to ensure consistent behavior and simpler integration.

**Example PaymentPayload:**

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "10000",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "extra": {
      "assetTransferMethod": "permit2",
      "name": "USDC",
      "version": "2"
    }
  }
  "payload": {
    "signature": "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
    "permit2Authorization": {
      "permitted": {
        "token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "amount": "10000"
      },
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "spender": "0x402085c248EeA27D92E8b30b2C58ed07f9E20001", // Canonical x402ExactPermit2Proxy address
      "nonce": "33247007178036348590600198031289925668252061821958005840077069883511451257277",
      "deadline": "1740672154",
      "witness": {
        "to": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        "validAfter": "1740672089"
      }
    }
  },
}
```

**`extra` field definitions specific to `permit2`:**

- `extra.assetTransferMethod` (required): MUST be `"permit2"`.
- `extra.name` (conditional): The EIP-712 domain name of the token contract. Required when the token supports EIP-2612 for gasless Permit2 approval.
- `extra.version` (conditional): The EIP-712 domain version of the token contract. Required when the token supports EIP-2612 for gasless Permit2 approval.

### Phase 3: Verification Logic

The verifier must execute these checks in order:

1.  **Verify** `payload.signature` is valid and recovers to the `permit2Authorization.from`.

2.  **Verify** that the `client` has enabled the Permit2 approval.

    - if ERC20.allowance(from, Permit2_Address) < amount:
      - Check for **Sponsored ERC20 Approval** (Extension): Refers to [`erc20ApprovalGasSponsoring`](../../extensions/erc20_gas_sponsoring.md).
      - Check for **EIP2612 Permit** (Extension): Refers to [`eip2612GasSponsoring`](../../extensions/eip2612_gas_sponsoring.md).
      - **If neither exists:** Return `412 Precondition Failed` (Error Code: `PERMIT2_ALLOWANCE_REQUIRED`). This signals the client that a one-time Direct Approval transaction is required before retrying.

3.  **Verify** the `client` has sufficient balance of the `asset`.

4.  **Verify** the `permit2Authorization.amount` covers the payment.

5.  **Verify** the `deadline` (not expired) and `witness.validAfter` (active).

6.  **Verify** the Token and Network match the requirement.

7.  **Simulation (Recommended):**

    Simulation is recommended but implementations may defer to re-verify-before-settle.

    - _Standard:_ Simulate `x402ExactPermit2Proxy.settle`.
    - _With "Sponsored ERC20 Approval" (Extension):_ Simulate batch `transfer` -> `approve` -> `settle`.
    - _With "EIP2612 Permit" (Extension):_ Simulate `x402ExactPermit2Proxy.settleWithPermit`.

### Phase 4: Settlement Logic

Settlement is performed by calling the `x402ExactPermit2Proxy`.

1.  **Standard Settlement:**
    If the user has a sufficient direct allowance, call `x402ExactPermit2Proxy.settle`.

2.  **With Sponsored ERC20 Approval (Extension):**
    If `erc20ApprovalGasSponsoring` is used, the facilitator must construct a batched transaction that executes the sponsored `ERC20.approve` call strictly before the `x402ExactPermit2Proxy.settle` call.

3.  **With EIP-2612 Permit (Extension):**
    If `eip2612GasSponsoring` is used, call `x402ExactPermit2Proxy.settleWithPermit`.

If the settlement transaction broadcasts successfully but its confirmation cannot be established (e.g. a node/RPC error or timeout while waiting for the receipt), the facilitator MAY return `settlement_pending` (see [§9 Error Handling](../../x402-specification-v2.md#9-error-handling)) with the broadcast transaction hash in `transaction`, so the caller can reconcile on chain before retrying.

---

## 3. AssetTransferMethod: `ERC-7710`

This asset transfer method uses [ERC-7710](https://eips.ethereum.org/EIPS/eip-7710) smart contract delegation to authorize transfers from accounts that support the standard. It is particularly suited for smart contract accounts (e.g., ERC-4337 accounts, ERC-7579 modular accounts) that have enabled delegation capabilities.

### Prerequisites

For ERC-7710 to work, the following must be true:

1. **Delegator Account**: The payer's account must be a smart contract that supports ERC-7710 delegation (e.g., a modular smart account with delegation capabilities).
2. **Delegation Manager**: A `DelegationManager` contract implementing the `ERC7710Manager` interface must be deployed on the network.
3. **Active Delegation**: The payer must have created a delegation authorizing the delegate to execute token transfers on their behalf, with appropriate caveats (amount limits, recipient restrictions, etc.).

### Phase 1: Obtaining a Delegation

The process of obtaining a delegation is outside the scope of x402. Delegations may be obtained through:

- [ERC-7715](https://eips.ethereum.org/EIPS/eip-7715) permission requests
- Direct wallet interactions
- Pre-configured session keys
- Other delegation protocols

The key requirement is that the client is able to issue a delegation to the facilitator that permits the required token transfer.

### Phase 2: `PAYMENT-SIGNATURE` Header Payload

The `payload` field must contain:

- `delegationManager`: The address of the ERC-7710 Delegation Manager contract.
- `permissionContext`: The delegation proof/context required by the specific Delegation Manager implementation.
- `delegator`: The address of the account that created the delegation.

**Example PaymentPayload:**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "10000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "extra": {
      "assetTransferMethod": "erc7710",
      "name": "USDC",
      "version": "2"
    }
  },
  "payload": {
    "delegationManager": "0xDelegationManagerAddress",
    "permissionContext": "0x...",
    "delegator": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
  }
}
```

**`extra` field definitions specific to `erc7710`:**

- `extra.assetTransferMethod` (required): MUST be `"erc7710"`.
- `extra.name` (optional): The EIP-712 domain name of the token contract. Not required for ERC-7710 delegation-based transfers.
- `extra.version` (optional): The EIP-712 domain version of the token contract. Not required for ERC-7710 delegation-based transfers.

**Note:** The structure of `permissionContext` is determined by the specific Delegation Manager implementation. Common implementations (e.g., MetaMask Delegation Framework) use EIP-712 signed delegation chains.

### Phase 3: Verification Logic

Unlike EIP-3009 and Permit2, ERC-7710 verification is performed entirely through simulation. The `permissionContext` is opaque to the facilitator but verifiable by simulating the intended action.

The facilitator:

1. **Constructs** the `executionCallData` encoding an ERC-20 `transfer(payTo, amount)` call for the required payment.

2. **Constructs** the `mode` appropriate for the execution (typically `0x00...` for single call mode per ERC-7579).

3. **Simulates** `delegationManager.redeemDelegations([permissionContext], [mode], [executionCallData])` to verify:
   - The delegation is valid and authorizes the intended transfer.
   - The delegator has sufficient balance of the asset.
   - The transaction will succeed when executed.

If the simulation succeeds, the payment is considered valid. The simulation serves as the sole verification mechanism—no trusted list of Delegation Manager implementations is required.

**Security Considerations**:

1. **Race Condition Risk**: A facilitator may be vulnerable to a race condition where the client invalidates their delegation between simulation and transaction execution, causing the facilitator to pay gas for a failed transaction. This risk can be mitigated by:
   - Submitting transactions via a private mempool to reduce the window for front-running.
   - Building trust signals for client accounts (e.g., reputation systems) that can be used to flag or ban abusive behavior.

2. **Malicious Delegation Manager Gas Consumption**: A malicious or poorly implemented Delegation Manager could attempt to consume excessive gas during execution. To mitigate this risk:
   - Facilitators should always set an explicit gas limit on their `redeemDelegations` call, as is standard practice for all Ethereum transactions.
   - Pre-execution simulation helps identify whether a transaction is likely to use a reasonable amount of gas.
   - If simulation reveals unexpectedly high gas consumption, this may indicate a "trap door" implementation designed to drain facilitator funds, and the transaction should be rejected.

### Phase 4: Settlement Logic

Settlement is performed by calling `redeemDelegations` on the Delegation Manager:

```solidity
delegationManager.redeemDelegations(
    [permissionContext],  // bytes[] - delegation proof
    [mode],               // bytes32[] - execution mode
    [executionCallData]   // bytes[] - encoded transfer call
);
```

The Delegation Manager validates the delegation authority and calls the delegator account to execute the token transfer. The delegator account then performs `token.transfer(payTo, amount)`.

---

## Implementer Notes

- **Permit2 Dependency:** Both the Permit2 contract and the x402ExactPermit2Proxy are audited, battle-tested contracts. However, integrators inherit their security properties and any future vulnerabilities discovered in either dependency.

---

## Settlement Status Declarations (per core spec §5.3.3.1)

Declarations for two of the three AssetTransferMethods of `exact` on EVM. The `erc7710` declaration is deferred to a follow-up; per core spec §5.3.3.1, a binding without a declaration does not emit `status`. Both entries below are `version: 1` of their respective lists. Consensus time source for both: the timestamp of the block containing the anchoring transaction — `ledgerTime` is therefore REQUIRED on `settled` for both bindings.

### `eip3009`

| State | Reachability | Anchor / enforcement |
| ----- | ------------ | -------------------- |
| `settled` | `reachable` | `composite`: `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` joined to an ERC-20 `Transfer` in the same transaction with `from == authorizer`. Join rule: per `(transaction, authorizer)` — a transaction MAY contain more than one qualifying `Transfer`, so the event alone attributes the authorization and the join attributes the movement. `about`: `{authorizer, nonce}`. |
| `pending` | `reachable` | broadcast transaction hash. |
| `deferred_until` | `reachable`, **enforced** | enforcer: request-derived — the token named by `PaymentRequirements.asset`, which MUST implement EIP-3009 and reject settlement at or before the bound · field: `authorization.validAfter` · comparator: `>` (strict — settlement at exactly `validAfter` still refuses) · unit: unix-seconds. Failure signal observed on Circle FiatTokenV2 deployments: revert reason `FiatTokenV2: authorization is not yet valid`; other conformant assets MAY signal differently, so verifiers MUST validate against the predicate, not the string. A facilitator MUST NOT emit `basis: "enforced"` for an asset it has not confirmed satisfies the predicate. `effectiveFrom` for a request-derived enforcer is per-asset (the asset contract's deployment or upgrade height). |
| `blocked` | `reachable` | `read` of balance/allowance against the token, with block height as the ordering coordinate. |
| `canceled` | `reachable` | `AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)` — emitted only by a successful cancellation of an unused nonce, so conclusive alone. `authorizationState()` MUST NOT be used to attribute: `true` means used **or** canceled. |
| `expired` | `reachable` | `none`; `absentReason`: "validBefore lapsed; EIP-3009 expiry writes no ledger artifact". |

### `permit2`

| State | Reachability | Anchor / enforcement |
| ----- | ------------ | -------------------- |
| `settled` | `reachable` | **calldata-authoritative.** The deployed proxy's `Settled()` / `SettledWithPermit()` events carry no parameters (one topic, empty data), so no log binds a settlement to an authorization — the annex source's parameterized `x402PermitTransfer(...)` event is NOT what the deployed contract emits, parallel to the `"Too early"` note below. `about`: `{owner, nonce}` derives only from settlement calldata (either entry point). The marker + same-transaction ERC-20 `Transfer` composite is best-effort *economic* attribution and MUST NOT be read as authorization-level proof. Absence of a marker log is NOT evidence of non-settlement. |
| `pending` | `reachable` | broadcast transaction hash. |
| `deferred_until` | `reachable`, **enforced** | enforcer: fixed — `x402ExactPermit2Proxy` at `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` · field: `witness.validAfter` (signature-committed via `WITNESS_TYPEHASH`) · comparator: `>=` (inclusive — settlement at exactly `validAfter` succeeds) · unit: unix-seconds. Failure signal: custom error `PaymentTooEarly()` (`0xa65539fa`), on both settlement entry points (`settle` `0x13cd3b53`, `settleWithPermit` `0xfa340378`); the annex source's `"Too early"` reason string is NOT what the deployed contract reverts, so implementations MUST match the 4-byte selector. `effectiveFrom`: `eip155:8453`, block `43202150` (the proxy's deployment height, confirmable via `eth_getCode`); other networks declare their own heights as the proxy is deployed there. |
| `blocked` | `reachable` | `read` of balance and Permit2 allowance, with block height as the ordering coordinate. |
| `canceled` | `reachable` | `composite`: `UnorderedNonceInvalidation` **plus** ordering evidence that the nonce bit went 0→1 by invalidation before any successful use. The event alone is NOT conclusive — the bitmap write is unconditional and the event fires even when settlement already consumed the bit; `InvalidNonce` means "used or invalidated". Without the ordering half, omit `status` per the core spec's failure-to-resolve rule; a facilitator MUST NOT emit `canceled`. |
| `expired` | `reachable` | `none`; `absentReason`: "Permit2 `SignatureExpired` on a lapsed deadline leaves no artifact unless a settle was attempted". |

Note the two enforcement objects disagree by one second at the boundary — `eip3009` is strict where `permit2` is inclusive — so a cross-binding reader validating a declared `enforced` against the chain gets a false mismatch at exactly `t` unless the comparator travels with the declaration.

---

## Annex

### ERC-7710 Delegation Managers

ERC-7710 does not define a canonical Delegation Manager. Implementations may vary in their delegation structure, caveat enforcement, and permission context format. Notable implementations include:

- **MetaMask Delegation Framework**: A full-featured implementation supporting EIP-712 signed delegation chains, caveat enforcement, and batch processing. See [gator.metamask.io](https://gator.metamask.io/) for documentation.

Since verification is performed entirely through simulation, facilitators do not need to maintain a trusted list of Delegation Manager implementations.

### Canonical Permit2

The Canonical Permit2 contract address can be found at [https://docs.uniswap.org/contracts/v4/deployments](https://docs.uniswap.org/contracts/v4/deployments).

### Reference Implementation: `x402ExactPermit2Proxy`

This contract acts as the authorized Spender. It validates the Witness data to ensure the destination cannot be altered by the Facilitator.

> **Requirement**: This contract will be deployed to the same address across all supported EVM chains using `CREATE2` to ensure consistent behavior and simpler integration.

**Canonical Address:** `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

// Interface for EIP-2612 Support
interface IERC20Permit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

contract x402ExactPermit2Proxy {
    ISignatureTransfer public immutable PERMIT2;

    event x402PermitTransfer(address from, address to, uint256 amount, address asset);

    // EIP-712 Type Definition (post-audit: extra removed from Witness)
    string public constant WITNESS_TYPE_STRING =
        "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)";

    bytes32 public constant WITNESS_TYPEHASH =
        keccak256("Witness(address to,uint256 validAfter)");

    struct Witness {
        address to;
        uint256 validAfter;
    }

    struct EIP2612Permit {
        uint256 value;
        uint256 deadline;
        bytes32 r;
        bytes32 s;
        uint8 v;
    }

    constructor(address _permit2) {
        PERMIT2 = ISignatureTransfer(_permit2);
    }

    /**
     * @notice Settles a transfer using a standard Permit2 signature
     */
    function settle(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) external {
        _settleInternal(permit, owner, witness, signature);
    }

    /**
     * @notice Extension: Settles a transfer using an EIP-2612 Permit for the allowance
     */
    function settleWithPermit(
        EIP2612Permit calldata permit2612,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) external {
        // 1. Submit the EIP-2612 Permit to the Token
        IERC20Permit(permit.permitted.token).permit(
            owner,
            address(PERMIT2),
            permit2612.value,
            permit2612.deadline,
            permit2612.v, permit2612.r, permit2612.s
        );

        // 2. Execute Permit2 Settlement
        _settleInternal(permit, owner, witness, signature);
    }

    function _settleInternal(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) internal {
        require(block.timestamp >= witness.validAfter, "Too early");

        ISignatureTransfer.SignatureTransferDetails memory transferDetails =
            ISignatureTransfer.SignatureTransferDetails({
                to: witness.to,
                requestedAmount: permit.permitted.amount
            });

        bytes32 witnessHash = keccak256(abi.encode(
            WITNESS_TYPEHASH,
            witness.to,
            witness.validAfter
        ));

        PERMIT2.permitWitnessTransferFrom(
            permit,
            transferDetails,
            owner,
            witnessHash,
            WITNESS_TYPE_STRING,
            signature
        );

        emit x402PermitTransfer(owner, transferDetails.to, transferDetails.requestedAmount, permit.permitted.token);
    }
}
```
