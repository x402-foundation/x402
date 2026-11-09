# `@x402/next` [![npm version](https://img.shields.io/npm/v/%40x402%2Fnext.svg)](https://www.npmjs.com/package/@x402/next)

Next.js integration for the x402 Payment Protocol. This package allows you to easily add paywall functionality to your Next.js applications using the x402 protocol.

## Installation

```bash
pnpm install @x402/core @x402/next @x402/evm @x402/svm
```

## Quick Start

### Protecting Page Routes

Page routes are protected using the `paymentProxy`. Create a proxy (middleware) file in your Next.js project (`proxy.ts`):

```typescript
import { paymentProxy, x402ResourceServer } from "@x402/next";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";

const facilitatorClient = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new ExactSvmScheme());

export const proxy = paymentProxy(
  {
    "/protected": {
      accepts: [
        {
          scheme: "exact",
          price: "$0.01",
          network: "eip155:84532",
          payTo: "0xYourEvmAddress",
        },
        {
          scheme: "exact",
          price: "$0.01",
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          payTo: "YourSolanaAddress",
        },
      ],
      description: "Access to protected content",
    },
  },
  resourceServer,
);

// Configure which paths the middleware should run on
export const config = {
  matcher: ["/protected/:path*"],
};
```

### Protecting API Routes

API routes are protected using the `withX402` route wrapper. This is the recommended approach to protect API routes as it guarantees payment settlement only AFTER successful API responses (status < 400). API routes can also be protected by `paymentProxy`, however this will charge clients for failed API responses:

**Static routes** — pass a bare route config (second argument). Payment matches any request to the handler; no path key required:

```typescript
// app/api/your-endpoint/route.ts
import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";

const handler = async (_: NextRequest) => {
  return NextResponse.json({ data: "your response" });
};

export const GET = withX402(
  handler,
  {
    accepts: [
      {
        scheme: "exact",
        price: "$0.01",
        network: "eip155:84532",
        payTo: "0xYourEvmAddress",
      },
      {
        scheme: "exact",
        price: "$0.01",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        payTo: "YourSolanaAddress",
      },
    ],
    description: "Access to API endpoint",
  },
  server, // your configured x402ResourceServer
);
```

**Dynamic routes** (`/api/users/[id]`, catch-all `[...slug]`, etc.) — key the config by the route's path pattern so bazaar discovery gets the correct `routeTemplate` and path params:

```typescript
export const GET = withX402(
  handler,
  {
    "/api/users/[id]": {
      accepts: [
        {
          scheme: "exact",
          price: "$0.01",
          network: "eip155:84532",
          payTo: "0xYourEvmAddress",
        },
        {
          scheme: "exact",
          price: "$0.01",
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          payTo: "YourSolanaAddress",
        },
      ],
      description: "Access to user API",
    },
  },
  server,
);
```

For static routes that use bazaar discovery (`declareDiscoveryExtension`), you may also key by path (e.g. `{ "/api/your-endpoint": config }`) — optional, but makes the catalog URL explicit.

The pattern must match the request path exactly as served (including any `basePath`, no trailing slash). If a keyed pattern does not match — a typo, a missing dynamic segment — the handler runs **without** payment protection; `withX402` logs a warning once when this happens.

## Configuration

### paymentProxy

The `paymentProxy` function is used to protect page routes. It can also protect API routes, however this will charge clients for failed API responses.

```typescript
paymentProxy(
  routes: RoutesConfig,
  server: x402ResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart?: boolean
)
```

#### Parameters

1. **`routes`** (required): Route configurations for protected endpoints
2. **`server`** (required): Pre-configured x402ResourceServer instance
3. **`paywallConfig`** (optional): Configuration for the built-in paywall UI
4. **`paywall`** (optional): Custom paywall provider
5. **`syncFacilitatorOnStart`** (optional): Whether to sync with facilitator on startup (defaults to true)

### withX402

