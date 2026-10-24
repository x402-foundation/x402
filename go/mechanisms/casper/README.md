# Casper Mechanisms

This directory contains payment mechanism implementations for **Casper Network**.

## What This Exports

This package provides scheme implementations for Casper networks that can be used by clients, servers, and facilitators.

## Exact Payment Scheme

The **exact** scheme implementation enables fixed-amount payments of CEP-18 tokens using [CEP-3009](https://github.com/casper-network/ceps/blob/master/text/3009-transfer-with-authorization.md) `transfer_with_authorization`. The client signs an EIP-712 authorization off-chain; the facilitator relays it on-chain and pays the gas. Casper supports the exact scheme only, on x402 v2.

### Export Paths

The exact scheme is organized by role:

#### For Clients

**Import Path:**
```
github.com/x402-foundation/x402/go/v2/mechanisms/casper/exact/client
```

**Exports:**
- `NewExactCasperScheme(signer)` - Creates client-side Casper exact payment mechanism
- Used for creating payment payloads signed with an ed25519 or secp256k1 key
- Falls back to the registered `name`/`version` of a default asset when `extra` omits them

#### For Servers

**Import Path:**
```
github.com/x402-foundation/x402/go/v2/mechanisms/casper/exact/server
```

**Exports:**
- `NewExactCasperScheme()` - Creates server-side Casper exact payment mechanism
- Used for building payment requirements and parsing prices
- Supports custom money parsers via `RegisterMoneyParser()`
- Fills in the network's default asset when none is given, converts decimal amounts for registered assets, and adds the asset's EIP-712 `name`/`version` to `extra`

Custom tokens must be priced in atomic units and must supply `extra.name` and `extra.version`, since their decimals and domain cannot be inferred.

#### For Facilitators

**Import Path:**
```
github.com/x402-foundation/x402/go/v2/mechanisms/casper/exact/facilitator
```

**Exports:**
- `NewExactCasperScheme(signer, config)` - Creates facilitator-side Casper exact payment mechanism
- Used for verifying authorization signatures and settling payments on-chain
- Requires a facilitator signer with Casper RPC integration, e.g. `signers/casper.NewFacilitatorSigner`
- `SetPendingSettlementStore(store)` - Replaces the in-memory settlement-pending store, e.g. with a shared one for multi-replica facilitators

`ExactCasperSchemeConfig` fields (all optional):

| Field | Purpose |
|---|---|
| `LimitedPaymentMotes` | Gas payment for the settlement transaction (default 2.5 CSPR) |
| `LegacyPackagesWithAmountArg` | Token packages whose entry point takes `amount` instead of `value` |
| `SettlementCache` | Duplicate-settlement cache; share one instance across scheme instances |

## Supported Networks

Casper networks using CAIP-2 network identifiers:

- **Casper Mainnet**: `casper:casper`
- **Casper Testnet**: `casper:casper-test`

Use `casper:*` wildcard to support all Casper networks. Other `casper:<chain_name>` networks work when the signer is configured with an RPC URL for them.

### Default Assets

| Network | Asset | Contract package hash | Decimals |
|---|---|---|---|
| `casper:casper` | csprUSD | `23036be872bd574590a2c43d4a4eff76b18b4bca815790742841002fdab22cee` | 6 |
| `casper:casper-test` | csprUSD | `0cb6f94834c60510d532b0ae077b18b4100874a4c867396d61c2b13c790ead52` | 6 |

## Scheme Implementation

The **exact** scheme implements fixed-amount payments:

- **Method**: CEP-3009 `transfer_with_authorization` on a CEP-18 token
- **Signing**: client signs an EIP-712 `TransferWithAuthorization` digest; `publicKey` and `signature` carry a 1-byte algorithm tag (`01` ed25519, `02` secp256k1, low-s enforced)
- **Fees**: transaction gas paid by the facilitator
- **Verification**: signature, payer derived from the public key, amount, recipient, strict validity window, then either `speculative_exec` (when a speculative RPC URL is configured) or targeted state checks of the token contract, payer balance, and nonce at one block
- **Confirmation**: settlement waits for execution; a confirmation timeout returns `settlement_pending` with the transaction hash so the resource server's retry reconciles instead of broadcasting again

## Duplicate Settlement Protection

The facilitator rejects a second concurrent `/settle` of the same authorization (token, payer, nonce) with `duplicate_settlement`, so it never broadcasts two transactions for one nonce and pays gas for the one that fails. Entries are evicted after `casper.SettlementTTL` (120 seconds). Share one cache when several scheme instances serve the same tokens:

```go
import casper "github.com/x402-foundation/x402/go/v2/mechanisms/casper"
import casperfacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/casper/exact/facilitator"

cache := casper.NewSettlementCache()
config := &casperfacilitator.ExactCasperSchemeConfig{SettlementCache: cache}

mainnetScheme := casperfacilitator.NewExactCasperScheme(signer, config)
testnetScheme := casperfacilitator.NewExactCasperScheme(signer, config)
```

## Related Documentation

- **[Mechanisms Overview](../README.md)** - About mechanisms in general
- **[Casper Signers](../../signers/casper/README.md)** - Client and facilitator signer helpers
- **[Exact Casper Scheme Specification](../../../specs/schemes/exact/scheme_exact_casper.md)** - Wire format and verification rules
