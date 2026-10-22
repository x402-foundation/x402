# `@x402/paywall` [![npm version](https://img.shields.io/npm/v/%40x402%2Fpaywall.svg)](https://www.npmjs.com/package/@x402/paywall)

Modular paywall UI for the x402 payment protocol with support for EVM, Solana, Algorand and Cardano networks.

## Features

- Pre-built paywall UI out of the box
- Wallet connection (MetaMask, Coinbase Wallet, Phantom, etc.)
- USDC balance checking
- Multi-network support (EVM + Solana)
- Tree-shakeable - only bundle what you need
- Fully customizable via builder pattern

## Installation

```bash
pnpm add @x402/paywall
```

## Bundle Sizes

Choose the import that matches your needs:

| Import | Size | Networks | Use Case |
|--------|------|----------|----------|
| `@x402/paywall` | 3.5MB | EVM + Solana | Multi-network apps |
| `@x402/paywall/evm` | 3.4MB | EVM only | Base, Ethereum, Polygon, etc. |
| `@x402/paywall/svm` | 1.0MB | Solana only | Solana apps |
| `@x402/paywall/cardano` | 1.5MB | Cardano only | Cardano apps (CIP-30 wallets) |

## Usage

### Option 1: EVM Only

```typescript
import { createPaywall } from '@x402/paywall';
import { evmPaywall } from '@x402/paywall/evm';

const paywall = createPaywall()
  .withNetwork(evmPaywall)
  .withConfig({
    appName: 'My App',
    testnet: true
  })
  .build();

// Use with Express
app.use(paymentMiddleware(routes, facilitators, schemes, undefined, paywall));
```

### Option 2: Solana Only

```typescript
import { createPaywall } from '@x402/paywall';
import { svmPaywall } from '@x402/paywall/svm';

const paywall = createPaywall()
  .withNetwork(svmPaywall)
  .withConfig({
    appName: 'My Solana App',
    testnet: true
  })
  .build();
```

### Option 3: Multi-Network

```typescript
import { createPaywall } from '@x402/paywall';
import { evmPaywall } from '@x402/paywall/evm';
import { svmPaywall } from '@x402/paywall/svm';

const paywall = createPaywall()
  .withNetwork(evmPaywall)   // First-match priority
  .withNetwork(svmPaywall)   // Fallback option
  .withConfig({
    appName: 'Multi-chain App',
    testnet: true
  })
  .build();
```

### Option 4: Cardano

```typescript
import { createPaywall } from '@x402/paywall';
import { cardanoPaywall } from '@x402/paywall/cardano';

// Optional: fetch network parameters at startup so the first visitor
// does not wait (recommended on serverless platforms).
await cardanoPaywall.prefetch(['cardano:preprod']);

const paywall = createPaywall().withNetwork(cardanoPaywall).build();
```

The Cardano page derives mainnet/testnet from the requirement's network and does not use `appName`, `appLogo` or `testnet`.

## Configuration

### PaywallConfig Options

```typescript
interface PaywallConfig {
  appName?: string;              // App name shown in wallet connection
  appLogo?: string;              // App logo URL
  currentUrl?: string;           // URL of protected resource
  testnet?: boolean;             // Use testnet (default: true)
  rpcUrls?: Record<string, string>; // Browser RPC per CAIP-2 network (SVM only for now)
}
```

### Solana RPC

The Solana paywall reads the payer's balance and builds the transaction from the browser. By default it uses the public endpoints (`https://api.mainnet-beta.solana.com`, `https://api.devnet.solana.com`). The public mainnet endpoint returns 403 to requests sent from a browser, so set `rpcUrls` for mainnet:

```typescript
const paywall = createPaywall()
  .withNetwork(svmPaywall)
  .withConfig({
    testnet: false,
    rpcUrls: {
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'https://your-rpc.example.com',
    },
  })
  .build();
```

> **Warning:** the URL is embedded in the paywall HTML and visible to every visitor. Use an endpoint that is safe to expose in a browser, such as a key restricted to your domain or your own RPC proxy. Never put a secret API key here.

### Cardano

The Cardano paywall lets a visitor pay with any CIP-30 browser wallet (Lace, Eternl, Vespr, Typhon, Yoroi, ...). It supports the `exact` scheme with the default (plain transfer) method in ADA or a native token such as USDM; requirements using the `script` or `masumi` methods are not handled.

