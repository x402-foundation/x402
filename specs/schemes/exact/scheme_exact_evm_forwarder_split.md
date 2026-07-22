# `eip3009-forwarder-split`: atomic fee-splitting settlement for the `exact` scheme on EVM

Status: Proposal (spec-only PR per CONTRIBUTING "PR 1")
Target: `specs/schemes/exact/` (extension of `scheme_exact_evm.md` via `extra.assetTransferMethod`)
Authors: OpenPay (cipherweb LLC) — production operator of a JPY-stablecoin x402 facilitator

## Motivation

Marketplaces and managed facilitators need to take a service fee per payment. Today the
`exact` scheme on EVM defines a single-recipient transfer (`transferWithAuthorization` to
`payTo`), so fee collection requires either (a) custody (facilitator receives, then
forwards), (b) a second transfer (two signatures, non-atomic), or (c) vendor-specific
extensions that conformant clients cannot verify.

This proposal specifies a **non-custodial, single-signature, atomic fee split**: the payer
signs one EIP-3009 `receiveWithAuthorization` to an immutable forwarder contract, and the
**authorization nonce itself is a commitment hash over the exact split** (merchant,
merchant amount, fee receiver, fee amount, validity window, chain, forwarder). The
forwarder recomputes the commitment on-chain and reverts unless the split matches, so:

- the facilitator never holds funds (the token contract pays the forwarder, which splits
  in the same transaction);
- neither the facilitator nor the merchant can alter destination or amounts after
  signing;
- clients can verify the full economics of a payment offline before signing.

It has been in production since June 2026 on a JPY-stablecoin marketplace (details in
*Production evidence*), including agent-to-agent purchases where one AI agent bought a
consultation from another AI agent.

## PaymentRequired additions

`accepts[]` entries use the existing `exact` scheme shape with:

- `payTo`: the forwarder contract address (not the merchant).
- `maxAmountRequired`: `merchantValue + feeValue` (the total the payer authorizes).
- `extra.assetTransferMethod`: `"eip3009-forwarder-split"`.
- `extra.forwarderSplit`:

| Field | Type | Meaning |
|---|---|---|
| `forwarder` | address | Immutable split-forwarder contract (equals `payTo`) |
| `merchant` | address | Final recipient of the price |
| `merchantValue` | uint256 (string) | Amount forwarded to `merchant` |
| `feeReceiver` | address | Final recipient of the fee |
| `feeValue` | uint256 (string) | Amount forwarded to `feeReceiver` |
| `commitVersion` | bytes32 | Version tag of the commitment encoding (below) |

`extra.name` / `extra.version` carry the token's EIP-712 domain as in `exact` today, so
**any EIP-3009 token works unchanged** — see the JPY stablecoin worked example.

## Payment payload

The payload is a standard EIP-3009 `ReceiveWithAuthorization` typed-data signature:

- `from`: payer
- `to`: `forwarder`
- `value`: `merchantValue + feeValue`
- `validAfter` / `validBefore`: validity window
- `nonce`: **the split commitment hash** (this is the core of the proposal):

```
nonce = keccak256(abi.encode(
  bytes32 commitVersion,
  address from,
  address merchant,
  uint256 merchantValue,
  address feeReceiver,
  uint256 feeValue,
  uint256 validAfter,
  uint256 validBefore,
  bytes32 intentSalt,
  uint256 chainId,
  address forwarder
))
```

`intentSalt` is a client-generated random 32-byte value providing uniqueness across
otherwise-identical intents. `commitVersion` pins the encoding (the production deployment
uses `keccak256("openpay.eip3009.forwarder.v1")` = `0x7ff4e43ca5ec8a7745cdb456a45dc2f4787e1a8dc0ab9121c9941bfb1028ce89`; the value would be standardized or
namespaced per deployment — open question below).

Because EIP-3009 nonces are single-use per (`from`, `nonce`), replay is excluded by the
token contract itself.

## Verification logic (facilitator / server)

1. Validate the typed-data signature for the token's EIP-712 domain.
2. Recompute the commitment hash from `extra.forwarderSplit` + authorization fields and
   require it to equal `nonce`.
