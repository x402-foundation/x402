# `@x402/paywall` [![npm version](https://img.shields.io/npm/v/%40x402%2Fpaywall.svg)](https://www.npmjs.com/package/@x402/paywall)

Modular paywall UI for the x402 payment protocol with support for EVM and Solana networks.

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

## Configuration

### PaywallConfig Options

```typescript
interface PaywallConfig {
  appName?: string;              // App name shown in wallet connection
  appLogo?: string;              // App logo URL
  currentUrl?: string;           // URL of protected resource
  testnet?: boolean;             // Use testnet (default: true)
}
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