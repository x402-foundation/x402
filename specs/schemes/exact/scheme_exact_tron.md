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

## Payment Flow and Resource Costs

Both methods are facilitator-submitted and support the `authorization` payment flow
(verify → resource → settle), which is the default. This binding does not define additional payment
flows. An absent `extra.paymentFlow` means `authorization`.

The facilitator submits and pays the Energy/Bandwidth cost of settlement. The payer signs the payment
authorization off-chain. Permit2's initial TRC-20 approval is a separate payer-signed transaction;
this binding does not sponsor its resource cost.

| Method | Replay primitive | Bounded validity window |
| --- | --- | --- |
| `eip3009` | Token authorization nonce for the payer | Signed `validAfter` and `validBefore` |
| `permit2` | Permit2 unordered nonce for the payer | Signed witness `validAfter` and permit `deadline` |

Distinct unused nonces allow concurrent authorizations; they do not reserve the payer's balance or
allowance. Balance changes, allowance revocation, nonce cancellation, or expiry can invalidate a
payment after verification. The remaining validity must cover resource execution and settlement.

Each settlement submits a contract call for the signed authorization. Re-executing that authorization
in another transaction is distinguishable by the contract's consumed nonce and MUST fail, rather
than return the earlier transaction's success. Re-submission of the same transaction ID is not a new
payment and MUST NOT authorize another resource delivery. After an indeterminate broadcast outcome,
reconcile the original transaction as described below instead of treating a retry as a new payment.

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

The common fields follow the [core specification](../../x402-specification-v2.md).
`extra` contains:

| Field | Required | Meaning |
| --- | --- | --- |
| `assetTransferMethod` | No | `eip3009` (default) or `permit2` |
| `paymentFlow` | No | `authorization` (default and only supported flow) |
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
allowance. Approval amount and wallet prompting are client policies, not part of the signed payment
payload. The downstream SDK-created signer can broadcast an unlimited approval when needed and when
its wallet can sign TRON transactions; this is not a protocol requirement.

## Verification

The facilitator MUST:

1. Match both schemes and the accepted network, and reject unsupported transfer methods or payment
   flows. The payload MUST use the transfer method selected by the requirements.
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

The facilitator MUST construct only the configured token or exact proxy call from the verified
parameters; it MUST NOT execute arbitrary payload-supplied calls. Settlement MUST transfer exactly
`requirements.amount` of `requirements.asset` from the payer to `requirements.payTo`, and MUST NOT
debit the facilitator beyond the settlement resource cost. Tokens whose transfer behavior does not
satisfy this exact-amount requirement are not supported by this binding.

A transaction ID or successful broadcast alone is not settlement success. The facilitator MUST
confirm successful execution of the submitted transaction and the expected exact transfer. A revert,
including a consumed authorization nonce, MUST return failure. Confirmation policy is owned by the
facilitator; the waiting budget bounds polling and does not turn an unknown outcome into success.

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
