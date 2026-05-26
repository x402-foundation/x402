# `@x402/express` [![npm version](https://img.shields.io/npm/v/%40x402%2Fexpress.svg)](https://www.npmjs.com/package/@x402/express)

Express middleware integration for the x402 Payment Protocol. This package provides a simple middleware function for adding x402 payment requirements to your Express.js applications.

## Installation

```bash
pnpm install @x402/express
```

## Quick Start

```typescript
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const app = express();

const facilitatorClient = new HTTPFacilitatorClient({ url: "https://facilitator.x402.org" });
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme());

// Apply the payment middleware with your configuration
app.use(
  paymentMiddleware(
    {
      "GET /protected-route": {
        accepts: {
          scheme: "exact",
          price: "$0.10",
          network: "eip155:84532",
          payTo: "0xYourAddress",
        },
        description: "Access to premium content",
      },
    },
    resourceServer,
  ),
);

// Implement your protected route
app.get("/protected-route", (req, res) => {
  res.json({ message: "This content is behind a paywall" });
});

app.listen(3000);
```

## Configuration

The `paymentMiddleware` function accepts the following parameters:

```typescript
paymentMiddleware(
  routes: RoutesConfig,
  server: x402ResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart?: boolean
)
```

### Parameters

1. **`routes`** (required): Route configurations for protected endpoints
2. **`server`** (required): Pre-configured x402ResourceServer instance
3. **`paywallConfig`** (optional): Configuration for the built-in paywall UI
4. **`paywall`** (optional): Custom paywall provider
5. **`syncFacilitatorOnStart`** (optional): Whether to sync with facilitator on startup (defaults to true)

See the sections below for detailed configuration options.

## API Reference

### ExpressAdapter

The `ExpressAdapter` class implements the `HTTPAdapter` interface from `@x402/core`, providing Express-specific request handling:

```typescript
class ExpressAdapter implements HTTPAdapter {
  getHeader(name: string): string | undefined;
  getMethod(): string;
  getPath(): string;
  getUrl(): string;
  getAcceptHeader(): string;
  getUserAgent(): string;
}
```

### Middleware Function

```typescript
function paymentMiddleware(
  routes: RoutesConfig,
  server: x402ResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart?: boolean,
): (req: Request, res: Response, next: NextFunction) => Promise<void>;
```

Creates Express middleware that:

1. Uses the provided x402ResourceServer for payment processing
2. Checks if the incoming request matches a protected route
3. Validates payment headers if required
4. Returns payment instructions (402 status) if payment is missing or invalid
5. Processes the request if payment is valid
6. Handles settlement after successful response

### Route Configuration

Routes are passed as the first parameter to `paymentMiddleware`:

```typescript
const routes: RoutesConfig = {
  "GET /api/protected": {
    accepts: {
      scheme: "exact",
      price: "$0.10",
      network: "eip155:84532",
      payTo: "0xYourAddress",
      maxTimeoutSeconds: 60,
    },
    description: "Premium API access",
  },
};

app.use(paymentMiddleware(routes, resourceServer));
```

### Paywall Configuration

The middleware automatically displays a paywall UI when browsers request protected endpoints.

**Option 1: Full Paywall UI (Recommended)**

Install the optional `@x402/paywall` package for a complete wallet connection and payment UI:

```bash
pnpm add @x402/paywall
```

Then configure it:

```typescript
const paywallConfig: PaywallConfig = {
  appName: "Your App Name",
  appLogo: "/path/to/logo.svg",
  testnet: true,
};

app.use(paymentMiddleware(routes, resourceServer, paywallConfig));
```

The paywall includes:

- EVM wallet support (MetaMask, Coinbase Wallet, etc.)
- Solana wallet support (Phantom, Solflare, etc.)
- USDC balance checking
- Chain switching
- Onramp integration for mainnet

**Option 2: Basic Paywall (No Installation)**

Without `@x402/paywall` installed, the middleware returns a basic HTML page with payment instructions. This works but doesn't include wallet connections.

**Option 3: Custom Paywall Provider**

Provide your own paywall provider:

```typescript
app.use(paymentMiddleware(routes, resourceServer, paywallConfig, customPaywallProvider));
```

This allows full customization of the paywall UI.

**For advanced configuration** (builder pattern, network-specific bundles, custom handlers), see the [@x402/paywall README](../paywall/README.md).

## Advanced Usage

### Multiple Protected Routes

```typescript
app.use(
  paymentMiddleware(
    {
      "GET /api/premium/*": {
        accepts: {
          scheme: "exact",
          price: "$1.00",
          network: "eip155:8453",
          payTo: "0xYourAddress",
        },
        description: "Premium API access",
      },
      "GET /api/data": {
        accepts: {
          scheme: "exact",
          price: "$0.50",
          network: "eip155:84532",
          payTo: "0xYourAddress",
          maxTimeoutSeconds: 120,
        },
        description: "Data endpoint access",
      },
    },
    resourceServer,
  ),
);
```

### Custom Facilitator Client

If you need to use a custom facilitator server, configure it when creating the x402ResourceServer:

```typescript
import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const customFacilitator = new HTTPFacilitatorClient({
  url: "https://your-facilitator.com",
  createAuthHeaders: async () => ({
    verify: { Authorization: "Bearer your-token" },
    settle: { Authorization: "Bearer your-token" },
  }),
});

const resourceServer = new x402ResourceServer(customFacilitator)
  .register("eip155:84532", new ExactEvmScheme());

app.use(paymentMiddleware(routes, resourceServer, paywallConfig));
```

## Migration from x402-express

If you're migrating from the legacy `x402-express` package:

1. **Update imports**: Change from `x402-express` to `@x402/express`
2. **New API**: Create an x402ResourceServer and register payment schemes
3. **Parameter order**: Routes first, then resource server, then optional paywall config

### Before (x402-express):

```typescript
import { paymentMiddleware } from "x402-express";

app.use(
  paymentMiddleware(
    payTo, // First param was payTo address
    routes, // Second param was routes
    facilitator, // Third param was facilitator config
    paywall, // Fourth param was paywall config
  ),
);
```

### After (@x402/express):

```typescript
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });
const resourceServer = new x402ResourceServer(facilitator)
  .register("eip155:84532", new ExactEvmScheme());

app.use(
  paymentMiddleware(
    routes, // First param is routes (payTo is part of route config)
    resourceServer, // Second param is resource server (required)
    paywallConfig, // Third param is paywall config (optional)
  ),
);
```

Note: The `payTo` address is now specified within each route configuration rather than as a separate parameter.
