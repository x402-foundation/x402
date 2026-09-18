# `eip3009-forwarder-split`: atomic fee-splitting settlement for the `exact` scheme on EVM

Status: Proposal (spec-only PR per CONTRIBUTING "PR 1") — revision 2, addressing review
Target: `specs/schemes/exact/` (extension of `scheme_exact_evm.md` via `extra.assetTransferMethod`)
Authors: OpenPay (cipherweb LLC) — production operator of a JPY-stablecoin x402 facilitator

## Motivation

Marketplaces and managed facilitators need to take a service fee per payment. Today the
`exact` scheme on EVM defines a single-recipient transfer (`transferWithAuthorization` to
`payTo`), so fee collection requires either (a) custody (facilitator receives, then
forwards), (b) a second transfer (two signatures, non-atomic), or (c) vendor-specific
extensions that conformant clients cannot verify.

This proposal specifies a **non-custodial, single-signature, atomic fee split**: the payer
signs one EIP-3009 `ReceiveWithAuthorization` to an immutable forwarder contract, and the
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

## Relationship to `auth-capture`

`specs/schemes/auth-capture/scheme_auth_capture_evm.md` already uses the same underlying
trick — an EIP-3009 nonce that doubles as a commitment to an on-chain-enforced fee
split — in service of a two-phase authorize/capture flow. This proposal is the
single-phase counterpart: **no operator role, no escrow contract, no holding period, and
pure `exact` semantics** — funds move payer → merchant + feeReceiver inside one
`settle()` transaction, or not at all. A deployment that needs delayed capture should use
`auth-capture`; one that needs only atomic pay-with-fee should use this method. The two
commitment encodings are intentionally similar; aligning them into one shared encoding is
listed under *Open questions*.

## PaymentRequired additions

`accepts[]` entries use the existing `exact` scheme shape (v2 field names) with:

- `payTo`: the forwarder contract address (not the merchant).
- `amount`: `merchantValue + feeValue` (the total the payer authorizes).
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

`extra.name` / `extra.version` carry the token's EIP-712 domain as in `exact` today.
Any EIP-3009 token with standard transfer semantics works unchanged; see *Scope* under
*Normative on-chain invariants* for the exclusions (fee-on-transfer / rebasing tokens).

## Payment payload

The payload is a standard EIP-3009 `ReceiveWithAuthorization` typed-data signature. The
`authorization` object carries the standard EIP-3009 fields **plus `intentSalt`**, the
client-generated random 32-byte value that enters the commitment:

| `payload.authorization` field | Meaning |
|---|---|
| `from` | payer |
| `to` | `forwarder` (MUST equal `extra.forwarderSplit.forwarder` and `payTo`) |
| `value` | `merchantValue + feeValue` |
| `validAfter` / `validBefore` | validity window |
| `nonce` | the split commitment hash (formula below) |
| `intentSalt` | client-generated random 32 bytes; uniqueness across otherwise-identical intents |

`nonce` is *derived*, never trusted: verifiers MUST recompute it from
`extra.forwarderSplit` + the authorization fields + `intentSalt` and require equality.

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

`commitVersion` pins the encoding (the production deployment uses
`keccak256("openpay.eip3009.forwarder.v1")` =
`0x7ff4e43ca5ec8a7745cdb456a45dc2f4787e1a8dc0ab9121c9941bfb1028ce89`; the value would be
standardized or namespaced per deployment — open question below).

Because EIP-3009 nonces are single-use per (`from`, `nonce`), replay is excluded by the
token contract itself.

**Complete PaymentPayload example** (v2 shape; values match the worked example below):

```jsonc
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "eip155:137",
    "amount": "2000000000000000000",
    "payTo": "0x0F4560a777415580F0680F8B56a79B0022C6B848",
    "maxTimeoutSeconds": 600,
    "asset": "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
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
  },
  "payload": {
    "signature": "0x…65-byte ECDSA signature…",
    "authorization": {
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "to": "0x0F4560a777415580F0680F8B56a79B0022C6B848",
      "value": "2000000000000000000",
      "validAfter": "0",
      "validBefore": "1754300600",
      "intentSalt": "0x5f2c…client-generated random 32 bytes…",
      "nonce": "0x…keccak256 of the commitment tuple above…"
    }
  }
}
```

## Verification logic (facilitator / server)

1. Validate the typed-data signature for the token's EIP-712 domain
   (`primaryType: "ReceiveWithAuthorization"`).
2. Recompute the commitment hash from `extra.forwarderSplit`, the authorization's
   `from` / `validAfter` / `validBefore`, `intentSalt`, `chainId`, and `forwarder`, and
   require it to equal `authorization.nonce`.
3. Require `value == merchantValue + feeValue`, `to == forwarder == payTo`, time window
   open, and (via RPC) that the authorization is unused.

## Settlement logic