The `withX402` function wraps API route handlers. This is the recommended approach to protect API routes as it guarantees payment settlement only AFTER successful API responses (status < 400).

```typescript
withX402(
  routeHandler: (request: NextRequest) => Promise<NextResponse>,
  routes: RoutesConfig,
  server: x402ResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart?: boolean
)
```

#### Parameters

1. **`routeHandler`** (required): Your API route handler function
2. **`routes`** (required): Payment configuration — a **bare `RouteConfig`** for static routes (matches any path to the handler), or a **map keyed by path pattern** for dynamic routes (e.g. `{ "/api/users/[id]": config }`). See [Protecting API Routes](#protecting-api-routes) above.
3. **`server`** (required): Pre-configured x402ResourceServer instance
4. **`paywallConfig`** (optional): Configuration for the built-in paywall UI
5. **`paywall`** (optional): Custom paywall provider
6. **`syncFacilitatorOnStart`** (optional): Whether to sync with facilitator on startup (defaults to true)

## API Reference

### NextAdapter

The `NextAdapter` class implements the `HTTPAdapter` interface from `@x402/core`, providing Next.js-specific request handling:

```typescript
class NextAdapter implements HTTPAdapter {
  getHeader(name: string): string | undefined;
  getMethod(): string;
  getPath(): string;
  getUrl(): string;
  getAcceptHeader(): string;
  getUserAgent(): string;
}
```

### Route Configuration

```typescript
const routes: RoutesConfig = {
  "/api/protected": {
    accepts: [
      {
        scheme: "exact",
        price: "$0.10",
        network: "eip155:84532",
        payTo: "0xYourEvmAddress",
        maxTimeoutSeconds: 60,
      },
      {
        scheme: "exact",
        price: "$0.10",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        payTo: "YourSolanaAddress",
        maxTimeoutSeconds: 60,
      },
    ],
    description: "Premium API access",
  },
};
```

## Advanced Usage

### Custom Paywall

```typescript
import { createPaywall } from "@x402/paywall";
import { evmPaywall } from "@x402/paywall/evm";
import { svmPaywall } from "@x402/paywall/svm";

const paywall = createPaywall()
  .withNetwork(evmPaywall)
  .withNetwork(svmPaywall)
  .withConfig({
    appName: "My App",
    appLogo: "/logo.png",
    testnet: true,
  })
  .build();

export const middleware = paymentProxy(
  routes,
  server,
  undefined, // paywallConfig (using custom paywall instead)
  paywall,
);
```

## Migration from x402-next

If you're migrating from the legacy `x402-next` package:

1. **Update imports**: Change from `x402-next` to `@x402/next`
2. **New API**: Create an x402ResourceServer and register payment schemes
3. **Function rename**: `paymentMiddleware` is now `paymentProxy`
4. **Parameter order**: Routes first, then resource server

### Before (x402-next):

```typescript
import { paymentMiddleware } from "x402-next";

export const middleware = paymentMiddleware(
  "0xYourAddress",
  {
    "/protected": {
      price: "$0.01",
      network: "base-sepolia",
      config: { description: "Access to protected content" },
    },
  },
  facilitator,
  paywall,
);
```

### After (@x402/next):

```typescript
import { paymentProxy, x402ResourceServer } from "@x402/next";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";

const facilitator = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const resourceServer = new x402ResourceServer(facilitator)
  .register("eip155:84532", new ExactEvmScheme())
  .register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new ExactSvmScheme());

export const middleware = paymentProxy(
  {
    "/protected": {
      accepts: [
        {
          scheme: "exact",
          price: "$0.01",
          network: "eip155:84532",
          payTo: "0xYourEvmAddress",
        },
        {
          scheme: "exact",
          price: "$0.01",
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          payTo: "YourSolanaAddress",
        },
      ],
      description: "Access to protected content",
    },
  },
  resourceServer,
);
```

Note: Each payment option now specifies its own `payTo` address within the route configuration.
