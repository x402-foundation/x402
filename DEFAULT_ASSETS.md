# Default Assets

When a server uses `price: "$0.10"` syntax (USD string pricing), x402 needs to know which stablecoin to use on that network. Each chain-family SDK maintains a **default asset table** that maps networks to USD-pegged tokens the SDK recognizes.

For networks without a configured default, servers can use `registerMoneyParser()` or specify prices directly as an `AssetAmount` with atomic units.

## Per-family convention (TypeScript)

Every mechanism package that supports dollar-string pricing declares defaults in:

```
typescript/packages/mechanisms/<family>/src/defaultAssets.ts
```

### Table shape

Each file exports a `DEFAULT_ASSETS` map keyed by CAIP-2 network identifier. Values are **arrays** of asset entries:

```typescript
export const DEFAULT_ASSETS: DefaultAssetTable<MyAssetInfo> = {
  "eip155:8453": [
    { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC", /* … */ },
  ],
};
```

Each entry uses the `asset` field (not `address`) for the on-chain identifier. Family-specific fields (e.g. EIP-712 `name`/`version` on EVM, `issuer` on XRPL) extend the base `DefaultAsset` type. XRPL copies `issuer` into payment-requirements `extra` at parse time; the client scheme requires that value to match the table before signing RLUSD.

### Two lookups

| Function | Purpose |
|----------|---------|
| `getDefaultAsset(network, symbol?)` | Forward lookup for money parsing. Omit `symbol` for the network default (first list entry). Pass a ticker (e.g. `"USDC"`) to resolve suffixed prices like `"$0.10 USDC"`. **Throws** when the network or symbol is unknown. |
| `findDefaultAsset(asset, network)` | Reverse lookup for spend controls and client-side USD-cap checks. Returns the matching entry or **`undefined`** when the asset is not a known USD-pegged default. |

Scheme clients expose `findDefaultAsset` so `@x402/core`'s `x402Client` can enforce spend limits on recognized stablecoins.

### First entry is the default

The **first** asset in each network's array is what a bare `"$0.10"` resolves to. Additional entries support suffixed prices (`"$0.10 USDT"`) on networks that list more than one USD-pegged token.

### USD-peg invariant

All entries in `DEFAULT_ASSETS` are treated as **USD-pegged**. By default the client only allows assets `findDefaultAsset` recognizes, with a `$1` USD spend cap (`maxAmountPerPayment`). Opt into other tokens via `spendControls.allowedAssets` (list or `true`), or pass `spendControls: false` to disable all spend controls.

Adding non-USD denominations (EUR, JPY, etc.) would require:

- Explicit currency metadata on entries (not just `symbol`)
- Currency-aware money parsing (`parseMoney`) and spend-control logic
- Separate caps per currency rather than a single USD ceiling

Until that exists, only list tokens intended to track USD.


### Go and Python

Go and Python still use address-centric maps (`DEFAULT_STABLECOINS` / `NetworkConfigs.default_asset`) rather than the TypeScript `DEFAULT_ASSETS` table. A follow-up will align naming and multi-asset arrays across SDKs.

## EVM-specific: asset transfer methods

x402 supports two methods for transferring assets on EVM:

| Method | Use Case | Notes |
|--------|----------|-------|
| **EIP-3009** (default) | Tokens with `transferWithAuthorization` (e.g., USDC) | Simplest — single signature, no approval step |
| **Permit2** | Any ERC-20 token | Universal fallback — requires one-time Permit2 approval |

If no transfer method is specified, the system defaults to **EIP-3009**.

For Permit2 tokens, also check whether the token implements EIP-2612 `permit()`:

- **Yes** → set `supportsEip2612: true` so clients can use gasless permits for Permit2 approval
- **No** → omit the field; clients fall back to ERC-20 approval gas sponsoring

EVM entries may also include `assetTransferMethod: "permit2"` and EIP-712 `name`/`version` fields. See `typescript/packages/mechanisms/evm/src/defaultAssets.ts`.

## Adding a new network default

### 1. Gather token information (EVM)

1. Get the stablecoin's contract address on your chain
2. Read the `name()` and `version()` functions from the token contract (EIP-712 domain values)
3. Check whether the token supports EIP-3009 (`transferWithAuthorization`)
4. If not, check whether it supports EIP-2612 (`permit()`)

### 2. Update the family `defaultAssets.ts`

Add an array entry under the CAIP-2 network key in the relevant mechanism package. For EVM:

```typescript
"eip155:YOUR_CHAIN_ID": [
  {
    asset: "0xYOUR_STABLECOIN_ADDRESS",
    name: "Token Name",              // EIP-712 domain name
    version: "1",                    // EIP-712 domain version
    decimals: 6,
    symbol: "USDC",
    // assetTransferMethod: "permit2",  // Only if token lacks EIP-3009
    // supportsEip2612: true,           // Only for Permit2 tokens with EIP-2612
  },
],
```

Non-EVM families use the same `asset` / `decimals` / `symbol` core fields without EIP-712 metadata.

Also update Go/Python constants when those SDKs support the network (see cross-SDK checklist below).

### 3. Regenerate the paywall when decimals ≠ 6 (EVM)

The HTTP paywall formats human-readable amounts using each chain's default stablecoin decimals. The generated map (`typescript/packages/http/paywall/src/evm/gen/decimals.ts`) only includes chains whose default asset **does not** use 6 decimals.

If your new or updated default uses **any value other than 6** for `decimals`, run the paywall build from `typescript/` and commit the generated artifacts:

```bash
cd typescript && pnpm --filter @x402/paywall build:paywall
```

See [CONTRIBUTING.md — Paywall Changes](CONTRIBUTING.md#paywall-changes). Skip this step when the default asset stays at 6 decimals.

### 4. Submit a PR

Include the chain name and rationale for the asset selection. If the chain team has officially endorsed a stablecoin, mention that.

## Paywall faucet link (recommended for testnets)

The paywall renders a "Need {token} on {chain}? Request some here." link on testnet payment requirements. Without a configured faucet URL, the paywall renders "No faucet configured." instead.

Add one line to `typescript/packages/http/paywall/src/faucetUrls.ts`:

```typescript
"eip155:YOUR_TESTNET_CHAIN_ID": "https://your-faucet-url",
```

Paywall-only file; recommended for testnet entries; N/A for mainnet (paywall faucet UI is testnet-gated).

## Asset selection policy

The default asset is chosen **per chain** based on:

1. **Chain-endorsed stablecoin** — If the chain has officially selected or endorsed a stablecoin, use it.
2. **No official stance** — We encourage the chain team to make the selection and submit a PR.
3. **Community PRs welcome** — Chain teams and community members may submit PRs, provided domain parameters are correct and the selection aligns with the chain's ecosystem.

## Cross-SDK checklist

| SDK | File | Map/Dict |
|-----|------|----------|
| **TypeScript** | `typescript/packages/mechanisms/<family>/src/defaultAssets.ts` | `DEFAULT_ASSETS` |
| **Go (EVM)** | `go/mechanisms/evm/constants.go` | `NetworkConfigs` |
| **Python (EVM)** | `python/x402/mechanisms/evm/constants.py` | `NETWORK_CONFIGS` |

TypeScript uses per-family tables; Go/Python EVM maps will converge in a follow-up.