The facilitator (or anyone) submits one transaction to the forwarder. Minimal forwarder
interface (matches the production deployment, where `token`, `feeReceiver`, and
`commitVersion` are constructor-set immutables; a variant MAY take them as `settle`
parameters provided every such parameter is covered by the commitment):

```solidity
interface IEip3009ForwarderSplit {
    /// Settles one committed split. Callable by anyone; the caller pays gas only.
    function settle(
        address from,
        address merchant,
        uint256 merchantValue,
        uint256 feeValue,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 intentSalt,
        uint8 v, bytes32 r, bytes32 s
    ) external;

    event Settled(
        address indexed from, bytes32 indexed nonce,
        address merchant, uint256 merchantValue,
        address feeReceiver, uint256 feeValue
    );
}
```

`settle` executes:

1. recompute the commitment hash from the split params and use it as the EIP-3009
   `nonce` (a mismatched split produces a nonce the payer never signed, so step 2
   reverts on signature verification);
2. call `receiveWithAuthorization` on the token (funds move payer → forwarder);
3. transfer `merchantValue` to `merchant` and `feeValue` to `feeReceiver` in the same
   transaction.

The transaction submitter pays gas only and never controls funds. Settlement emits a
single on-chain transaction containing both legs, which makes per-payment accounting and
third-party audit straightforward.

## Normative on-chain invariants

A conformant forwarder:

1. **MUST settle via `ReceiveWithAuthorization` typed data and MUST NOT accept
   `TransferWithAuthorization`.** `receiveWithAuthorization` enforces
   `to == msg.sender` (the payee guard), so only the forwarder itself can execute the
   authorization — and it always executes the split legs in the same transaction. A
   `transferWithAuthorization` signature, by contrast, can be submitted by **any
   observer directly to the token contract**, moving the payer's funds to the forwarder
   with no settlement attached — stranding funds without payment.
2. **MUST derive `value = merchantValue + feeValue` internally and MUST NOT accept an
   independent `value` input.** Accepting a larger `value` would leave a residue inside
   the forwarder with no owner.
3. **MUST use SafeERC20 semantics for both split legs; if either leg fails, the entire
   transaction (including the `receiveWithAuthorization`) MUST revert.** The forwarder
   holds funds only within a single transaction's execution, never across transactions.
4. **MUST reject `intentSalt == bytes32(0)`.** A zero salt makes the nonce fully
   deterministic and collides identical intents (the production contract reverts with a
   dedicated error).
5. **Scope: fee-on-transfer and rebasing tokens are excluded.** The split arithmetic
   assumes `value` received equals `value` authorized; tokens that deduct on transfer or
   rebase balances break that assumption. "Works with any EIP-3009 token" therefore
   applies to tokens with standard transfer semantics only.

The production deployment additionally rejects `merchant == feeReceiver` and
`merchant == forwarder` as accounting footguns; implementations SHOULD do the same.

## Security considerations

- **Split immutability**: the payer's signature covers the nonce, and the nonce commits
  to the full split. Facilitator, merchant, or relayer cannot redirect funds or change
  amounts post-signature.
- **Front-running with the raw signature**: excluded by invariant 1 — the payee guard
  makes the forwarder the only address able to execute the authorization.
- **Bait-and-switch at the catalog layer**: clients SHOULD verify that the money fields
  of a live `PaymentRequired` match a trusted listing (the production buyer SDK compares
  `network`, `asset`, `forwarder`, `merchant`, `merchantValue`, `feeReceiver`,
  `feeValue`, `commitVersion` field-by-field against the marketplace's server-authored
  catalog before signing).
- **Griefing**: an unsettled authorization expires at `validBefore`; no funds move. A
  payer can also front-run `settle` with `cancelAuthorization`, wasting the submitter's
  gas; this is griefing-only (no funds at risk) and facilitators MAY simulate the
  settlement immediately before submission to narrow the window.
- **Custody**: none at any point; the forwarder holds funds only within a single
  transaction's execution (invariant 3).

## Worked example: JPY stablecoin (JPYC v3) on Polygon

The `exact` scheme already accepts arbitrary standard-semantics EIP-3009 assets; this
example doubles as a JPY test vector for the ecosystem (v2 field names throughout):

```jsonc
{
  "scheme": "exact",
  "network": "eip155:137",
  "amount": "2000000000000000000",                // 2 JPYC (price 1 + fee 1)
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
- The production forwarder already enforces invariants 1–4 above (payee-guarded
  `receiveWithAuthorization`, internally derived `value`, SafeERC20 with full revert,
  zero-salt rejection).
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
3. Adding `asset` (one `abi.encode` word) to the commitment so offline verification is
   self-contained rather than relying on the EIP-712 domain check. The production
   commitment encoding is frozen at v1; this is a natural candidate for a spec-level
   `commitVersion` v2, ideally aligned with `auth-capture`'s commitment encoding
   (see *Relationship to auth-capture*).
4. Whether a facilitator-signed receipt format (we issue offline-verifiable receipts) is
   in scope here or belongs in a separate proposal.
