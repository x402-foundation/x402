# @x402/openpayments

TypeScript implementation of the x402 **`exact`** scheme for **ILP Open Payments** (`ilp:openpayments`). Uses [`@interledger/open-payments`](https://www.npmjs.com/package/@interledger/open-payments) for wallet and payment APIs.

## Installation

```bash
npm install @x402/openpayments
```

## Overview

This package provides three main components for handling x402 payments over the [Open Payments](https://openpayments.dev) standard:

- **Client** - For applications that need to make payments using a pre-approved outgoing payment grant
- **Facilitator** - For payment processors that verify incoming payment status via the Open Payments API; settlement is a no-op since funds are transferred by the ILP network before `/verify` is called
- **Server** - For resource servers that accept payments and build payment requirements from their wallet address

## Package Exports

### `@x402/openpayments/exact/client`

- `ExactOpenPaymentsScheme` - Client implementation; creates incoming payments and outgoing payments via ILP

### `@x402/openpayments/exact/facilitator`

- `ExactOpenPaymentsScheme` - Facilitator implementation; verifies incoming payment status and performs no-op settlement

### `@x402/openpayments/exact/server`

- `ExactOpenPaymentsScheme` - Server implementation; discovers asset info from the wallet address and builds payment requirements

## Usage

**Client**

```typescript
import { x402Client } from "@x402/core/client";
import { ExactOpenPaymentsScheme } from "@x402/openpayments/exact/client";

const client = new x402Client().register(
  "ilp:*",
  new ExactOpenPaymentsScheme({
    clientWalletAddress: "https://wallet.example.com/alice",
    keyId: "your-key-id",
    privateKey: "<base64 Ed25519 seed>",
    grantToken: "<outgoing-payment grant access token>",
  }),
);
```

**Resource server**

```typescript
import { ExactOpenPaymentsScheme } from "@x402/openpayments/exact/server";

server.register("ilp:openpayments", new ExactOpenPaymentsScheme({ walletAddress: "https://wallet.example.com/merchant" }));
```

**Facilitator**

```typescript
import { ExactOpenPaymentsScheme } from "@x402/openpayments/exact/facilitator";

facilitator.register(
  "ilp:openpayments",
  new ExactOpenPaymentsScheme({
    keyId: "facilitator-key-id",
    privateKey: "<base64 Ed25519 seed>",
    walletAddress: "https://wallet.example.com/facilitator",
  }),
);
```

## Supported Networks

- `ilp:openpayments` - Interledger Protocol via the Open Payments standard

## Server Price Configuration

The `price` field in a route's `accepts` payment option drives `parsePrice`. In all cases the asset code and scale are discovered from the wallet address and cached.

**1. Plain decimal string or number** — simplest form; asset code and scale come entirely from the wallet:

```typescript
// In a PaymentOption inside accepts:
accepts: {
  scheme: "exact",
  network: "ilp:openpayments",
  payTo: "https://wallet.example.com/merchant",
  price: "0.10",   // human-readable decimal
  // price: "$0.10",  // leading $ is stripped
  // price: 0.10,     // number also accepted
}
```

**2. `{ amount, asset }` — decimal with explicit asset code** — asset code is validated against the wallet (case-insensitive); scale still comes from the wallet:

```typescript
accepts: {
  scheme: "exact",
  network: "ilp:openpayments",
  payTo: "https://wallet.example.com/merchant",
  price: { amount: "0.10", asset: "USD" },
}
```

**3. `{ amount, asset, extra: { assetScale } }` — integer in smallest units** — amount is a raw integer at `assetScale`; if the wallet's scale is larger the amount is adapted automatically (throws if the wallet's scale is smaller, as that would lose precision):

```typescript
// 10 cents at scale 2 → wallet at scale 2: amount stays "10"
// 10 cents at scale 2 → wallet at scale 4: amount becomes "1000"
accepts: {
  scheme: "exact",
  network: "ilp:openpayments",
  payTo: "https://wallet.example.com/merchant",
  price: { amount: "10", asset: "USD", extra: { assetScale: 2 } },
}
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

### Integration tests (optional)

Wallet discovery integration tests run only when `OPENPAYMENTS_INTEGRATION_WALLET_URL` is set to a valid Open Payments **wallet address URL** (returns JSON with `resourceServer` and `authServer`). For testing, create a free account at [Interledger Test Wallet](https://wallet.interledger-test.dev/).

```bash
cd typescript/packages/mechanisms/openpayments
echo 'OPENPAYMENTS_INTEGRATION_WALLET_URL=https://your-test-wallet.example' > .env.integration
pnpm test:integration
```

If the variable is unset, integration tests are skipped.

## Related Packages

- `@x402/core` - Core protocol types and client
- `@x402/fetch` - HTTP wrapper with automatic payment handling
- `@x402/evm` - EVM/Ethereum implementation
- `@x402/svm` - Solana/SVM implementation
- `@x402/stellar` - Stellar implementation

## See also

- Advanced examples: `examples/typescript/{clients,servers,facilitator}/advanced/all_networks.ts`
