# `@x402/koa`

Koa middleware integration for the x402 Payment Protocol. This package provides middleware for adding x402 payment requirements to your Koa applications.

## Installation

```bash
pnpm install @x402/koa
```

## Quick Start

```typescript
import Koa from "koa";
import { paymentMiddleware, x402ResourceServer } from "@x402/koa";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const app = new Koa();

const facilitatorClient = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
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
app.use(async ctx => {
  if (ctx.path === "/protected-route") {
    ctx.body = { message: "This content is behind a paywall" };
  }
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

## API Reference

### KoaAdapter

The `KoaAdapter` class implements the `HTTPAdapter` interface from `@x402/core`, providing Koa-specific request handling:

```typescript
class KoaAdapter implements HTTPAdapter {
  getHeader(name: string): string | undefined;
  getMethod(): string;
  getPath(): string;
  getUrl(): string;
  getAcceptHeader(): string;
  getUserAgent(): string;
  getQueryParams(): Record<string, string | string[]>;
  getQueryParam(name: string): string | string[] | undefined;
  getBody(): unknown;
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
): Koa.Middleware;
```

Creates Koa middleware that:

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

## Middleware Ordering

Place `paymentMiddleware` **after** middleware that populates request data it depends on:

```typescript
import Koa from "koa";
import bodyParser from "koa-bodyparser";
import { paymentMiddleware, x402ResourceServer } from "@x402/koa";

const app = new Koa();

// 1. Body parser first (so getBody() works)
app.use(bodyParser());

// 2. Auth middleware (if using ctx.state for user data)
app.use(authMiddleware);

// 3. Payment middleware
app.use(paymentMiddleware(routes, resourceServer));

// 4. Route handlers
app.use(router.routes());
```

If you skip the body parser, `adapter.getBody()` returns `undefined`.

## Mount Paths with koa-mount

When using `koa-mount`, the middleware correctly handles path differences:

- **Route matching** uses `ctx.path` (mount-relative path)
- **Resource URL** uses `ctx.origin + ctx.originalUrl` (full external URL)

This distinction matters because clients see the full URL, but your routes are defined relative to the mount point.

```typescript
import Koa from "koa";
import mount from "koa-mount";
import { paymentMiddleware, x402ResourceServer } from "@x402/koa";

const api = new Koa();

// Routes are defined relative to the mount point
api.use(
  paymentMiddleware(
    {
      "GET /report/:id": {
        accepts: {
          scheme: "exact",
          price: "$0.50",
          network: "eip155:84532",
          payTo: "0xYourAddress",
        },
      },
    },
    resourceServer,
  ),
);

api.use(async ctx => {
  // ctx.path is "/report/123" (mount-relative)
  // ctx.originalUrl is "/v1/report/123" (full path client requested)
  ctx.body = { id: ctx.params?.id };
});

const app = new Koa();
app.use(mount("/v1", api));

// Client requests: GET /v1/report/123
// Middleware matches: /report/:id (mount-relative)
// Payment resource field: https://example.com/v1/report/123 (full URL)
app.listen(3000);
```

## Streaming Responses

The middleware supports streaming responses via `ctx.body`. If settlement fails after the handler sets a stream body, the middleware destroys the stream and returns a 402 response.

```typescript
import { createReadStream } from "fs";

app.use(async ctx => {
  if (ctx.path === "/download") {
    ctx.type = "application/octet-stream";
    ctx.body = createReadStream("/path/to/file");
  }
});
```

## Response Bypass Detection

The middleware detects and reports configurations where content is served without settlement. This is a **detection mechanism, not protection** - the leaked request cannot be retracted.

### `ctx.respond = false`

When a handler sets `ctx.respond = false` to bypass Koa's response handling:

```typescript
app.use(async ctx => {
  ctx.respond = false;
  ctx.res.writeHead(200);
  ctx.res.end("direct response"); // Content sent without settlement
});
```

The middleware throws an error naming the route. The client receives the content, settlement never runs, and the error surfaces in server logs for subsequent requests.

### Direct `ctx.res` writes

When downstream middleware writes directly to `ctx.res` and flushes headers:

```typescript
app.use(async ctx => {
  ctx.res.writeHead(200);
  ctx.res.write("partial"); // Headers flushed
  ctx.res.end(" response");
});
```

The middleware throws an error. Again, the client receives unpaid content - the throw helps operators find and fix the misconfiguration, it does not prevent the initial leak.

**Prevention**: Use `ctx.body` for all responses on protected routes. Do not set `ctx.respond = false` or write directly to `ctx.res`.

## Usage-Based Billing (Partial Settlement)

For routes using the `upto` scheme, handlers communicate actual usage via `setSettlementOverrides`:

```typescript
import { paymentMiddleware, setSettlementOverrides } from "@x402/koa";

app.use(async ctx => {
  // Process request, calculate actual cost
  const tokensUsed = 500;
  const costInCents = tokensUsed * 0.001;

  // Tell middleware to settle less than the authorized maximum
  setSettlementOverrides(ctx, { amount: String(costInCents) });

  ctx.body = { tokens: tokensUsed };
});
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

### Custom Facilitator Client

```typescript
import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402ResourceServer } from "@x402/koa";
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

### Alternative Middleware Signatures

**`paymentMiddlewareFromHTTPServer`** - When you need HTTP-level hooks:

```typescript
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer } from "@x402/koa";

const httpServer = new x402HTTPResourceServer(resourceServer, routes)
  .onProtectedRequest(requestHook);

app.use(paymentMiddlewareFromHTTPServer(httpServer));
```

**`paymentMiddlewareFromConfig`** - Quick setup with inline configuration:

```typescript
import { paymentMiddlewareFromConfig } from "@x402/koa";
import { ExactEvmScheme } from "@x402/evm/exact/server";

app.use(
  paymentMiddlewareFromConfig(
    routes,
    facilitatorClient,
    [{ network: "eip155:84532", server: new ExactEvmScheme() }],
    paywallConfig,
  ),
);
```
