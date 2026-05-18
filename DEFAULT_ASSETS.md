# Default Assets for EVM Chains

When a server uses `price: "$0.10"` syntax (USD string pricing), x402 needs to know which stablecoin to use on that chain. Each SDK maintains a map of chain → default stablecoin. This document explains how to add or update these defaults.

For chains without a default, servers can use `registerMoneyParser()` or specify prices directly as a `TokenAmount` with `amountInAtomicUnits`.

## Asset Transfer Methods

x402 supports two methods for transferring assets on EVM:

| Method | Use Case | Notes |
|--------|----------|-------|
| **EIP-3009** (default) | Tokens with `transferWithAuthorization` (e.g., USDC) | Simplest — single signature, no approval step |
| **Permit2** | Any ERC-20 token | Universal fallback — requires one-time Permit2 approval |

If no transfer method is specified, the system defaults to **EIP-3009**.

For Permit2 tokens, also check whether the token implements EIP-2612 `permit()`:
- **Yes** → set `supportsEip2612: true` so clients can use gasless permits for Permit2 approval
- **No** → omit the field; clients fall back to ERC-20 approval gas sponsoring

## Adding a New Chain

### 1. Gather token information

1. Get the stablecoin's contract address on your chain
2. Read the `name()` and `version()` functions from the token contract (these are the EIP-712 domain values)
3. Check whether the token supports EIP-3009 (`transferWithAuthorization`)
4. If not, check whether it supports EIP-2612 (`permit()`)

### 2. Update all three SDKs

Add an entry in each SDK's constants file. All three **must** use the same CAIP-2 key, token address, EIP-712 `name`/`version`, decimals, and transfer method.

<details>
<summary><strong>TypeScript</strong> — <code>typescript/packages/mechanisms/evm/src/shared/defaultAssets.ts</code></summary>

Add to the `DEFAULT_STABLECOINS` map:

```typescript
"eip155:YOUR_CHAIN_ID": {
  address: "0xYOUR_STABLECOIN_ADDRESS",
  name: "Token Name",              // EIP-712 domain name
  version: "1",                    // EIP-712 domain version
  decimals: 6,
  // assetTransferMethod: "permit2",  // Only if token lacks EIP-3009
  // supportsEip2612: true,           // Only for Permit2 tokens with EIP-2612
},
```
</details>

<details>
<summary><strong>Go</strong> — <code>go/mechanisms/evm/constants.go</code></summary>

Add to the `NetworkConfigs` map:

```go
"eip155:YOUR_CHAIN_ID": {
    ChainID: big.NewInt(YOUR_CHAIN_ID),
    DefaultAsset: AssetInfo{
        Address:  "0xYOUR_STABLECOIN_ADDRESS",
        Name:     "Token Name",  // EIP-712 domain name
        Version:  "1",           // EIP-712 domain version
        Decimals: 6,
        // AssetTransferMethod: AssetTransferMethodPermit2,  // Only if token lacks EIP-3009
        // SupportsEip2612:     true,                        // Only for Permit2 tokens with EIP-2612
    },
},
```
</details>

<details>
<summary><strong>Python</strong> — <code>python/x402/mechanisms/evm/constants.py</code></summary>

Add to the `NETWORK_CONFIGS` dict:

```python
"eip155:YOUR_CHAIN_ID": NetworkConfig(
    chain_id=YOUR_CHAIN_ID,
    default_asset=AssetInfo(
        address="0xYOUR_STABLECOIN_ADDRESS",
        name="Token Name",       # EIP-712 domain name
        version="1",             # EIP-712 domain version
        decimals=6,
        # asset_transfer_method=AssetTransferMethod.PERMIT2,  # Only if token lacks EIP-3009
        # supports_eip2612=True,                               # Only for Permit2 tokens with EIP-2612
    ),
),
```
</details>

### 3. Regenerate the paywall when decimals ≠ 6

The HTTP paywall formats human-readable amounts using each chain's default stablecoin decimals. The generated map (`typescript/packages/http/paywall/src/evm/gen/decimals.ts`) only includes chains whose default asset **does not** use 6 decimals; everything else assumes 6.

If your new or updated default uses **any value other than 6** for `decimals`, run the paywall build from `typescript/` and commit the generated artifacts (including `decimals.ts`):

```bash
cd typescript && pnpm --filter @x402/paywall build:paywall
```

See [CONTRIBUTING.md — Paywall Changes](CONTRIBUTING.md#paywall-changes) for the full list of files this command updates. Skip this step when the default asset stays at 6 decimals.

### 4. Submit a PR

Include the chain name and rationale for the asset selection. If the chain team has officially endorsed a stablecoin, mention that.

## Paywall faucet link (recommended for testnets)

The paywall renders a "Need {token} on {chain}? Request some here." link on testnet payment requirements. Without a configured faucet URL, the paywall renders "No faucet configured." instead.

To provide a working faucet link for your testnet, add one line to `typescript/packages/http/paywall/src/faucetUrls.ts`:

```typescript
"eip155:YOUR_TESTNET_CHAIN_ID": "https://your-faucet-url",
```

Paywall-only file; recommended for testnet entries; N/A for mainnet (paywall faucet UI is testnet-gated). No cross-SDK lockstep required — the map is rendered exclusively by the TypeScript paywall bundle and is read by the Python and Go paywall handlers through the bundled template.

## Asset Selection Policy

The default asset is chosen **per chain** based on:

1. **Chain-endorsed stablecoin** — If the chain has officially selected or endorsed a stablecoin, use it.
2. **No official stance** — We encourage the chain team to make the selection and submit a PR.
3. **Community PRs welcome** — Chain teams and community members may submit PRs, provided the EIP-712 domain parameters are correct and the selection aligns with the chain's ecosystem.

## Cross-SDK Checklist

| SDK | File | Map/Dict |
|-----|------|----------|
| **TypeScript** | `typescript/packages/mechanisms/evm/src/shared/defaultAssets.ts` | `DEFAULT_STABLECOINS` |
| **Go** | `go/mechanisms/evm/constants.go` | `NetworkConfigs` |
| **Python** | `python/x402/mechanisms/evm/constants.py` | `NETWORK_CONFIGS` |
