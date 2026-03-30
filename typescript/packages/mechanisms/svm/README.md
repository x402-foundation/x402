# @x402/svm

SVM (Solana Virtual Machine) implementation of the x402 payment protocol using the **Exact** payment scheme with SPL Token transfers.

## Installation

```bash
npm install @x402/svm
```

## Overview

This package provides three main components for handling x402 payments on Solana:

- **Client** - For applications that need to make payments (have wallets/signers)
- **Facilitator** - For payment processors that verify and execute on-chain transactions
- **Service** - For resource servers that accept payments and build payment requirements

## Package Exports

### Main Package (`@x402/svm`)

**V2 Protocol Support** - Modern x402 protocol with CAIP-2 network identifiers

**Client:**
- `ExactSvmClient` - V2 client implementation using SPL Token
- `toClientSvmSigner(keypair)` - Converts Solana keypairs to x402 signers
- `ClientSvmSigner` - TypeScript type for client signers
- `ClientSvmConfig` - Optional RPC configuration

**Facilitator:**
- `ExactSvmFacilitator` - V2 facilitator for payment verification and settlement
- `toFacilitatorSvmSigner(keypair)` - Converts Solana keypairs to facilitator signers
- `FacilitatorSvmSigner` - TypeScript type for facilitator signers
- `FacilitatorRpcClient` - RPC client interface

**Service:**
- `ExactEvmServer` - V2 service for building payment requirements

**Utilities:**
- Network validation, asset info lookup, amount formatting, transaction encoding

### V1 Package (`@x402/svm/v1`)

**V1 Protocol Support** - Legacy x402 protocol with simple network names

**Exports:**
- `ExactSvmClientV1` - V1 client implementation
- `ExactSvmFacilitatorV1` - V1 facilitator implementation
- `NETWORKS` - Array of all supported V1 network names

**Supported V1 Networks:**
```typescript
[
  "solana",          // Mainnet
  "solana-devnet",   // Devnet
  "solana-testnet"   // Testnet
]
```

### Client Builder (`@x402/svm/client`)

**Convenience builder** for creating fully-configured SVM clients

**Exports:**
- `createSvmClient(config)` - Creates x402Client with SVM support
- `SvmClientConfig` - Configuration interface

**What it does:**
- Automatically registers V2 wildcard scheme (`solana:*`)
- Automatically registers all V1 networks from `NETWORKS`
- Optionally applies payment policies
- Optionally uses custom payment selector

**Example:**
```typescript
import { createSvmClient } from "@x402/svm/client";
import { toClientSvmSigner } from "@x402/svm";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

const keypair = await createKeyPairSignerFromBytes(
  base58.decode(process.env.SVM_PRIVATE_KEY)
);
const signer = toClientSvmSigner(keypair);

const client = createSvmClient({ signer });
// Ready to use with both V1 and V2!
```

## Version Differences

### V2 (Main Package)
- Network format: CAIP-2 (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`)
- Wildcard support: Yes (`solana:*`)
- Payload structure: Partial (core wraps with metadata)
- Extensions: Full support
- Transaction: Pre-signed by client, completed by facilitator

### V1 (V1 Package)
- Network format: Simple names (`solana-devnet`)
- Wildcard support: No (fixed list)
- Payload structure: Complete
- Extensions: Limited
- Transaction: Pre-signed by client, completed by facilitator

## Usage Patterns

### 1. Using Pre-built Builder (Recommended)

```typescript
import { createSvmClient } from "@x402/svm/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const client = createSvmClient({ signer: mySvmSigner });
const paidFetch = wrapFetchWithPayment(fetch, client);
```

### 2. Direct Registration (Full Control)

```typescript
import { x402Client } from "@x402/core/client";
import { ExactSvmClient } from "@x402/svm";
import { ExactSvmClientV1 } from "@x402/svm/v1";

const client = new x402Client()
  .register("solana:*", new ExactSvmClient(signer))
  .registerSchemeV1("solana-devnet", new ExactSvmClientV1(signer))
  .registerSchemeV1("solana", new ExactSvmClientV1(signer));
```

### 3. Using Config (Flexible)

```typescript
import { x402Client } from "@x402/core/client";
import { ExactSvmClient } from "@x402/svm";

const client = x402Client.fromConfig({
  schemes: [
    { network: "solana:*", client: new ExactSvmClient(signer) },
    { 
      network: "solana-devnet", 
      client: new ExactSvmClientV1(signer), 
      x402Version: 1 
    }
  ]
});
```

## Supported Networks

**V2 Networks** (via CAIP-2):
- `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` - Mainnet Beta
- `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` - Devnet
- `solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z` - Testnet
- `solana:*` - Wildcard (matches all Solana networks)

**V1 Networks** (simple names):
- `solana` - Mainnet
- `solana-devnet` - Devnet  
- `solana-testnet` - Testnet

## Asset Support

Supports SPL Token and Token-2022 program tokens:
- USDC (primary)
- Any SPL token with associated token accounts
- Automatically detects token program (Token vs Token-2022)

## Transaction Structure

The exact payment scheme uses SPL Token `TransferChecked` instruction with:
- Compute budget optimizations (unit limit + price)
- Source/destination ATAs (Associated Token Accounts)
- Partial signing (client signs, facilitator completes and submits)

## Duplicate Settlement Protection

This package includes a built-in `SettlementCache` that prevents a known race condition on Solana where the same payment transaction could be settled multiple times before on-chain confirmation. When the facilitator scheme is registered via `registerExactSvmScheme`, a single `SettlementCache` instance is automatically shared across both V1 and V2 scheme versions.

The cache rejects concurrent `/settle` calls that carry the same transaction payload, returning a `duplicate_settlement` error for the second and subsequent attempts. Entries are automatically evicted after 120 seconds (approximately twice the Solana blockhash lifetime).

**No additional configuration is required** — duplicate settlement protection is enabled by default when using the standard registration helpers.

For full details on the race condition and mitigation strategy, see the [Exact SVM Scheme Specification](../../../../specs/schemes/exact/scheme_exact_svm.md#duplicate-settlement-mitigation-recommended).

## Development

```bash
# Build
pnpm build

# Test
pnpm test

# Integration tests
pnpm test:integration

# Lint & Format
pnpm lint
pnpm format
```

## Related Packages

- `@x402/core` - Core protocol types and client
- `@x402/fetch` - HTTP wrapper with automatic payment handling
- `@x402/evm` - EVM/Ethereum implementation
- `@x402/stellar` - Stellar implementation
- `@solana/web3.js` - Solana JavaScript SDK (peer dependency)