- **Network parameters come from the server.** Public Koios endpoints do not allow browser requests, so the handler fetches `epoch_params` from Koios on the server, caches it for 15 minutes, and injects it into the page. The browser never calls a chain provider: it builds the transaction from the wallet's own UTxOs and the wallet only signs (the facilitator submits). Use `createCardanoPaywall({ koiosBaseUrls, koiosToken, cacheTtlMs })` to point at your own Koios instance or use a Koios token; the token is only sent from the server and never appears in the page.
- **The page checks what it signs.** It refuses network parameters outside sane bounds, and any built transaction that is not exactly the displayed payment plus change back to the wallet (fee capped at 1 ADA; ADA travelling with a token capped at 3 ADA).
- **Retries never pay twice.** Every attempt for one payment spends the same wallet UTxO, so at most one can land. The page keeps that record in `localStorage` per resource and network (a changed price, payee or asset keeps it), keeps a settled payment until its content has loaded, and serialises tabs with the Web Locks API. It refuses to sign when site storage or Web Locks are unavailable, so serve the paywall over HTTPS.
- **Payment window.** Browser wallets need time to approve; routes must use `maxTimeoutSeconds` of at least 240 (the default is 300).
- **Fees.** The payer pays the network fee in ADA, and a token payment also sends about 1.2 ADA with the token to the recipient, so payers need some ADA even when paying in USDM. The page says so before signing.

```typescript
import { createCardanoPaywall } from '@x402/paywall/cardano';

const cardano = createCardanoPaywall({
  koiosBaseUrls: { 'cardano:mainnet': 'https://koios.example.com/api/v1' },
});
```

## How It Works

### First-Match Selection

When multiple networks are registered, the paywall uses **first-match selection**:

1. Iterates through `paymentRequired.accepts` array
2. Finds the first payment requirement that has a registered handler
3. Uses that handler to generate the HTML

**Example:**
```typescript
// Server returns multiple options
{
  "accepts": [
    { "network": "solana:5eykt...", ... },  // First
    { "network": "eip155:8453", ... }       // Second
  ]
}

// If both handlers registered, Solana is selected (it's first in accepts)
const paywall = createPaywall()
  .withNetwork(evmPaywall)
  .withNetwork(svmPaywall)
  .build();
```

### Supported Networks

**EVM Networks** (via `evmPaywall`):
- CAIP-2: `eip155:*` (e.g., `eip155:8453` for Base, `eip155:84532` for Base Sepolia)

**Solana Networks** (via `svmPaywall`):
- CAIP-2: `solana:*` (e.g., `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` for mainnet)

**Cardano Networks** (via `cardanoPaywall`):
- `cardano:mainnet`, `cardano:preprod`, `cardano:preview` (and their CIP-34 aliases)

## With HTTP Middleware

### Express

```typescript
import express from 'express';
import { paymentMiddleware } from '@x402/express';
import { createPaywall } from '@x402/paywall';
import { evmPaywall } from '@x402/paywall/evm';

const app = express();

const paywall = createPaywall()
  .withNetwork(evmPaywall)
  .withConfig({ appName: 'My API' })
  .build();

app.use(paymentMiddleware(
  { "/api/premium": { price: "$0.10", network: "eip155:84532", payTo: "0x..." } },
  facilitators,
  schemes,
  undefined,
  paywall
));
```

### Automatic Detection

If you provide `paywallConfig` without a custom paywall, `@x402/core` automatically:
1. Tries to load `@x402/paywall` if installed
2. Falls back to basic HTML if not installed

```typescript
// Simple usage - auto-detects @x402/paywall
app.use(paymentMiddleware(routes, facilitators, schemes, {
  appName: 'My App',
  testnet: true
}));
```

## Custom Network Handlers

You can create custom handlers for new networks:

```typescript
import { createPaywall, type PaywallNetworkHandler } from '@x402/paywall';

const suiPaywall: PaywallNetworkHandler = {
  supports: (req) => req.network.startsWith('sui:'),
  generateHtml: (req, paymentRequired, config) => {
    return `<!DOCTYPE html>...`;  // Your custom Sui paywall
  }
};

const paywall = createPaywall()
  .withNetwork(evmPaywall)
  .withNetwork(svmPaywall)
  .withNetwork(suiPaywall)  // Custom handler
  .build();
```

## Development

### Build

```bash
pnpm build:paywall  # Generate HTML templates
pnpm build          # Build TypeScript
```

### Test

```bash
pnpm test           # Run unit tests
```