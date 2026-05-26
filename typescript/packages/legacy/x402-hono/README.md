# x402-hono

> **Deprecated (v1)**  
> This npm package implements x402 **v1**. It is **deprecated** and will only receive **security patches**. Please migrate to **v2** (`@x402/hono`, `@x402/core`, `@x402/evm`, etc.). See the [Migration guide: v1 to v2](https://docs.x402.org/guides/migration-v1-to-v2).
> Legacy examples are available at git tag `archive/legacy-v1-examples`.

Hono middleware integration for the x402 Payment Protocol. This package allows you to easily add paywall functionality to your Hono applications using the x402 protocol.

## Installation

```bash
npm install x402-hono
```

## Quick Start

```typescript
import { Hono } from "hono";
import { paymentMiddleware, Network } from "x402-hono";

const app = new Hono();

// Configure the payment middleware
app.use(paymentMiddleware(
  "0xYourAddress",
  {
    "/protected-route": {
      price: "$0.10",
      network: "base-sepolia",
      config: {
        description: "Access to premium content",
      }
    }
  }
));

// Implement your route
app.get("/protected-route", (c) => {
  return c.json({ message: "This content is behind a paywall" });
});

serve({
  fetch: app.fetch,
  port: 3000
});
```

## Configuration

The `paymentMiddleware` function accepts three parameters:

1. `payTo`: Your receiving address (`0x${string}`)
2. `routes`: Route configurations for protected endpoints
3. `facilitator`: (Optional) Configuration for the x402 facilitator service
4. `paywall`: (Optional) Configuration for the built-in paywall

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

## Optional: Coinbase Onramp Integration

**Note**: Onramp integration is completely optional. Your x402 paywall will work perfectly without it. This feature is for users who want to provide an easy way for their customers to fund their wallets directly from the paywall.

When configured, a "Get more USDC" button will appear in your paywall, allowing users to purchase USDC directly through Coinbase Onramp.

### Quick Setup

#### 1. Create the Session Token Route

Add a session token endpoint to your Hono app:

```typescript
import { Hono } from "hono";
import { POST } from "x402-hono/session-token";

const app = new Hono();

// Add the session token endpoint
app.post("/api/x402/session-token", POST);
```

#### 2. Configure Your Middleware

Add `sessionTokenEndpoint` to your middleware configuration. This tells the paywall where to find your session token API:

```typescript
app.use(paymentMiddleware(
  payTo,
  routes,
  facilitator,
  {
    sessionTokenEndpoint: "path/to/session-token-route",
  }
));
```

**Important**: The `sessionTokenEndpoint` must match the route you created above. You can use any path you prefer - just make sure both the route and configuration use the same path. Without this configuration, the "Get more USDC" button will be hidden.

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
    - Ensure you've added the session token route: `app.post("/your-path", POST)`
    - Check that your route path matches your `sessionTokenEndpoint` configuration
    - Verify the import: `import { POST } from "x402-hono/session-token"`
    - Example: If you configured `sessionTokenEndpoint: "/api/custom/onramp"`, add `app.post("/api/custom/onramp", POST)`


## Resources

- [x402 Protocol](https://x402.org)
- [CDP Documentation](https://docs.cdp.coinbase.com)
- [CDP Discord](https://discord.com/invite/cdp)
