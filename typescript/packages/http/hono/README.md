# `@x402/hono` [![npm version](https://img.shields.io/npm/v/%40x402%2Fhono.svg)](https://www.npmjs.com/package/@x402/hono)

Hono middleware integration for the x402 Payment Protocol. This package provides a simple middleware function for adding x402 payment requirements to your Hono applications.

## Installation

```bash
pnpm install @x402/hono
```

## Quick Start

```typescript
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const app = new Hono();

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
app.get("/protected-route", (c) => {
  return c.json({ message: "This content is behind a paywall" });
});

serve({ fetch: app.fetch, port: 3000 });
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

## API Reference

### HonoAdapter

The `HonoAdapter` class implements the `HTTPAdapter` interface from `@x402/core`, providing Hono-specific request handling:

```typescript
class HonoAdapter implements HTTPAdapter {
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
): MiddlewareHandler;
```

Creates Hono middleware that:

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

**Option 2: Basic Paywall (No Installation)**

Without `@x402/paywall` installed, the middleware returns a basic HTML page with payment instructions.

**Option 3: Custom Paywall Provider**

Provide your own paywall provider:

```typescript
app.use(paymentMiddleware(routes, resourceServer, paywallConfig, customPaywallProvider));
```

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

### Multiple Payment Networks

```typescript
app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: "eip155:84532",
            payTo: evmAddress,
          },
          {
            scheme: "exact",
            price: "$0.001",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            payTo: svmAddress,
          },
        ],
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient)
      .register("eip155:84532", new ExactEvmScheme())
      .register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new ExactSvmScheme()),
  ),
);
```

### Custom Facilitator Client

If you need to use a custom facilitator server, configure it when creating the x402ResourceServer:

```typescript
import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/hono";
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
