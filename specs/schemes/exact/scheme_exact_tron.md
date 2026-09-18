# Scheme: `exact` on `TRON`

## Summary

The TRON `exact` binding transfers one fixed TRC-20 amount. It supports:

| `extra.assetTransferMethod` | Authorization | Settlement |
| --- | --- | --- |
| `eip3009` or omitted | TIP-712 `TransferWithAuthorization` | Call the token's `transferWithAuthorization` |
| `permit2` | TIP-712 `PermitWitnessTransferFrom` | Call the network's `x402ExactPermit2Proxy.settle` |

TRON Base58Check addresses are used in requirements and deployment configuration. Addresses inside
TIP-712 typed data are normalized to 20-byte, `0x`-prefixed hex by removing the TRON `0x41` network
prefix.

## Networks and Contracts

| Network | CAIP-2 ID | Permit2 | Exact proxy |
| --- | --- | --- | --- |
| Mainnet | `tron:728126428` | `TTJxU3P8rHycAyFY4kVtGNfmnMH4ezcuM9` | `TN49yaJmZMZoEdDCqjB4uPzQLHvYkGw95m` |
| Nile | `tron:3448148188` | `TYQuuhGbEMxF7nZxUHV3uHJxAVVAegNU9h` | `TFGoaq2KjizijgjtkVxT7yjffW1A5T1j6F` |
| Shasta | `tron:2494104990` | `TJMkP7a3ucTMkvi17p7ChhTCw6zriFX3tg` | `TGZkC38n14f2GpBWPMQLF2BpmcpWW3QNhg` |

The numeric TIP-712 `chainId` is the decimal CAIP-2 reference interpreted as an unsigned integer.
Deprecated hexadecimal CAIP-2 aliases may be accepted as inputs during migration, but requirements
and responses use the decimal identifiers above.

## Payment Requirements

The common fields follow the [core specification](../../x402-specification-v2.md#51-paymentrequired-schema).
`extra` contains:

| Field | Required | Meaning |
| --- | --- | --- |
| `assetTransferMethod` | No | `eip3009` (default) or `permit2` |
| `name` | For `eip3009` | Token TIP-712 domain name |
| `version` | For `eip3009` | Token TIP-712 domain version |

The built-in token registry selects Permit2 for mainstream USDT/USDD deployments because those
tokens do not expose TransferWithAuthorization.

## TransferWithAuthorization Payload

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "tron:3448148188",
    "amount": "1000",
    "asset": "TTokenAddress",
    "payTo": "TReceiverAddress",
    "maxTimeoutSeconds": 60,
    "extra": {
      "assetTransferMethod": "eip3009",
      "name": "Example Token",
      "version": "1"
    }
  },
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0x1111111111111111111111111111111111111111",
      "to": "0x2222222222222222222222222222222222222222",
      "value": "1000",
      "validAfter": "0",
      "validBefore": "1786500000",
      "nonce": "0x0000000000000000000000000000000000000000000000000000000000000001"
    }
  }
}
```

The TIP-712 domain is `{ name, version, chainId, verifyingContract = asset }`. The primary type is
`TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256
validBefore,bytes32 nonce)`.

## Permit2 Payload

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "tron:3448148188",
    "amount": "1000",
    "asset": "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
    "payTo": "TReceiverAddress",
    "maxTimeoutSeconds": 60,
    "extra": { "assetTransferMethod": "permit2" }
  },
  "payload": {
    "signature": "0x...",
    "permit2Authorization": {
      "from": "0x1111111111111111111111111111111111111111",
      "permitted": {
        "token": "0x2222222222222222222222222222222222222222",
        "amount": "1000"
      },
      "spender": "0x3333333333333333333333333333333333333333",
      "nonce": "1",
      "deadline": "1786500000",
      "witness": {
        "to": "0x4444444444444444444444444444444444444444",
        "validAfter": "0"
      }
    }
  }
}
```

The TIP-712 domain is `{ name: "Permit2", chainId, verifyingContract: Permit2 }`. The spender MUST
be the configured exact proxy. The witness binds `payTo`; `permitted.token` and `permitted.amount`
bind the asset and exact amount. The payer MUST first grant the Permit2 contract sufficient TRC-20
allowance. The SDK-created client signer automatically broadcasts a one-time unlimited approval when
needed and when its wallet can sign TRON transactions.

## Verification

The facilitator MUST:

1. Match both schemes and the accepted network.
2. Reconstruct typed data using the requirement's network and configured contracts.
3. Verify the payer signature.
4. Match recipient, asset, and exact amount.
5. Require at least six seconds of remaining validity and reject a future `validAfter`.
6. For Permit2, match the exact proxy spender and check Permit2 allowance when readable.
7. Check payer token balance when readable.

Allowance and balance read failures are treated optimistically by the current implementation; all
cryptographic and term checks remain mandatory, and settlement is authoritative.

## Settlement

- TransferWithAuthorization: the facilitator calls the TRC-20 token directly with `(from, to,
  value, validAfter, validBefore, nonce, v, r, s)`.
- Permit2: the facilitator calls `x402ExactPermit2Proxy.settle(permit, owner, witness, signature)`.

The facilitator waits for a receipt using a configurable confirmation budget (90 seconds by
default) and returns the TRON transaction ID. It MUST re-run verification immediately before
broadcasting. If the budget expires, receipt RPC fails, or receipt effect processing is
indeterminate after broadcast, it returns `success: false`, `errorReason: "settlement_pending"`,
and the original transaction ID. An explicit revert is terminal and also preserves the transaction
ID. A caller MUST reconcile the original transaction and MUST NOT rebroadcast the authorization in
response to `settlement_pending`.

## Error Codes

Stable reasons include `invalid_exact_tron_scheme`, `invalid_exact_tron_network_mismatch`,
`invalid_exact_tron_payload_signature`, `invalid_exact_tron_payload_recipient_mismatch`,
`invalid_exact_tron_payload_authorization_value_mismatch`, `invalid_permit2_spender`,
`permit2_amount_mismatch`, `permit2_token_mismatch`, `permit2_allowance_required`,
`insufficient_funds`, `invalid_transaction_state`, `settlement_pending`, and `transaction_failed`.

## Security Considerations

Only configured chain IDs, Permit2 deployments, and proxy deployments may be used. Payload-supplied
addresses MUST NOT replace those constants. Permit2 nonce consumption and token authorization nonces
provide replay protection. The proxy is required because a raw Permit2 authorization without a
recipient-bound witness would let the submitter redirect funds.
