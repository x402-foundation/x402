# @x402/fastify

Fastify middleware integration for the x402 Payment Protocol. This package provides payment middleware for adding x402 payment requirements to your Fastify applications.

## Installation

```bash
pnpm install @x402/fastify
```

## Quick Start

```typescript
import Fastify from "fastify";
import { paymentMiddleware, x402ResourceServer } from "@x402/fastify";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const app = Fastify();

const facilitatorClient = new HTTPFacilitatorClient({ url: "https://facilitator.x402.org" });
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme());

// Apply the payment middleware with your configuration
paymentMiddleware(
  app,
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
);

// Implement your protected route
app.get("/protected-route", async () => {
  return { message: "This content is behind a paywall" };
});

app.listen({ port: 3000 });
```

## Configuration

The `paymentMiddleware` function accepts the following parameters:

```typescript
paymentMiddleware(
  app: FastifyInstance,
  routes: RoutesConfig,
  server: x402ResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart?: boolean
)
```

### Parameters

1. **`app`** (required): The Fastify instance to register hooks on
2. **`routes`** (required): Route configurations for protected endpoints
3. **`server`** (required): Pre-configured x402ResourceServer instance
4. **`paywallConfig`** (optional): Configuration for the built-in paywall UI
5. **`paywall`** (optional): Custom paywall provider
6. **`syncFacilitatorOnStart`** (optional): Whether to sync with facilitator on startup (defaults to true)

## API Reference

### FastifyAdapter

The `FastifyAdapter` class implements the `HTTPAdapter` interface from `@x402/core`, providing Fastify-specific request handling:

```typescript
class FastifyAdapter implements HTTPAdapter {
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
  app: FastifyInstance,
  routes: RoutesConfig,
  server: x402ResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart?: boolean,
): void;
```

Registers Fastify hooks (`onRequest` and `onSend`) that:

1. Use the provided x402ResourceServer for payment processing
2. Check if the incoming request matches a protected route
3. Validate payment headers if required
4. Return payment instructions (402 status) if payment is missing or invalid
5. Process the request if payment is valid
6. Handle settlement after successful response

### Route Configuration

Routes are passed as the second parameter to `paymentMiddleware`:

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

paymentMiddleware(app, routes, resourceServer);
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

paymentMiddleware(app, routes, resourceServer, paywallConfig);
```

**Option 2: Basic Paywall (No Installation)**

Without `@x402/paywall` installed, the middleware returns a basic HTML page with payment instructions.

**Option 3: Custom Paywall Provider**

Provide your own paywall provider:

```typescript
paymentMiddleware(app, routes, resourceServer, paywallConfig, customPaywallProvider);
```

## Advanced Usage

### Multiple Protected Routes

```typescript
paymentMiddleware(
  app,
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
);
```

### Multiple Payment Networks

```typescript
paymentMiddleware(
  app,
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
);
```

### Custom Facilitator Client

If you need to use a custom facilitator server, configure it when creating the x402ResourceServer:

```typescript
import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/fastify";
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

paymentMiddleware(app, routes, resourceServer, paywallConfig);
```
