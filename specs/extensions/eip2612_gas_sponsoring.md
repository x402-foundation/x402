# Extension: `eip2612GasSponsoring`

## Summary

The `eip2612GasSponsoring` extension enables a "gasless" approval flow to the `Permit` Contract for tokens that implement **EIP-2612** for the [`scheme_exact_evm.md`](../schemes/exact/scheme_exact_evm.md) scheme.

When this extension is active, the Facilitator agrees to accept this off-chain signature and submit it to the blockchain on the user's behalf, paying the gas fees.

## `PaymentRequired`

A Facilitator advertises support for this extension by including the `eip2612GasSponsoring` key in the `extensions` object of the `402 Payment Required` response.

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
    "eip2612GasSponsoring": {
      "info": {
        "description": "The facilitator accepts EIP-2612 gasless Permit to `Permit2` canonical contract.",
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
            "description": "The address of the ERC-20 token contract."
          },
          "spender": {
            "type": "string",
            "pattern": "^0x[a-fA-F0-9]{40}$",
            "description": "The address of the spender (Canonical Permit2)."
          },
          "amount": {
            "type": "string",
            "pattern": "^[0-9]+$",
            "description": "The amount to approve (uint256). Typically MaxUint."
          },
          "nonce": {
            "type": "string",
            "pattern": "^[0-9]+$",
            "description": "The current nonce of the sender."
          },
          "deadline": {
            "type": "string",
            "pattern": "^[0-9]+$",
            "description": "The timestamp at which the signature expires."
          },
          "signature": {
            "type": "string",
            "pattern": "^0x[a-fA-F0-9]+$",
            "description": "The 65-byte concatenated signature (r, s, v) as a hex string."
          },
          "version": {
            "type": "string",
            "pattern": "^[0-9]+(\\.[0-9]+)*$",
            "description": "Schema version identifier."
          }
        },
        "required": [
          "from",
          "asset",
          "spender",
          "amount",
          "nonce",
          "deadline",
          "signature",
          "version"
        ]
      }
    }
  }
}
```

## Usage: `PaymentPayload`

To utilize this extension, the client must generate a valid EIP-2612 signature and include it in the `eip2612GasSponsoring` under the key `extensions`.

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
    "eip2612GasSponsoring": {
      "info": {
        "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "spender": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
        "amount": "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        "nonce": "0",
        "deadline": "1740672154",
        "signature": "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
        "version": "1"
      }
    }
  }
}
```

## Verification Logic

When the Facilitator receives a payload containing `eip2612GasSponsoring` data, they must verify the following:

1.  **Verify** the `asset` address actually implements `IERC20Permit`.
2.  **Verify** the `signature` was signed for the `spender` and recovers to `from`.
    - **Note**: The Facilitator MUST verify that `spender` matches the expected contract (e.g., [Canonical Permit2](../schemes/exact/scheme_exact_evm.md#canonical-permit2)).
3.  **Simulate** `x402Permit2Proxy.settleWithPermit`

## Settlement Logic

The Settlement is performed by calling the [`x402Permit2Proxy.settleWithPermit`](../schemes/exact/scheme_exact_evm.md#reference-implementation-x402permit2proxy).
