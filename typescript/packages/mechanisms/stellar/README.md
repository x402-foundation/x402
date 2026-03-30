# @x402/stellar

Stellar implementation of the x402 payment protocol using the **Exact** payment scheme with [Soroban token](https://stellar.org/protocol/sep-41) transfers.

## Installation

```bash
npm install @x402/stellar
```

## Overview

This package provides three main components for handling x402 payments on Stellar:

- **Client** - For applications that need to make payments (have wallets/signers)
- **Facilitator** - For payment processors that verify and execute on-chain transactions
- **Server** - For resource servers that accept payments and build payment requirements

**Key Differences from EVM/SVM:**

- **Ledger-based expiration** (not timestamps) - default ~12 ledgers ≈ 60 seconds
- **Auth entry signing** - client signs authorization entries only, facilitator rebuilds and submits transaction
- **Mainnet requires custom RPC URL** (see [Stellar RPC Providers](https://developers.stellar.org/docs/data/apis/rpc/providers))

## Package Exports

### Main Package (`@x402/stellar`)

**V2 Protocol Support** - x402 v2 protocol with CAIP-2 network identifiers

**Client:**

- `ExactStellarScheme` - Client implementation using Soroban token transfers
- `createEd25519Signer(privateKey, defaultNetwork)` - Creates a Stellar signer from private key that implements `SignAuthEntry` and `SignTransaction` according to [SEP-43](https://stellar.org/protocol/sep-43)
- `ClientStellarSigner` - TypeScript type for client signers

**Facilitator:**

- `ExactStellarScheme` - Facilitator for payment verification and settlement
- `FacilitatorStellarSigner` - TypeScript type for facilitator signers

> [!NOTE]
> Facilitators currently always sponsor transaction fees (`areFeesSponsored: true`). A non-sponsored flow will be added later. See [spec](../../../specs/schemes/exact/scheme_exact_stellar.md#paymentrequirements-for-exact) for details.

**Server:**

- `ExactStellarScheme` - Server for building payment requirements

**Utilities:**

- `getRpcUrl(network, config?)` - Get RPC URL for a network
- `getRpcClient(network, config?)` - Create Soroban RPC client
- `getNetworkPassphrase(network)` - Get network passphrase
- `validateStellarDestinationAddress(address)` - Validate destination address
- `validateStellarAssetAddress(address)` - Validate asset/contract address
- `convertToTokenAmount(amount, decimals)` - Convert decimal to token units
- `getUsdcAddress(network)` - Get USDC contract address

**Constants:**

- `STELLAR_PUBNET_CAIP2` = `"stellar:pubnet"`
- `STELLAR_TESTNET_CAIP2` = `"stellar:testnet"`
- `USDC_PUBNET_ADDRESS` - USDC contract on mainnet
- `USDC_TESTNET_ADDRESS` - USDC contract on testnet
- `DEFAULT_TOKEN_DECIMALS` = `7`

### Subpath Exports

- `@x402/stellar/exact/client` - `ExactStellarScheme` (client)
- `@x402/stellar/exact/server` - `ExactStellarScheme` (server)
- `@x402/stellar/exact/facilitator` - `ExactStellarScheme` (facilitator)

## Supported Networks

**V2 Networks** (via [CAIP-28](https://namespaces.chainagnostic.org/stellar/caip2)):

- `stellar:pubnet` - Mainnet (requires custom RPC URL)
- `stellar:testnet` - Testnet (default: [https://soroban-testnet.stellar.org](https://soroban-testnet.stellar.org))
- `stellar:*` - Wildcard (matches all Stellar networks)

## Asset Support

Supports Soroban tokens implementing [SEP-41](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md):

- Any Soroban token contract with `transfer(from, to, amount)` function
- Default asset is USDC (primary, 7 decimals)

> **For detailed protocol flow, transaction structure, and verification rules, see the [Exact Scheme Specification](../../../specs/schemes/exact/scheme_exact_stellar.md).**

## Usage Patterns

### 1. Direct Registration (Recommended)

```typescript
import { x402Client } from "@x402/core/client";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const signer = createEd25519Signer(privateKey, "stellar:testnet");
const client = new x402Client().register("stellar:*", new ExactStellarScheme(signer));
```

### 2. Custom Configuration

```typescript
// Client with custom RPC
const client = new x402Client().register(
  "stellar:*",
  new ExactStellarScheme(signer, { url: "https://custom-rpc.example.com" }),
);

// Server with custom money parser
const scheme = new ExactStellarScheme().registerMoneyParser(async (amount, network) => ({
  amount: customConvert(amount),
  asset: "TOKEN_ADDRESS",
  extra: {},
}));

// Facilitator
const facilitator = new x402Facilitator().register(
  "stellar:testnet",
  new ExactStellarScheme([signer]),
);
```

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

## Integration Tests

Integration tests require four funded Stellar testnet accounts:

```bash
CLIENT_PRIVATE_KEY=S...           # Client's secret key
FACILITATOR_PRIVATE_KEY=S...      # Facilitator's secret key
FACILITATOR_ADDRESS=G...          # Facilitator's public address
RESOURCE_SERVER_ADDRESS=G...      # Resource server's public address
```

### Stellar Testnet Account Setup

1. Go to [Stellar Laboratory](https://lab.stellar.org/account/create) ➡️ Generate keypair ➡️ Fund account with Friendbot, then copy the `Secret` and `Public` keys so you can use them.
2. Add USDC trustline (required for client and resource server): go to [Fund Account](https://lab.stellar.org/account/fund) ➡️ Paste your `Public Key` ➡️ Add USDC Trustline ➡️ paste your `Secret key` ➡️ Sign transaction ➡️ Add Trustline.
3. Get testnet USDC from [Circle Faucet](https://faucet.circle.com/) (select Stellar network).

> [!NOTE]
> The facilitator account only needs XLM (step 1). Client and resource server accounts need all three steps.

## Related Packages

- `@x402/core` - Core protocol types and client
- `@x402/fetch` - HTTP wrapper with automatic payment handling
- `@x402/evm` - EVM/Ethereum implementation
- `@x402/svm` - Solana/SVM implementation
