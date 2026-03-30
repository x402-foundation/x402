# Default Assets for EVM Chains

This document explains how to add a default stablecoin asset for a new EVM chain.

## Overview

When a server uses `price: "$0.10"` syntax (USD string pricing), x402 needs to know which stablecoin to use for that chain. The default asset is configured in `constants.go` within the `NetworkConfigs` map.

## Adding a New Chain

To add support for a new EVM chain, add an entry to the `NetworkConfigs` map in `constants.go`:

```go
NetworkConfigs = map[string]NetworkConfig{
    // ... existing chains ...

    // Your New Chain
    "eip155:YOUR_CHAIN_ID": {
        ChainID: big.NewInt(YOUR_CHAIN_ID),
        DefaultAsset: AssetInfo{
            Address:  "0xYOUR_STABLECOIN_ADDRESS",
            Name:     "Token Name",  // Must match EIP-712 domain name
            Version:  "1",           // Must match EIP-712 domain version
            Decimals: 6,             // Token decimals (e.g. 6 for USDC)
            // AssetTransferMethod: AssetTransferMethodPermit2,  // Uncomment if token doesn't support EIP-3009
            // SupportsEip2612:     true,                        // Set if permit2 token implements EIP-2612 permit()
        },
    },
}
```

### Required Fields

| Field | Description |
|-------|-------------|
| `ChainID` | The chain's numeric ID as `*big.Int` |
| `Address` | Contract address of the stablecoin |
| `Name` | EIP-712 domain name (must match the token's domain separator) |
| `Version` | EIP-712 domain version (must match the token's domain separator) |
| `Decimals` | Token decimal places (typically 6 for USDC) |
| `AssetTransferMethod` | *(Optional)* Transfer method override: set to `AssetTransferMethodPermit2` for tokens that don't support EIP-3009. Omit for EIP-3009 tokens (default behavior). |
| `SupportsEip2612` | *(Optional)* Set to `true` for Permit2 tokens that implement EIP-2612 `permit()`. When true, clients can use gasless EIP-2612 permits for Permit2 approval. When false/absent on a Permit2 token, clients fall back to ERC-20 approval gas sponsoring. Ignored for EIP-3009 tokens. |

## Asset Transfer Methods

x402 supports two methods for transferring assets:

| Method | Use Case | Recommendation |
|--------|----------|----------------|
| **EIP-3009** | Tokens with native `transferWithAuthorization` (e.g., USDC) | **Recommended** (Simplest, truly gasless) |
| **Permit2** | Any ERC-20 token | **Universal Fallback** (Requires one-time approval) |

### Default Behavior

If no `AssetTransferMethod` is specified, the system defaults to **EIP-3009**. This maintains backward compatibility with existing deployments.

## Asset Selection Policy

The default asset is chosen **per chain** based on the following guidelines:

1. **Chain-endorsed stablecoin**: If the chain has officially selected or endorsed a stablecoin (e.g., XDAI on Gnosis), that asset should be used.

2. **No official stance**: If the chain team has not taken a public position on a preferred stablecoin, we encourage the team behind that chain to make the selection and submit a PR.

3. **Community PRs welcome**: Chain teams and community members may submit PRs to add their chain's default asset, provided:
   - The selection aligns with the chain's ecosystem preferences
   - The EIP-712 domain parameters are correctly specified

## Contributing

To add a new chain's default asset:

1. Obtain the correct EIP-712 domain `name` and `version` from the token contract
2. Check whether the token supports EIP-3009 (`transferWithAuthorization`):
   - If yes: omit `AssetTransferMethod` (EIP-3009 is the default)
   - If no: set `AssetTransferMethod: AssetTransferMethodPermit2`
3. For Permit2 tokens, check whether the token supports EIP-2612 (`permit()`):
   - If yes: set `SupportsEip2612: true` so clients can use gasless EIP-2612 permits for Permit2 approval
   - If no: omit `SupportsEip2612` — clients will fall back to ERC-20 approval gas sponsoring
4. Add the entry to `NetworkConfigs` in `constants.go`
5. Submit a PR with the chain name and rationale for the asset selection

## Cross-SDK Checklist

When adding a new chain's default asset, update all three SDKs to maintain parity:

| SDK | File to edit | What to add |
|-----|-------------|-------------|
| **Go** | `go/mechanisms/evm/constants.go` | Entry in `NetworkConfigs` map |
| **TypeScript** | `typescript/packages/mechanisms/evm/src/exact/server/scheme.ts` | Entry in `stablecoins` map inside `getDefaultAsset()` |
| **Python** | `python/x402/mechanisms/evm/constants.py` | Entry in `NETWORK_CONFIGS` dict |

All three must use:
- The same CAIP-2 network key (e.g., `eip155:YOUR_CHAIN_ID`)
- The same token contract address
- The same EIP-712 domain `name` and `version`
- The same `decimals` value
- The same asset transfer method (EIP-3009 default, or Permit2 if specified)
