# Default Assets for EVM Chains

This document explains how to add a default stablecoin asset for a new EVM chain.

## Overview

When a server uses `price: "$0.10"` syntax (USD string pricing), x402 needs to know which stablecoin to use for that chain. The default asset is configured in `scheme.ts` within the `getDefaultAsset()` method.

## Adding a New Chain

To add support for a new EVM chain, add an entry to the `stablecoins` map in `getDefaultAsset()`:
```typescript
const stablecoins: Record<string, { address: string; name: string; version: string; decimals: number; assetTransferMethod?: string; supportsEip2612?: boolean }> = {
  "eip155:8453": {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin",
    version: "2",
    decimals: 6,
  }, // Base mainnet USDC (EIP-3009)
  // Add your chain here:
  "eip155:YOUR_CHAIN_ID": {
    address: "0xYOUR_STABLECOIN_ADDRESS",
    name: "Token Name",              // Must match EIP-712 domain name
    version: "1",                    // Must match EIP-712 domain version
    decimals: 6,                     // Token decimals (typically 6 for USDC)
    // assetTransferMethod: "permit2",  // Uncomment if token doesn't support EIP-3009
    // supportsEip2612: true,           // Set if permit2 token implements EIP-2612 permit()
  },
};
```

### Fields

| Field | Description |
|-------|-------------|
| `address` | Contract address of the stablecoin |
| `name` | EIP-712 domain name (must match the token's domain separator) |
| `version` | EIP-712 domain version (must match the token's domain separator) |
| `decimals` | Token decimal places (typically 6 for USDC) |
| `assetTransferMethod` | Transfer method override: `"permit2"` for tokens that don't support EIP-3009. Omit for EIP-3009 tokens (default behavior). |
| `supportsEip2612` | Set to `true` for permit2 tokens that implement EIP-2612 `permit()`. When true, `name` and `version` are included in `extra` so the client can sign a gasless EIP-2612 permit for Permit2 approval. When false/absent on a permit2 token, the client skips EIP-2612 and uses ERC-20 approval gas sponsoring instead. Ignored for EIP-3009 tokens (which always include `name`/`version`). |

## Asset Transfer Methods

x402 supports two methods for transferring assets:

| Method | Use Case | Recommendation |
|--------|----------|----------------|
| **EIP-3009** | Tokens with native `transferWithAuthorization` (e.g., USDC) | **Recommended** (Simplest, truly gasless) |
| **Permit2** | Any ERC-20 token | **Universal Fallback** (Requires one-time approval) |

### Default Behavior

If no `assetTransferMethod` is specified, the client defaults to **EIP-3009**. This maintains backward compatibility with existing deployments.

### Using Permit2 for Custom Tokens

For tokens that don't support EIP-3009 and aren't in the default config, use the `registerMoneyParser` method to specify Permit2:

```typescript
import { ExactEvmScheme } from "@x402/evm/exact/server";

const server = new ExactEvmScheme();

// Register a custom token that requires Permit2
server.registerMoneyParser(async (amount, network) => {
  if (network === "eip155:8453") {
    return {
      amount: (amount * 1e18).toString(),  // Adjust decimals for your token
      asset: "0xYourTokenAddress",
      extra: {
        assetTransferMethod: "permit2",  // Required for non-EIP-3009 tokens
      },
    };
  }
  return null;  // Fall through to next parser or default
});
```

### Using Permit2 with Pre-Parsed Prices

You can also specify Permit2 directly when using pre-parsed `AssetAmount`:

```typescript
// In route configuration
{
  "GET /api/resource": {
    accepts: {
      payTo: "0x...",
      scheme: "exact",
      network: "eip155:8453",
      price: {
        amount: "1000000",
        asset: "0xYourTokenAddress",
        extra: {
          assetTransferMethod: "permit2",
        },
      },
    },
  },
}
```

### Client Requirements for Permit2

When a server specifies `assetTransferMethod: "permit2"`, clients must:

1. **One-time approval**: Approve the Permit2 contract to spend their tokens
   ```typescript
   // Using @x402/evm helpers
   import { createPermit2ApprovalTx, PERMIT2_ADDRESS } from "@x402/evm";
   
   const tx = createPermit2ApprovalTx(tokenAddress);
   await walletClient.sendTransaction(tx);
   ```

2. **Sign the payment**: The client SDK handles this automatically once approval exists

If the client hasn't approved Permit2, they'll receive a `412 Precondition Failed` response with error code `PERMIT2_ALLOWANCE_REQUIRED`.

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
   - If yes: add the entry without `assetTransferMethod` (EIP-3009 is the default)
   - If no: add `assetTransferMethod: "permit2"` to the entry so the client uses Permit2 automatically
3. For permit2 tokens, check whether the token supports EIP-2612 (`permit()`):
   - If yes: add `supportsEip2612: true` so clients can use gasless EIP-2612 permits for Permit2 approval
   - If no: omit `supportsEip2612` — clients will fall back to ERC-20 approval gas sponsoring
4. Add the entry to `getDefaultAsset()` in `scheme.ts`
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

