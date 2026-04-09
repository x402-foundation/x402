# Scheme: `exact` on `EVM`

## Summary

The `exact` scheme on EVM executes a transfer where the Facilitator (server) pays the gas, but the Client (user) controls the exact flow of funds via cryptographic signatures.

This is implemented via one of two asset transfer methods, depending on the token's capabilities:

| AssetTransferMethod | Use Case                                                     | Recommendation                                 |
| :------------------ | :----------------------------------------------------------- | :--------------------------------------------- |
| **1. EIP-3009**     | Tokens with native `transferWithAuthorization` (e.g., USDC). | **Recommended** (Simplest, truly gasless).     |
| **2. Permit2**      | Tokens without EIP-3009. Uses a Proxy + Permit2.             | **Universal Fallback** (Works for any ERC-20). |

If no `assetTransferMethod` is specified in the payload, the implementation should prioritize `eip3009` (if compatible) and then `permit2`.

In both cases, the Facilitator cannot modify the amount or destination. They serve only as the transaction broadcaster.

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
      "version": "2",
      "decimals": 6
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

### Phase 2: Verification Logic

1.  **Verify** the signature is valid and recovers to the `authorization.from` address.
2.  **Verify** the `client` has sufficient balance of the `asset`.
3.  **Verify** the authorization parameters (Amount, Validity Window) meet the `PaymentRequirements`.
4.  **Verify** the Token and Network match the requirement.
5.  **Simulate** `token.transferWithAuthorization(...)` to ensure success.

### Phase 3: Settlement Logic

Settlement is performed via the facilitator calling the `transferWithAuthorization` function on the `EIP-3009` compliant contract with the `payload.signature` and `payload.authorization` parameters from the `PAYMENT-SIGNATURE` header.

---

## 2. AssetTransferMethod: `Permit2`

This asset transfer method uses the `permitWitnessTransferFrom` from the [canonical **Permit2** contract](#canonical-permit2) combined with a [`x402Permit2Proxy`](#reference-implementation-x402permit2proxy) to enforce receiver address security via the "Witness" pattern.

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
- _Flow:_ Facilitator calls `x402Permit2Proxy.settleWithPermit()`

### Phase 2: `PAYMENT-SIGNATURE` Header Payload

The `payload` field must contain:

- `signature`: The signature for `permitWitnessTransferFrom`.
- `permit2Authorization`: Parameters to reconstruct the message.

**Important Logic:** The `spender` in the signature is the [**x402Permit2Proxy**](#reference-implementation-x402permit2proxy), not the Facilitator. This Proxy enforces that funds are only sent to the `witness.to` address.

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
      "version": "2",
      "decimals": 6
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
      "spender": "0xx402Permit2ProxyAddress",
      "nonce": "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480",
      "deadline": "1740672154",
      "witness": {
        "to": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        "validAfter": "1740672089",
        "extra": {}
      }
    }
  },
}
```

### Phase 3: Verification Logic

The verifier must execute these checks in order:

1.  **Verify** `payload.signature` is valid and recovers to the `permit2Authorization.from`.

    - Note that `extra` must be converted to its ABI encoded version.

2.  **Verify** that the `client` has enabled the Permit2 approval.

    - if ERC20.allowance(from, Permit2_Address) < amount:
      - Check for **Sponsored ERC20 Approval** (Extension): Refers to [`erc20ApprovalGasSponsoring`](../../extensions/erc20_gas_sponsoring.md).
      - Check for **EIP2612 Permit** (Extension): Refers to [`eip2612GasSponsoring`](../../extensions/eip2612_gas_sponsoring.md).
      - **If neither exists:** Return `412 Precondition Failed` (Error Code: `PERMIT2_ALLOWANCE_REQUIRED`). This signals the client that a one-time Direct Approval transaction is required before retrying.

3.  **Verify** the `client` has sufficient balance of the `asset`.

4.  **Verify** the `permit2Authorization.amount` covers the payment.

5.  **Verify** the `deadline` (not expired) and `witness.validAfter` (active).

6.  **Verify** the Token and Network match the requirement.

7.  **Simulation:**

    - _Standard:_ Simulate `x402Permit2Proxy.settle`.
    - _With "Sponsored ERC20 Approval" (Extension):_ Simulate batch `transfer` -> `approve` -> `settle`.
    - _With "EIP2612 Permit" (Extension):_ Simulate `x402Permit2Proxy.settleWithPermit`.

### Phase 4: Settlement Logic

Settlement is performed by calling the `x402Permit2Proxy`.

1.  **Standard Settlement:**
    If the user has a sufficient direct allowance, call `x402Permit2Proxy.settle`.

2.  **With Sponsored ERC20 Approval (Extension):**
    If `erc20ApprovalGasSponsoring` is used, the facilitator must construct a batched transaction that executes the sponsored `ERC20.approve` call strictly before the `x402Permit2Proxy.settle` call.

3.  **With EIP-2612 Permit (Extension):**
    If `eip2612GasSponsoring` is used, call `x402Permit2Proxy.settleWithPermit`.

---

## Annex

### Canonical Permit2

The Canonical Permit2 contract address can be found at [https://docs.uniswap.org/contracts/v4/deployments](https://docs.uniswap.org/contracts/v4/deployments).

### Reference Implementation: `x402Permit2Proxy`

This contract acts as the authorized Spender. It validates the Witness data to ensure the destination cannot be altered by the Facilitator.

> **Requirement**: This contract will be deployed to the same address across all supported EVM chains using `CREATE2` to ensure consistent behavior and simpler integration.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

// Interface for EIP-2612 Support
interface IERC20Permit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

contract x402Permit2Proxy {
    ISignatureTransfer public immutable PERMIT2;

    event x402PermitTransfer(address from, address to, uint256 amount, address asset);

    // EIP-712 Type Definition
    string public constant WITNESS_TYPE_STRING =
        "Witness witness)Witness(bytes extra,address to,uint256 validAfter)TokenPermissions(address token,uint256 amount)";

    bytes32 public constant WITNESS_TYPEHASH =
        keccak256("Witness(bytes extra,address to,uint256 validAfter)");

    struct Witness {
        address to;
        uint256 validAfter;
        bytes extra;
    }

    // New Struct to group EIP-2612 parameters and reduce stack depth
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
        uint256 amount,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) external {
        _settleInternal(permit, amount, owner, witness, signature);
    }

    /**
     * @notice Extension: Settles a transfer using an EIP-2612 Permit for the allowance
     * @dev Deconstructs the 2612 signature bytes to call the token contract
     */
    function settleWith2612(
        EIP2612Permit calldata permit2612, // Deduplicated/Grouped params
        uint256 amount,
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
        _settleInternal(permit, amount, owner, witness, signature);
    }

    function _settleInternal(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        uint256 amount,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) internal {
        require(block.timestamp >= witness.validAfter, "Too early");
        require(amount <= permit.permitted.amount, "Amount higher than permitted");

        ISignatureTransfer.SignatureTransferDetails memory transferDetails =
            ISignatureTransfer.SignatureTransferDetails({
                to: witness.to,
                requestedAmount: amount
            });

        // Reconstruct hash to enforce witness integrity
        bytes32 witnessHash = keccak256(abi.encode(
            WITNESS_TYPEHASH,
            keccak256(witness.extra),
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
