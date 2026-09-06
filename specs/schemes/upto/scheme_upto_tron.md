# Scheme: `upto` on `TRON`

## Summary

The TRON `upto` binding uses Permit2 and `x402UptoPermit2Proxy`. The payer signs a maximum token
amount. After performing the protected work, the resource server supplies an actual settlement
amount no greater than the maximum.

## Networks and Contracts

The Permit2 deployments are listed in the [TRON exact binding](../exact/scheme_exact_tron.md#networks-and-contracts).
The upto proxy deployments are:

| Network | `x402UptoPermit2Proxy` |
| --- | --- |
| `tron:728126428` | `TBLeFPkfDiweBbYmAPqnakaFBPDt9p93sR` |
| `tron:3448148188` | `TKvcqQ7S2bYyys5ZZNpjj9xGiPhiwzHq1K` |
| `tron:2494104990` | `TMxpieW75DQiA9QaoTB1ifJWeQpuppSB1g` |

## Payment Requirements

`extra.assetTransferMethod` MUST be `permit2`. `extra.permit2FacilitatorAddress` MUST contain one
facilitator signer address advertised by `GET /supported`; the client binds it into the witness.

At verification time, `PaymentRequirements.amount` is the authorized maximum. At settlement time,
the resource server replaces it with the actual amount. The signed maximum remains in
`payload.permit2Authorization.permitted.amount`.

## Payment Payload

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "upto",
    "network": "tron:3448148188",
    "amount": "10000",
    "asset": "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
    "payTo": "TReceiverAddress",
    "maxTimeoutSeconds": 60,
    "extra": {
      "assetTransferMethod": "permit2",
      "permit2FacilitatorAddress": "TFacilitatorAddress"
    }
  },
  "payload": {
    "signature": "0x...",
    "permit2Authorization": {
      "from": "0x1111111111111111111111111111111111111111",
      "permitted": {
        "token": "0x2222222222222222222222222222222222222222",
        "amount": "10000"
      },
      "spender": "0x3333333333333333333333333333333333333333",
      "nonce": "1",
      "deadline": "1786500000",
      "witness": {
        "to": "0x4444444444444444444444444444444444444444",
        "facilitator": "0x5555555555555555555555555555555555555555",
        "validAfter": "0"
      }
    }
  }
}
```

The TIP-712 domain is `{ name: "Permit2", chainId, verifyingContract: Permit2 }`. The primary type
is `PermitWitnessTransferFrom`; its `Witness` is `(address to,address facilitator,uint256
validAfter)`.

## Verification

The facilitator MUST verify:

1. Both schemes are `upto` and networks match.
2. `spender` is the configured upto proxy.
3. The witness recipient equals `payTo`.
4. The witness facilitator equals one of its own signer addresses.
5. The authorization is active and has at least six seconds before its deadline.
6. The permitted token equals the requirement asset.
7. The permitted amount equals the verification-time requirement amount.
8. The signature is valid under the configured TRON Permit2 domain.
9. Permit2 allowance and balance cover the maximum when those reads succeed.

## Settlement

Before settlement, the facilitator reconstructs verification requirements using the signed maximum,
then verifies again. It rejects `actualAmount > signedMaximum`.

- For `actualAmount > 0`, it calls `x402UptoPermit2Proxy.settle(permit, actualAmount, owner,
  witness, signature)` and returns `SettleResponse.amount`.
- For `actualAmount == 0`, it returns success with an empty transaction ID and `amount: "0"`; no
  nonce is consumed on-chain.

For a nonzero settlement, the facilitator waits for a receipt using a configurable confirmation
budget (90 seconds by default). If the budget expires, receipt RPC fails, or receipt effect
processing is indeterminate after broadcast, it returns `success: false`,
`errorReason: "settlement_pending"`, and the original transaction ID. An explicit revert is
terminal and also preserves the transaction ID. A caller MUST reconcile the original transaction
and MUST NOT rebroadcast the authorization in response to `settlement_pending`.

## Error Codes

Stable reasons include `invalid_upto_tron_scheme`, `invalid_upto_tron_network_mismatch`,
`unsupported_payload_type`, `invalid_permit2_spender`, `invalid_permit2_facilitator`,
`permit2_amount_mismatch`, `permit2_token_mismatch`, `permit2_allowance_required`,
`upto_settlement_exceeds_amount`, `insufficient_funds`, `settlement_pending`, and
`transaction_failed`.

## Security Considerations

The facilitator witness prevents a different submitter from consuming the authorization. The server
chooses the actual charge, so the payer trusts the server's metering up to the signed maximum. A zero
settlement does not consume the Permit2 nonce and MUST NOT be represented as an on-chain payment.
