# Extension: `erc20ApprovalGasSponsoring`

## Summary

The `erc20ApprovalGasSponsoring` extension enables a **gasless ERC-20 approval flow** for the [`scheme_exact_evm.md`](../schemes/exact/scheme_exact_evm.md) scheme.

Because these tokens lack native gasless approvals:

- The **Client** must sign a normal EVM transaction calling `approve(Permit2, amount)`.
- The **Facilitator** agrees to:

  - Fund the Client’s wallet with enough native gas token **if the Client lacks sufficient funds**.
  - Broadcast the Client’s signed approval transaction.
  - Immediately perform settlement via [`x402Permit2Proxy`](../schemes/exact/scheme_exact_evm.md#reference-implementation-x402permit2proxy) after the approval confirms.

This flow must be executed using an **atomic batch transaction** to mitigate the risk of malicious actors front-running the transaction and intercepting funds between the Facilitator funding step and the final settlement operation.

---

## PaymentRequired

A Facilitator advertises support for this extension by including an `erc20ApprovalGasSponsoring` entry inside the `extensions` object in the **402 Payment Required** response.

```json
{
  "x402Version": "2",
  "accepts": [
    {
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
  ],
  "extensions": {
    "erc20ApprovalGasSponsoring": {
      "info": {
        "description": "The facilitator accepts a raw signed approval transaction and will sponsor the gas fees.",
        "version": "1"
        // Nothing here because everything is populated by the Client
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "from": {
            "type": "string",
            "pattern": "^0x[a-fA-F0-9]{40}$",
            "description": "The address of the sender."
          },
          "asset": {
            "type": "string",
            "pattern": "^0x[a-fA-F0-9]{40}$",
            "description": "The ERC-20 token contract address to approve."
          },
          "spender": {
            "type": "string",
            "pattern": "^0x[a-fA-F0-9]{40}$",
            "description": "The address of the spender (Canonical Permit2)."
          },
          "amount": {
            "type": "string",
            "pattern": "^[0-9]+$",
            "description": "Approval amount (uint256). Typically MaxUint."
          },
          "signedTransaction": {
            "type": "string",
            "pattern": "^0x[a-fA-F0-9]+$",
            "description": "RLP-encoded signed transaction calling ERC20.approve()."
          },
          "version": {
            "type": "string",
            "pattern": "^[0-9]+(\\.[0-9]+)*$", // e.g. "1", "1.0", "1.2.3"
            "description": "Schema version identifier."
          }
        },
        "required": [
          "from",
          "asset",
          "spender",
          "amount",
          "signedTransaction",
          "version"
        ]
      }
    }
  }
}
```

---

## Usage: PaymentPayload

To use this extension:

1. The **Client constructs** a normal Ethereum transaction calling:

   ```
   token.approve(Permit2, amount)
   ```

2. The Client signs this transaction off-chain.

3. The Client inserts the **raw signed transaction hex** under:

```
extensions.erc20ApprovalGasSponsoring
```

### Client Implementation Note

The Client must ensure:

- `maxFee` & `maxPriorityFee` are aligned with the current network prices.
- `nonce` matches the current on-chain nonce of the Client wallet

Incorrect fees or nonce values invalidate the signed transaction.

---

### Example PaymentPayload

```json
{
  "x402Version": "2",
  "accepts": [
    {
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
  ],
  "payload": {
    "signature": "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
    "permit2Authorization": {
      "permitted": {
        "token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "amount": "10000"
      },
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "spender": "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
      "nonce": "33247007178036348590600198031289925668252061821958005840077069883511451257277",
      "deadline": "1740672154",
      "witness": {
        "to": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        "validAfter": "1740672089"
      }
    }
  },
  "extensions": {
    "erc20ApprovalGasSponsoring": {
      "info": {
        "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "spender": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
        "amount": "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        "signedTransaction": "0x505cbf0d9a4a227e0c52c6c2d6a7588d6acca34008c8e8986a12832597641d6293af148b571c73608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3",
        "version": "1"
      }
    }
  }
}
```

---

## Verification Logic

Upon receiving a `PaymentPayload` containing `erc20ApprovalGasSponsoring`:

### 1. Decode the raw signed transaction

- Perform RLP decoding.

### 2. Validate transaction fields

- **Signer** matches `from`
- **`to` address** equals the `asset` contract
- **calldata** corresponds to:

  ```
  approve(spender, amount)
  ```

- **Note**: The Facilitator MUST verify that `spender` in the extension data matches the spender in the decoded transaction and matches the expected contract (e.g., [Canonical Permit2](../schemes/exact/scheme_exact_evm.md#canonical-permit2)).

- **nonce** matches user’s current on-chain nonce
- **maxFee** and **maxPriorityFee** match the current network prices

### 3. Check User Balance

- Check if the user (`from`) has enough native gas tokens to cover the transaction cost.
- If the user has enough balance, the Facilitator skips the funding step.
- If the user lacks balance, the Facilitator calculates the deficit.

### 4. Simulate the full execution sequence

The Facilitator must simulate in a single atomic batch transaction:

1. **Funding** → sending native gas token to the user (if needed)
2. **Approval Relay** → broadcasting the user’s signed approval
3. **Settlement** → calling `x402Permit2Proxy.settle`

---

## Settlement Logic

The Facilitator constructs an **atomic bundle** with the following ordered operations:

1. Gas Funding: If the user has insufficient native gas, send enough native gas token to the user (`from`) to pay for gas used by the approval transaction.

2. Broadcast Approval: Broadcast the Client-provided `signedTransaction` which calls `ERC20.approve(Permit2, amount)`

3. x402PermitProxy Settlement: Call `x402Permit2Proxy.settle()`
