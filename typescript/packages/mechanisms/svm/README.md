# `@x402/svm` [![npm version](https://img.shields.io/npm/v/%40x402%2Fsvm.svg)](https://www.npmjs.com/package/@x402/svm)

SVM (Solana Virtual Machine) implementation of the x402 payment protocol.

**Payment schemes:**
- **Exact** — fixed-price SPL Token transfers (client pays the advertised amount)
- **Upto** — usage-based billing via [payment-channels](https://github.com/solana-foundation/payment-channels) (client authorizes a max; server settles actual usage)

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
- `ExactSvmScheme` - V2 exact client using SPL Token
- `toClientSvmSigner(keypair)` - Converts Solana keypairs to x402 signers
- `ClientSvmSigner` - TypeScript type for client signers
- `ClientSvmConfig` - Optional RPC configuration

**Facilitator:**
- `ExactSvmScheme` - V2 exact facilitator for payment verification and settlement
- `toFacilitatorSvmSigner(keypair)` - Converts Solana keypairs to facilitator signers
- `FacilitatorSvmSigner` - TypeScript type for facilitator signers (`getSigner` optional; required by upto)
- `FacilitatorRpcClient` - RPC client interface

**Service:**
- `ExactSvmScheme` - V2 exact service for building payment requirements

**Utilities:**
- Network validation, asset info lookup, amount formatting, transaction encoding

### Upto Scheme (`@x402/svm/upto/*`)

Usage-based payments: authorize a ceiling, settle actual usage. See [Upto SVM Scheme](./src/upto/README.md).

| Role | Import |
|------|--------|
| Client | `@x402/svm/upto/client` → `UptoSvmScheme` |
| Server | `@x402/svm/upto/server` → `UptoSvmScheme` (requires `receiverAuthorizerSigner` unless the facilitator's `receiverAuthorizer` is delegated to) |
| Facilitator | `@x402/svm/upto/facilitator` → `UptoSvmScheme` (requires `getSigner` on the facilitator signer) |

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
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { UptoSvmScheme } from "@x402/svm/upto/client";
import { ExactSvmSchemeV1 } from "@x402/svm/v1";

const client = new x402Client()
  .register("solana:*", new ExactSvmScheme(signer)) // fixed-price
  .register("solana:*", new UptoSvmScheme(signer))  // usage-based
  .registerSchemeV1("solana-devnet", new ExactSvmSchemeV1(signer))
  .registerSchemeV1("solana", new ExactSvmSchemeV1(signer));
```

### 3. Using Config (Flexible)

```typescript
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { ExactSvmSchemeV1 } from "@x402/svm/v1";

const client = x402Client.fromConfig({
  schemes: [
    { network: "solana:*", client: new ExactSvmScheme(signer) },
    { 
      network: "solana-devnet", 
      client: new ExactSvmSchemeV1(signer), 
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

**Exact** uses SPL Token `TransferChecked` with:
- Compute budget optimizations (unit limit + price)
- Source/destination ATAs (Associated Token Accounts)
- Partial signing (client signs, facilitator completes and submits)

**Upto** uses the payment-channels program (`open` → escrow deposit, then `settle_and_seal` + `distribute` with a server voucher for the actual amount). Details in [Upto SVM Scheme](./src/upto/README.md).

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