3. Require `value == merchantValue + feeValue`, `to == forwarder`, time window open,
   and (via RPC) that the authorization is unused.

## Settlement logic

The facilitator (or anyone) submits one transaction to the forwarder:
`settle(authorization, signature, split params)`. The forwarder:

1. recomputes the commitment hash from the split params and requires it to equal
   `authorization.nonce` (reverts otherwise — a mismatched split cannot settle);
2. calls `receiveWithAuthorization` on the token (funds move payer → forwarder);
3. transfers `merchantValue` to `merchant` and `feeValue` to `feeReceiver` in the same
   transaction.

The transaction submitter pays gas only and never controls funds. Settlement emits a
single on-chain transaction containing both legs, which makes per-payment accounting and
third-party audit straightforward.

## Security considerations

- **Split immutability**: the payer's signature covers the nonce, and the nonce commits
  to the full split. Facilitator, merchant, or relayer cannot redirect funds or change
  amounts post-signature.
- **Bait-and-switch at the catalog layer**: clients SHOULD verify that the money fields
  of a live `PaymentRequired` match a trusted listing (the production buyer SDK compares
  `network`, `asset`, `forwarder`, `merchant`, `merchantValue`, `feeReceiver`,
  `feeValue`, `commitVersion` field-by-field against the marketplace's server-authored
  catalog before signing).
- **Griefing**: an unsettled authorization expires at `validBefore`; no funds move.
- **Custody**: none at any point; the forwarder holds funds only within a single
  transaction's execution.

## Worked example: JPY stablecoin (JPYC v3) on Polygon

The `exact` scheme already accepts arbitrary EIP-3009 assets; this example doubles as a
JPY test vector for the ecosystem:

```jsonc
{
  "scheme": "exact",
  "network": "eip155:137",
  "maxAmountRequired": "2000000000000000000",     // 2 JPYC (price 1 + fee 1)
  "payTo": "0x0F4560a777415580F0680F8B56a79B0022C6B848",
  "asset": "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29", // JPYC v3
  "extra": {
    "name": "JPY Coin",
    "version": "1",
    "decimals": 18,
    "assetTransferMethod": "eip3009-forwarder-split",
    "forwarderSplit": {
      "forwarder": "0x0F4560a777415580F0680F8B56a79B0022C6B848",
      "merchant": "0x52d4901142e2B5680027da5EB47C86CB02a3cA81",
      "merchantValue": "1000000000000000000",
      "feeReceiver": "0x428483FbA62eDCef1E3a100d3799F6d71759c560",
      "feeValue": "1000000000000000000",
      "commitVersion": "0x7ff4e43ca5ec8a7745cdb456a45dc2f4787e1a8dc0ab9121c9941bfb1028ce89"
    }
  }
}
```

## Production evidence

Running in production at `open-pay.jp` since June 2026 (facilitator endpoints
`/api/facilitator/{supported,verify,settle,verify-receipt}` + public catalog
`/api/discovery`):

- Multiple settled sales on Polygon mainnet, including third-party sellers.
- Agent-to-agent commerce: an AI agent (Claude via MCP) purchased a consultation from
  another AI agent (elizaOS on Internet Computer, fronted by a 402 gateway) for 2 JPYC —
  tx `0xa9e6c6a9ce10fd26ec2fab0d367de31d7fb0918c79d5e932b8566816ecda3249`.
- Open-source consumer/producer implementations: buyer SDK+MCP (`openpay-x402-sdk`,
  `openpay-x402-mcp` on npm), an importable seller gate, and a deploy-in-5-minutes
  no-code gateway template.

The deployed wire currently uses a vendor-prefixed `extra.openpay` object with the same
fields; upon acceptance we would migrate to the standardized `extra.forwarderSplit`
naming (dual-publishing during a transition window).

## Open questions for reviewers

1. Extension point: is `extra.assetTransferMethod` the right home (as with
   `erc20ApprovalGasSponsoring`), or should fee-splitting be a distinct scheme variant?
2. `commitVersion` namespace: standardized constant per spec version vs.
   deployment-scoped tag published in `extra`.
3. Whether a facilitator-signed receipt format (we issue offline-verifiable receipts) is
   in scope here or belongs in a separate proposal.
