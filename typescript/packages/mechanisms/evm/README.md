# `@x402/evm` [![npm version](https://img.shields.io/npm/v/%40x402%2Fevm.svg)](https://www.npmjs.com/package/@x402/evm)

EVM (Ethereum Virtual Machine) implementation of the x402 payment protocol using the **Exact** payment scheme with EIP-3009 TransferWithAuthorization.

## Installation

```bash
npm install @x402/evm
```

## Overview

This package provides three main components for handling x402 payments on EVM-compatible blockchains:

- **Client** - For applications that need to make payments (have wallets/signers)
- **Facilitator** - For payment processors that verify and execute on-chain transactions  
- **Service** - For resource servers that accept payments and build payment requirements

## Package Exports

### Main Package (`@x402/evm`)

**V2 Protocol Support** - Modern x402 protocol with CAIP-2 network identifiers

**Client:**
- `ExactEvmClient` - V2 client implementation using EIP-3009
- `toClientEvmSigner(account)` - Converts viem accounts to x402 signers
- `ClientEvmSigner` - TypeScript type for client signers

**Facilitator:**
- `ExactEvmFacilitator` - V2 facilitator for payment verification and settlement
- `toFacilitatorEvmSigner(wallet)` - Converts viem wallets to facilitator signers
- `FacilitatorEvmSigner` - TypeScript type for facilitator signers

**Service:**
- `ExactEvmServer` - V2 service for building payment requirements

### V1 Package (`@x402/evm/v1`)

**V1 Protocol Support** - Legacy x402 protocol with simple network names

**Exports:**
- `ExactEvmClientV1` - V1 client implementation
- `ExactEvmFacilitatorV1` - V1 facilitator implementation  
- `NETWORKS` - Array of all supported V1 network names

**Supported V1 Networks:**
```typescript
[
  "abstract", "abstract-testnet",
  "base-sepolia", "base",
  "avalanche-fuji", "avalanche",
  "iotex", "sei", "sei-testnet",
  "polygon", "polygon-amoy",
  "peaq", "story", "educhain",
  "skale-base-sepolia"
]
```

## Version Differences

### V2 (Main Package)
- Network format: CAIP-2 (`eip155:8453`)
- Wildcard support: Yes (`eip155:*`)
- Payload structure: Partial (core wraps with metadata)
- Extensions: Full support
- Validity window: 1 hour (default)

### V1 (V1 Package)  
- Network format: Simple names (`base-sepolia`)
- Wildcard support: No (fixed list)
- Payload structure: Complete
- Extensions: Limited
- Validity window: 10 minutes with buffer

## Usage Patterns

### 1. Direct Registration (Full Control)

```typescript
import { x402Client } from "@x402/core/client";
import { ExactEvmClient } from "@x402/evm";
import { ExactEvmClientV1 } from "@x402/evm/v1";

const client = new x402Client()
  .register("eip155:*", new ExactEvmClient(signer))
  .registerSchemeV1("base-sepolia", new ExactEvmClientV1(signer))
  .registerSchemeV1("base", new ExactEvmClientV1(signer));
```

### Extension RPC Configuration (Optional)

`ExactEvmClient` only requires signer support for `address` + `signTypedData`.
Permit2 extension enrichment (EIP-2612 / ERC-20 approval gas sponsoring) can
optionally use explicit RPC config when signer read/fee helpers are unavailable.

No chain-default RPC fallback is applied by the SDK.

```typescript
// Per-network explicit registration
const client = new x402Client()
  .register("eip155:137", new ExactEvmClient(signer, { rpcUrl: polygonRpcUrl }))
  .register("eip155:8453", new ExactEvmClient(signer, { rpcUrl: baseRpcUrl }));

// Wildcard registration with chain-id keyed config map
const wildcardClient = new x402Client().register(
  "eip155:*",
  new ExactEvmClient(signer, {
    137: { rpcUrl: polygonRpcUrl },
    8453: { rpcUrl: baseRpcUrl },
  }),
);
```

### 2. Using Config (Flexible)

```typescript
import { x402Client } from "@x402/core/client";
import { ExactEvmClient } from "@x402/evm";

const client = x402Client.fromConfig({
  schemes: [
    { network: "eip155:*", client: new ExactEvmClient(signer) },
    { network: "base-sepolia", client: new ExactEvmClientV1(signer), x402Version: 1 }
  ],
  policies: [myCustomPolicy]
});
```

## Supported Networks

**V2 Networks** (via CAIP-2):
- `eip155:1` - Ethereum Mainnet
- `eip155:8453` - Base Mainnet  
- `eip155:84532` - Base Sepolia
- `eip155:*` - Wildcard (matches all EVM chains)
- Any `eip155:<chainId>` network

**V1 Networks** (simple names):
See `NETWORKS` constant in `@x402/evm/v1`

## Asset Support

Supports two asset transfer methods:
- **EIP-3009**: Tokens with native `transferWithAuthorization()` (e.g., USDC, EURC) — simplest, truly gasless
- **Permit2**: Any ERC-20 token — universal fallback, requires one-time approval

For the current list of chains with default assets configured, see [Default Assets for Dollar-String Pricing](../../../../docs/core-concepts/network-and-token-support.mdx#default-assets-for-dollar-string-pricing) in the x402 docs. To add default asset support for a new chain, see [Adding Support for New Networks](../../../../docs/core-concepts/network-and-token-support.mdx#adding-support-for-new-networks).

## Development

```bash
# Build
npm run build

# Test
npm run test

# Integration tests
npm run test:integration

# Lint & Format
npm run lint
npm run format
```

## Related Packages

- `@x402/core` - Core protocol types and client
- `@x402/fetch` - HTTP wrapper with automatic payment handling
- `@x402/svm` - Solana/SVM implementation
- `@x402/stellar` - Stellar implementation
