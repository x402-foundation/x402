# Scheme: `exact_gasfree` on `TRON`

## Summary

The client signs a TIP-712 `PermitTransfer` for the network's GasFreeController. The facilitator
verifies the signed terms, submits them to a GasFree relayer, polls until the transaction succeeds or
fails, and returns the resulting TRON transaction ID.

## Networks and Contracts

| Network | GasFreeController | Beacon | Default relayer base URL |
| --- | --- | --- | --- |
| `tron:728126428` | `TFFAMQLZybALaLb4uxHA9RBE7pxhUAjF3U` | `TSP9UW6FQhT76XD2jWA6ipGMx3yGbjDffP` | `https://facilitator.bankofai.io/mainnet` |
| `tron:3448148188` | `THQGuFzL87ZqhxkgqYEryRAd7gqFqL5rdc` | `TLtCGmaxH3PbuaF6kbybwteZcHptEdgQGC` | `https://facilitator.bankofai.io/nile` |
| `tron:2494104990` | `TQghdCeVDA6CnuNVTUhfaAyPfTetqZWNpm` | `TQ1jvA3nLDMDNbJoMPLzTPoqAg8NvZ5CCW` | `https://facilitator.bankofai.io/shasta` |

Deployments MAY override the relayer URL, but MUST retain the controller associated with the selected
network unless using a separately specified GasFree deployment.

## Payment Requirements

`scheme` is `exact_gasfree`; `network` is a supported `tron:*` identifier; `asset`, `amount`, and
`payTo` identify the TRC-20 payment. GasFree provider fees are not included in requirements and MUST
NOT be advertised as `extra.fee`.

## Payment Payload

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact_gasfree",
    "network": "tron:3448148188",
    "amount": "1000",
    "asset": "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
    "payTo": "TReceiverAddress",
    "maxTimeoutSeconds": 60,
    "extra": {}
  },
  "payload": {
    "signature": "0x...",
    "gasfreeAddress": "TGasFreeAddress",
    "gasfree": {
      "token": "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
      "serviceProvider": "TProviderAddress",
      "user": "TPayerAddress",
      "receiver": "TReceiverAddress",
      "value": "1000",
      "maxFee": "1000000",
      "deadline": "1786500000",
      "version": "1",
      "nonce": "7"
    }
  },
  "extensions": {
    "scheme": "exact_gasfree",
    "gasfreeAddress": "TGasFreeAddress"
  }
}
```

The `extensions` fields above are emitted by the current client as compatibility metadata. The
facilitator validates the `payload` fields.

## TIP-712 Authorization

The domain is:

```json
{
  "name": "GasFreeController",
  "version": "V1.0.0",
  "chainId": 3448148188,
  "verifyingContract": "0x..."
}
```

`verifyingContract` is the selected controller normalized to 20-byte hex. The primary type is:

```text
PermitTransfer(
  address token,
  address serviceProvider,
  address user,
  address receiver,
  uint256 value,
  uint256 maxFee,
  uint256 deadline,
  uint256 version,
  uint256 nonce
)
```

The client obtains its GasFree address, activation state, nonce, supported assets, fees, and available
providers from the relayer. `maxFee` is the transfer fee plus activation fee when required. If fee
metadata is unavailable, the current SDK uses one whole token as a conservative fallback.

Mainnet deadlines are clamped to roughly 55–595 seconds from creation; testnet deadlines are clamped
to roughly 55–3595 seconds. A caller-requested deadline below the minimum is rejected.

## Verification

The facilitator MUST:

1. Require a complete `gasfree` object and signature.
2. Match scheme and network.
3. Match token and receiver after TRON address normalization.
4. Require `gasfree.value >= requirements.amount`.
5. Fetch providers and require an exact provider address match. Provider lookup failure or an empty
   list is invalid.
6. Reject an expired deadline.
7. Reconstruct the TIP-712 message and verify the signature against `gasfree.user`.

## Settlement

The facilitator re-verifies, performs a best-effort balance check for `amount + maxFee` at
`gasfreeAddress`, submits the message and signature to `POST /api/v1/gasfree/submit`, and polls the
returned trace ID. Success requires a terminal success/on-chain state and a non-empty transaction
hash that is a valid TRON transaction ID. If polling becomes indeterminate after the relayer has
exposed a valid transaction ID, settlement returns `settlement_pending` with that transaction ID.
This matches the receipt-timeout behavior of the other settlement schemes and does not imply a
Facilitator-managed reconciliation workflow.

## Error Codes

Stable reasons include `invalid_exact_gasfree_scheme`, `invalid_exact_gasfree_network_mismatch`,
`missing_gasfree_payload`, `gasfree_token_mismatch`, `gasfree_amount_mismatch`,
`gasfree_payto_mismatch`, `gasfree_fee_to_mismatch`, `gasfree_expired`,
`invalid_gasfree_signature`, `insufficient_funds`, `gasfree_api_no_response`,
`gasfree_missing_transaction_hash`, `gasfree_invalid_transaction_hash`,
`gasfree_transaction_failed`, `settlement_pending`, and `gasfree_provider_list_unavailable`.

Relayer transport errors may be returned as `errorReason` text by the current implementation.

## Security Considerations

The provider and `maxFee` are signed, preventing facilitator substitution. The account nonce and
deadline limit replay. The facilitator MUST validate the provider list at verification time so that a
payment accepted by `/verify` is likely to be accepted by `/settle`. Operators SHOULD use authenticated
or trusted relayer endpoints and avoid logging full signed payloads.
