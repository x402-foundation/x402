# Extension: `swap-settlement`

**Status:** Draft 2 (aligned with the technical architecture document)

## Summary

The `swap-settlement` extension enables **token-agnostic payments**: a payer can satisfy a `PaymentRequirements` entry denominated in one asset (e.g. USDC) while holding a different asset (e.g. WETH, cbBTC) **on the same network**. The facilitator atomically swaps the payer's input asset and delivers the exact required asset and amount to `payTo` in a single settlement transaction.

The resource server is unaffected: it declares its requirements in the required asset as usual and always receives exactly that asset and amount. All swap complexity lives between the client and the facilitator.

This extension is same-chain only. Cross-chain settlement is explicitly out of scope (see [Future Work](#future-work)).

## Motivation

x402's `exact` scheme fixes `asset` in `PaymentRequirements`. In practice, payers (especially autonomous agents) frequently hold value in assets other than the one required (ETH/WETH, BTC via cbBTC/WBTC, or protocol tokens) and cannot pay without a manual out-of-band swap, which breaks the machine-payment flow entirely.

This extension closes that gap while preserving x402's core invariants:

- The resource server's integration is unchanged.
- Settlement remains atomic: either the exact required asset reaches `payTo`, or the transaction reverts.
- The payer signs a single off-chain authorization; no protocol-level requirement for the payer to hold gas.

## Terminology

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as described in RFC 2119.

- **Input asset** — the asset the payer holds and authorizes.
- **Required asset** — the `asset` in the selected `accepts[]` entry.
- **Settler** — the on-chain contract that executes acquire → swap → deliver atomically (reference: [`x402SwapSettler`](#reference-implementation-x402swapsettler)).
- **Quote** — a facilitator commitment, identified by `quoteId`, specifying how much input asset is required to produce the exact required amount, valid until `expiresAt`.

## Canonical Encodings

Two 32-byte values bind signatures to a specific quote and specific payment requirements:

```
quoteIdHash      = keccak256(utf8(quoteId))
requirementsHash = keccak256(jcs(paymentRequirements))
```

where `jcs` is RFC 8785 (JSON Canonicalization Scheme) serialization of the selected `accepts[]` entry. Implementations MAY support only the JSON subset that `accepts[]` entries can contain (strings, objects, arrays, booleans, null, and integers within the IEEE-754 safe range) and MUST fail closed — reject rather than hash — on values outside that subset, so no two implementations can derive different bytes for the same entry.

- The **wire format** always carries the opaque string `quoteId`.
- All **signed structures** and **on-chain state** carry `quoteIdHash`.
- Facilitators MUST return `requirementsHash` in the quote response. Clients MUST independently recompute `requirementsHash` from the `402` response they received and MUST NOT sign if it differs from the quoted value.

## Scope

| In scope | Out of scope |
| --- | --- |
| Same-chain swaps on EVM networks (`eip155:*`) | Cross-chain settlement (bridging) |
| `exact` scheme | Other schemes (composability noted in Future Work) |
| Authorization via EIP-3009, Permit2, EIP-2612, and pre-existing ERC-20 allowance | Native (unwrapped) gas-token inputs |
| Exact-output swaps (output amount is fixed by `accepts[].amount`) | Exact-input swaps |

## Roles and Trust Model

- The **payer** authorizes the settler to pull **at most** `maxAmountIn` of the input asset for a specific quote. The payer's exposure is bounded by `maxAmountIn` per authorization.
- The **facilitator** sources swap routes (via any DEX aggregator or its own routing — this specification is deliberately **provider-agnostic**), operates the settler, and bears execution risk between quoting and settlement.
- The **resource server** trusts nothing new. It receives the exact required asset and amount, verified identically to a plain `exact` payment.

Authorization methods differ in how strongly the signature is bound to the quote (see [Authorization Methods](#authorization-methods)). Where the canonical Permit2 contract is available and approved, clients SHOULD prefer `permit2` for its witness binding.

## `PaymentRequired`

A resource server (whose facilitator supports this extension) advertises support by including the `swap-settlement` key in the `extensions` object of the `402 Payment Required` response.

Because swap quotes are short-lived and the 402 response may be cached, the 402 response carries **discovery data only**; live quotes are obtained from `quoteUrl`.

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "10000000",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60,
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "extra": { "name": "USD Coin", "version": "2" }
    }
  ],
  "extensions": {
    "swap-settlement": {
      "info": {
        "version": "1",
        "description": "Pay in a different same-chain asset; the facilitator swaps and settles atomically.",
        "quoteUrl": "https://facilitator.example.com/x402/swap/quote",
        "networks": ["eip155:8453", "eip155:42161"],
        "authorizationMethods": ["eip3009", "permit2", "eip2612", "allowance"]
      }
    }
  }
}
```

### `info` fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | string | Yes | Extension version. `"1"` for this specification. |
| `quoteUrl` | string (URL) | Yes | Endpoint for requesting swap quotes. |
| `networks` | string[] | Yes | CAIP-2 networks on which swap settlement is available. |
| `authorizationMethods` | string[] | Yes | Subset of `["eip3009", "permit2", "eip2612", "allowance"]` the facilitator accepts. |
| `inputAssetsUrl` | string (URL) | No | Endpoint listing supported input assets per network. Facilitators MUST curate this list (see [Security Considerations](#security-considerations)). |

## Quote API

### Request

`POST {quoteUrl}`

```json
{
  "x402Version": 2,
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:8453",
    "amount": "10000000",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "maxTimeoutSeconds": 60
  },
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "inputAsset": "0x4200000000000000000000000000000000000006"
}
```

`paymentRequirements` MUST be the exact `accepts[]` entry the client intends to satisfy. The client selects `inputAsset` (by configuration, balance discovery, or user choice); facilitators MUST NOT choose an input asset on the payer's behalf. `inputAsset` MUST differ from `paymentRequirements.asset`; same-asset requests are plain `exact` payments and MUST be rejected with `input_asset_not_supported`.

### Response

```json
{
  "quoteId": "q_8f14e45fceea167a",
  "requirementsHash": "0x7d5a...c3f1",
  "network": "eip155:8453",
  "inputAsset": "0x4200000000000000000000000000000000000006",
  "maxAmountIn": "3021500000000000",
  "settler": "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
  "expiresAt": "2026-07-04T12:00:30Z",
  "fees": {
    "facilitatorFee": "15000000000000",
    "estimatedRouteFee": "9000000000000"
  },
  "authorizationMethods": [
    { "method": "eip3009", "ready": true },
    { "method": "permit2", "ready": true, "spender": "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
    { "method": "eip2612", "ready": true, "spender": "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
    { "method": "allowance", "ready": false, "spender": "0x402085c248EeA27D92E8b30b2C58ed07f9E20001" }
  ]
}
```

| Field | Description |
| --- | --- |
| `quoteId` | Opaque, single-use identifier. Facilitators MUST reject reuse. |
| `requirementsHash` | See [Canonical Encodings](#canonical-encodings). Clients MUST recompute locally and compare before signing. |
| `maxAmountIn` | Maximum input-asset amount the settler may pull, inclusive of all fees and slippage buffer. The payer's total exposure. |
| `settler` | The settler contract address for this network. |
| `expiresAt` | Quote expiry. Facilitators SHOULD set 30–60 seconds. Clients MUST obtain a fresh quote after expiry. |
| `fees` | Transparent fee breakdown, denominated in the input asset. `facilitatorFee` MUST include any spread charged by the facilitator. |
| `authorizationMethods` | Per-method readiness for **this payer, input asset, and network**. `ready: false` on `allowance`/`permit2` indicates a missing on-chain approval; the client may fall back to another method or perform a one-time approval. |

Facilitators MUST compute quotes in **exact-output** mode: `maxAmountIn` is sized such that the swap yields at least `paymentRequirements.amount` of the required asset.

## Usage: `PaymentPayload`

The client submits the **original, unmodified** `accepts[]` entry (this is the invariant that keeps resource servers unaware of the swap) and places swap data under `extensions["swap-settlement"]`.

Exactly one authorization object MUST be present, matching the chosen `method`.

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "10000000",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60,
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "extra": { "name": "USD Coin", "version": "2" }
    }
  ],
  "payload": {},
  "extensions": {
    "swap-settlement": {
      "info": {
        "version": "1",
        "quoteId": "q_8f14e45fceea167a",
        "inputAsset": "0x4200000000000000000000000000000000000006",
        "method": "permit2",
        "permit2Authorization": {
          "permitted": {
            "token": "0x4200000000000000000000000000000000000006",
            "amount": "3021500000000000"
          },
          "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          "spender": "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
          "nonce": "33247007178036348590600198031289925668252061821958005840077069883511451257277",
          "deadline": "1740672154",
          "witness": {
            "quoteIdHash": "0x5c1f...aa02",
            "requirementsHash": "0x7d5a...c3f1",
            "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
            "outputAsset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "outputAmount": "10000000"
          },
          "signature": "0x2d6a...b571c"
        }
      }
    }
  }
}
```

## Authorization Methods

All methods authorize the settler to acquire **at most** `maxAmountIn` of the input asset. They differ in mechanism and quote binding.

### `permit2`

For any ERC-20 where the payer has approved the [canonical Permit2 contract](../schemes/exact/scheme_exact_evm.md#canonical-permit2).

- The client signs `PermitWitnessTransferFrom` with `spender = settler`, `permitted.amount = maxAmountIn`.
- **Quote binding:** the witness is the strongest binding: the signature is invalid for any other quote, recipient, output asset, or amount.

The witness struct and typestring are **normative**. They are never transmitted on the wire and always used when signing and verifying:

```solidity
struct SwapWitness {
    bytes32 quoteIdHash;
    bytes32 requirementsHash;
    address payTo;
    address outputAsset;
    uint256 outputAmount;
}
```

```
witnessTypeString =
  "SwapWitness witness)"
  "SwapWitness(bytes32 quoteIdHash,bytes32 requirementsHash,address payTo,"
  "address outputAsset,uint256 outputAmount)"
  "TokenPermissions(address token,uint256 amount)"
```

Permit2 verifies both ECDSA and EIP-1271 signatures, so smart-account payers are supported on this method without additional protocol surface.

### `eip3009`

For input assets implementing EIP-3009 (e.g. USDC-codebase tokens such as cbBTC, EURC).

- The client signs `ReceiveWithAuthorization` with `to = settler`, `value = maxAmountIn`, `validBefore ≤ expiresAt`.
- **Quote binding:** the 32-byte `nonce` MUST equal `keccak256(abi.encode(quoteIdHash, requirementsHash))`. Verifiers MUST recompute and compare; the reference settler additionally enforces this on-chain.
- Settlement calls `receiveWithAuthorization`, which requires the caller to be the payee (`to`), making the settler the sole valid submitter (front-running-safe, per EIP-3009).

```json
"eip3009Authorization": {
  "from": "0x857b...6b66",
  "to": "0x4020...0001",
  "value": "3021500000000000",
  "validAfter": "0",
  "validBefore": "1740672154",
  "nonce": "0x5c1f...aa02",
  "signature": "0x..."
}
```

### `eip2612`

For input assets implementing EIP-2612 where no Permit2 approval exists yet.

- The client signs `permit(owner, spender, value, deadline)` with `spender` as returned in the quote (the canonical Permit2 contract, RECOMMENDED, mirroring [`eip2612GasSponsoring`](./eip2612_gas_sponsoring.md); or the settler directly) and `value ≥ maxAmountIn`.
- The facilitator submits the permit and the settlement in a single transaction.
- **Quote binding:** EIP-2612 cannot carry a witness; the permit only grants allowance. When `spender` is Permit2, the client MUST additionally provide a `permit2Authorization` (with witness) and the permit serves purely as gasless approval bootstrap; full witness binding is retained. When `spender` is the settler directly, binding is enforced off-chain: the facilitator MUST pull funds only in a settlement transaction for the referenced `quoteId`, and clients accept the facilitator trust model described in [Roles and Trust Model](#roles-and-trust-model). Clients SHOULD prefer the Permit2-bootstrap form.
- Implementations MUST tolerate permit front-running (a third party submitting the observed permit signature directly): if the on-chain `permit` call fails but the resulting allowance is sufficient, settlement MUST proceed.
- EIP-712 domain parameters (`name`, `version`) MUST be read from the token contract, not hardcoded. Tokens with non-standard permit schemes (e.g. DAI) MUST NOT be offered on this method; they fall back to `permit2` or `allowance`.

### `allowance`

For payers with a pre-existing direct ERC-20 allowance to the settler (set manually, once, on-chain).

- No token-level signature is possible. The client authenticates the payment intent by signing an EIP-712 `SwapSettlementIntent`:

```solidity
struct SwapSettlementIntent {
    bytes32 quoteIdHash;
    bytes32 requirementsHash;
    address inputAsset;
    uint256 maxAmountIn;
    uint256 deadline;
}
```

with domain `{ name: "x402 swap-settlement", version: "1", chainId: <network>, verifyingContract: <settler> }`. Binding the domain to the settler address scopes intents to a single settler deployment; a settler version migration naturally invalidates outstanding intents.

- Verifiers MUST accept ECDSA signatures and SHOULD accept EIP-1271 signatures when the payer address has code.
- The settler pulls via `transferFrom`, bounded by `maxAmountIn`.
- This method exists to cover tokens with neither EIP-3009 nor EIP-2612 support and no Permit2 approval (e.g. first-time WETH, WBTC, most USDT deployments), at the cost of one prior on-chain approval by the payer.

## Verification Logic

Upon receiving a payload containing `swap-settlement` data, the facilitator MUST verify:

1. `quoteId` exists, is unexpired, is unconsumed, and was issued for this `payer`, `inputAsset`, and `requirementsHash`.
2. The `accepts[]` entry in the payload matches the quoted `paymentRequirements` exactly (recompute `requirementsHash` per [Canonical Encodings](#canonical-encodings)).
3. The authorization is valid for the declared `method`:
   - signature recovers to `payer` (or validates via EIP-1271 where the method supports contract signers);
   - amounts, `spender`/`to`, deadlines, and nonces match the quote;
   - for `eip3009`: `nonce == keccak256(abi.encode(quoteIdHash, requirementsHash))`;
   - for `permit2`: witness fields match the quote and requirements.
4. The payer's input-asset balance (and, for `permit2`/`allowance`, the relevant on-chain allowance) covers `maxAmountIn`.
5. A fresh route simulation of the full settlement transaction succeeds and yields `≥ amount` of the required asset. If market movement makes the quote unfillable within `maxAmountIn`, verification MUST fail with `quote_unfillable` rather than settle at a loss to the payer beyond `maxAmountIn`.

## Settlement Logic

Settlement MUST be a **single atomic transaction** through the settler that:

1. Acquires up to `maxAmountIn` of the input asset from the payer via the authorized method.
2. Executes the swap through a facilitator-whitelisted swap target. Swap calldata is constructed **server-side by the facilitator**; clients MUST NOT be able to inject execution calldata.
3. Enforces on-chain: `balanceAfter(requiredAsset) − balanceBefore ≥ amount`, measured as a delta within the transaction. This check MUST live in the settler, independent of any guarantees from the routing provider.
4. Transfers **exactly** `amount` of the required asset to `payTo`.
5. Refunds all surplus — unspent input asset and any output asset in excess of `amount` — to the payer within the same transaction. The facilitator's compensation MUST NOT exceed the quoted `fees`.
6. Emits `SwapSettled(quoteIdHash, payer, inputAsset, amountIn, outputAsset, amount, payTo, facilitatorFee)`.

If any step fails, the entire transaction MUST revert; no partial state (including fee collection) may persist.

Replay protection is layered and each layer is REQUIRED where applicable:

- The settler MUST maintain a consumed set keyed by `quoteIdHash` and MUST revert on reuse.
- The facilitator MUST mark `quoteId` consumed upon successful settlement and MUST NOT reuse a consumed or expired quote.
- Method-native replay protection (Permit2 nonces, EIP-3009 authorizer state) applies unchanged.

The settlement response returned to the resource server is a standard `exact` settlement response; the `transaction` field references the settler transaction. Facilitators MAY enrich the settlement response with `extensions["swap-settlement"].info = { quoteId, inputAsset, amountIn }` for client accounting.

## Errors

Facilitators MUST use these error codes in verification/settlement failures related to this extension:

| Code | Meaning |
| --- | --- |
| `input_asset_not_supported` | The requested input asset is not on the facilitator's curated list for this network, or equals the required asset. |
| `quote_not_found` | Unknown `quoteId`. |
| `quote_expired` | `expiresAt` has passed. |
| `quote_consumed` | `quoteId` was already settled or is being settled. |
| `quote_unfillable` | Re-simulation cannot deliver `amount` within `maxAmountIn`. Client SHOULD re-quote. |
| `authorization_invalid` | Signature, nonce, deadline, amount, or binding check failed. |
| `approval_required` | Chosen method requires an on-chain approval the payer has not made (`ready: false`). |
| `insufficient_input_balance` | Payer balance below `maxAmountIn`. |

## Security Considerations

- **No client calldata.** The single largest attack surface in swap systems is arbitrary execution data. Clients reference quotes by `quoteId` only; all route calldata is generated and custodied by the facilitator, and the settler MUST restrict swap calls to a whitelisted set of swap targets.
- **Quote binding and replay.** `quoteId` is single-use; the `eip3009` nonce derivation and the `permit2` witness bind signatures to one quote; the settler's consumed set and method-native nonces provide on-chain backstops. Facilitators MUST enforce single settlement per quote even across concurrent requests (idempotency at the settlement layer).
- **Bounded payer exposure.** Under every method, the payer's worst case is loss of at most `maxAmountIn` of the input asset in exchange for the payment being made. The on-chain minimum-output check and same-transaction surplus refund make under-delivery or fee inflation revert.
- **Input asset curation.** Facilitators MUST maintain an allowlist of input assets verified against authoritative sources. Honeypot tokens impersonating major assets (including tokens with backdoored `allowance`/`transferFrom` behavior) specifically target automated swap infrastructure. Fee-on-transfer and rebasing tokens MUST NOT be listed in version 1.
- **MEV.** Facilitators SHOULD submit settlement transactions through private order flow where available; the on-chain minimum-output check bounds sandwich damage to the quoted slippage buffer in all cases.
- **Token behavior edge cases.** Tokens with issuer blocklists (e.g. USDC-codebase assets) can cause settlement reverts; this is safe (atomicity) but SHOULD surface as a distinct error to the client.
- **EIP-712 hygiene.** Domain parameters for `eip2612` MUST be read on-chain per deployment. Implementations MUST reject signatures recovering to the zero address.

## Reference Implementation: `x402SwapSettler`

A reference settler is non-upgradeable, deployed deterministically (CREATE2) at the same address on every supported chain, restricts settlement entrypoints to facilitator-authorized callers, and exposes, per authorization method:

```solidity
function settleWith3009(Quote calldata q, EIP3009Auth calldata a, bytes calldata routeData) external onlyFacilitator;
function settleWithPermit2(Quote calldata q, Permit2WitnessAuth calldata a, bytes calldata routeData) external onlyFacilitator;
function settleWith2612(Quote calldata q, EIP2612Permit calldata p, Permit2WitnessAuth calldata a, bytes calldata routeData) external onlyFacilitator;
function settleWithAllowance(Quote calldata q, IntentAuth calldata a, bytes calldata routeData) external onlyFacilitator;
```

where

```solidity
struct Quote {
    bytes32 quoteIdHash;
    bytes32 requirementsHash;
    address payer;
    address inputAsset;
    uint256 maxAmountIn;
    uint256 facilitatorFee;
    address outputAsset;
    uint256 outputAmount;
    address payTo;
    address swapTarget;
    uint256 deadline;
}
```

and each function implements the acquire → swap (whitelisted `swapTarget`) → minimum-output check → exact delivery → surplus refund → event sequence described in [Settlement Logic](#settlement-logic), with delta-based balance accounting and a consumed-quote guard. The `SwapWitness` typestring and `SwapSettlementIntent` types defined in this specification are normative; the full reference implementation accompanies this specification.

## Backwards Compatibility

- Resource servers require no changes; `accepts[]`, verification results, and settlement responses are indistinguishable from plain `exact` payments.
- Clients that do not implement this extension ignore the `extensions["swap-settlement"]` key and pay normally.
- Facilitators that do not implement it never advertise it; payloads containing it against a non-supporting facilitator fail standard payload validation.

## Future Work

- **Cross-chain settlement profile** with an explicit `pending → settled | failed → refunded` state machine and economically (not atomically) guaranteed fills, referencing ERC-7683 order formats.
- **`upto` scheme composability** (swap-backed metered payments).
- **Non-EVM networks** (Solana) with method sets appropriate to those runtimes.
- **Native gas-token input** via wrapping within the settler.
