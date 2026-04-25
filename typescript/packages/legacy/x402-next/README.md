# x402-next

> **Deprecated (v1)**  
> This npm package implements x402 **v1**. It is **deprecated** and will only receive **security patches**. Please migrate to **v2** (`@x402/next`, `@x402/core`, `@x402/evm`, etc.). See the [Migration guide: v1 to v2](https://docs.x402.org/guides/migration-v1-to-v2).
> Legacy examples are available at git tag `archive/legacy-v1-examples`.

Next.js middleware integration for the x402 Payment Protocol. This package allows you to easily add paywall functionality to your Next.js applications using the x402 protocol.

## Installation

```bash
pnpm install x402-next
```

## Quick Start

### Protecting Page Routes

Page routes are protected using the x402-next middleware. Create a middleware file in your Next.js project (e.g., `middleware.ts`):

```typescript
import { paymentMiddleware, Network } from 'x402-next';

export const middleware = paymentMiddleware(
  "0xYourAddress",
  {
    '/protected': {
      price: '$0.01',
      network: "base-sepolia",
      config: {
        description: 'Access to protected content'
      }
    },
  }
);

// Configure which paths the middleware should run on
export const config = {
  matcher: ['/protected/:path*'],
  runtime: "nodejs",
};
```

### Protecting API Routes

API routes are protected using the `withX402` route wrapper. This is the recommended approach to protect API routes as it guarantees payment settlement only AFTER successful API responses (status < 400). API routes can also be protected by `paymentMiddleware`, however this will charge clients for failed API responses:

```typescript
// app/api/your-endpoint/route.ts
import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "x402-next";

const handler = async (_: NextRequest) => {
  return NextResponse.json({ data: "your response" });
};

export const GET = withX402(
  handler,
  "0xYourAddress",
  {
    price: "$0.01",
    network: "base-sepolia",
    config: { description: "Access to API endpoint" }
  }
);
```

## Configuration

### paymentMiddleware

The `paymentMiddleware` function is used to protect page routes. It can also protect API routes, however this will charge clients for failed API responses. It accepts four parameters:

1. `payTo`: Your receiving address (`0x${string}`)
2. `routes`: Route configurations for protected endpoints
3. `facilitator`: (Optional) Configuration for the x402 facilitator service
4. `paywall`: (Optional) Configuration for the built-in paywall

### withX402

The `withX402` function wraps API route handlers. This is the recommended approach to protect API routes as it guarantees payment settlement only AFTER successful API responses (status < 400). It accepts five parameters:

1. `handler`: Your API route handler function
2. `payTo`: Your receiving address (`0x${string}`)
3. `routeConfig`: Payment configuration for this specific route
4. `facilitator`: (Optional) Configuration for the x402 facilitator service
5. `paywall`: (Optional) Configuration for the built-in paywall

See the Middleware Options section below for detailed configuration options.

## Middleware Options

The middleware supports various configuration options:

### Route Configuration

```typescript
type RoutesConfig = Record<string, Price | RouteConfig>;

interface RouteConfig {
  price: Price;           // Price in USD or token amount
  network: Network;       // "base" or "base-sepolia"
  config?: PaymentMiddlewareConfig;
}
```

### Payment Configuration

```typescript
interface PaymentMiddlewareConfig {
  description?: string;               // Description of the payment
  mimeType?: string;                  // MIME type of the resource
  maxTimeoutSeconds?: number;         // Maximum time for payment (default: 60)
  outputSchema?: Record<string, any>; // JSON schema for the response
  customPaywallHtml?: string;         // Custom HTML for the paywall
  resource?: string;                  // Resource URL (defaults to request URL)
}
```

### Facilitator Configuration

```typescript
type FacilitatorConfig = {
  url: string;                        // URL of the x402 facilitator service
  createAuthHeaders?: CreateHeaders;  // Optional function to create authentication headers
};
```

### Paywall Configuration

For more on paywall configuration options, refer to the [paywall README](../x402/src/paywall/README.md).

```typescript
type PaywallConfig = {
  cdpClientKey?: string;              // Your CDP Client API Key
  appName?: string;                   // Name displayed in the paywall wallet selection modal
  appLogo?: string;                   // Logo for the paywall wallet selection modal
  sessionTokenEndpoint?: string;      // API endpoint for Coinbase Onramp session authentication
};
```

## Accessing Mainnet with @coinbase/x402

To use the official Coinbase facilitator package (`@coinbase/x402`) in your Next.js project:

1. Install the Coinbase facilitator package:

```bash
pnpm install @coinbase/x402
```

2. Use it in your middleware file::

```ts
// middleware.ts
import { paymentMiddleware } from "x402-next";
import { facilitator } from "@coinbase/x402";

export const middleware = paymentMiddleware(
  "0xYourAddress",
  {
    "/protected": {
      price: "$0.01",
      network: "base",
      // other config options
    },
  },
  facilitator // Use the Coinbase facilitator
);
```

3. Set up your CDP API keys as environment variables:

```bash
# .env
CDP_API_KEY_ID=your-cdp-api-key-id
CDP_API_KEY_SECRET=your-cdp-api-key-secret
```

## Optional: Coinbase Onramp Integration

**Note**: Onramp integration is completely optional. Your x402 paywall will work perfectly without it. This feature is for users who want to provide an easy way for their customers to fund their wallets directly from the paywall.

When configured, a "Get more USDC" button will appear in your paywall, allowing users to purchase USDC directly through Coinbase Onramp.

### Quick Setup

#### 1. Configure Your Middleware

Add `sessionTokenEndpoint` to your middleware configuration. This tells the paywall where to find your session token API:

```typescript
export const middleware = paymentMiddleware(
  payTo,
  routes,
  facilitator,
  {
    sessionTokenEndpoint: "/api/x402/session-token", // Enable onramp functionality
    cdpClientKey: "your-cdp-client-key",
    appName: "My App",
  }
);
```

**Important**: The `sessionTokenEndpoint` can be any path you choose - just make sure it matches where you create your API route in the next step. Without this configuration, the "Get more USDC" button will be hidden.

#### 2. Create the Session Token API

Create an API route that matches the path you configured above:

```typescript
// app/api/x402/session-token/route.ts
export { POST } from "x402-next";
```

That's it! The `x402-next` package provides the complete session token implementation.

#### 3. Get CDP API Keys

1. Go to [CDP Portal](https://portal.cdp.coinbase.com/)
2. Navigate to your project's **[API Keys](https://portal.cdp.coinbase.com/projects/api-keys)**
3. Click **Create API key**
4. Download and securely store your API key

#### 4. Enable Onramp Secure Initialization in CDP Portal

1. Go to [CDP Portal](https://portal.cdp.coinbase.com/)
2. Navigate to **Payments → [Onramp & Offramp](https://portal.cdp.coinbase.com/products/onramp)**
3. Toggle **"Enforce secure initialization"** to **Enabled**

#### 5. Set Environment Variables

Add your CDP API keys to your environment:

```bash
# .env
CDP_API_KEY_ID=your_secret_api_key_id_here
CDP_API_KEY_SECRET=your_secret_api_key_secret_here
```

### How Onramp Works

Once set up, your x402 paywall will automatically show a "Get more USDC" button when users need to fund their wallets. 

1. **Generates session token**: Your backend securely creates a session token using CDP's API
2. **Opens secure onramp**: User is redirected to Coinbase Onramp with the session token
3. **No exposed data**: Wallet addresses and app IDs are never exposed in URLs

### Troubleshooting Onramp

#### Common Issues

1. **"Missing CDP API credentials"**
    - Ensure `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` are set
    - Verify you're using **Secret API Keys**, not Client API Keys

2. **"Failed to generate session token"**
    - Check your CDP Secret API key has proper permissions
    - Verify your project has Onramp enabled

3. **API route not found**
    - Ensure you've created your session token API route at the path you configured
    - Check that your API route path matches your `sessionTokenEndpoint` configuration
    - Verify the export: `export { POST } from "x402-next";`
    - Example: If you configured `sessionTokenEndpoint: "/api/custom/onramp"`, create `app/api/custom/onramp/route.ts`


## Resources

- [x402 Protocol](https://x402.org)
- [CDP Documentation](https://docs.cdp.coinbase.com)
- [CDP Discord](https://discord.com/invite/cdp)