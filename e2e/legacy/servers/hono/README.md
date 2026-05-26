# x402-hono Example Server

This is an example Hono server that demonstrates how to use the `x402-hono` middleware to implement paywall functionality in your API endpoints.

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- A valid Ethereum address for receiving payments
- Coinbase Developer Platform API Key & Secret (if accepting payments on Base mainnet)
-- get them here [https://portal.cdp.coinbase.com/projects](https://portal.cdp.coinbase.com/projects)

## Setup

1. Copy `.env-local` to `.env` and add your Ethereum address to receive payments:

```bash
cp .env-local .env
```

2. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install
pnpm build
cd servers/hono
```

3. Run the server

```bash
pnpm install
pnpm dev
```

## Testing the Server

You can test the server using one of the example clients:

### Using the Fetch Client

```bash
cd ../clients/fetch
# Ensure .env is setup
pnpm install
pnpm dev
```

### Using the Axios Client

```bash
cd ../clients/axios
# Ensure .env is setup
pnpm install
pnpm dev
```

These clients will demonstrate how to:

1. Make an initial request to get payment requirements
2. Process the payment requirements
3. Make a second request with the payment token

## Example Endpoint

The server includes a single example endpoint at `/weather` that requires a payment of $0.001 to access. The endpoint returns a simple weather report.

## Response Format

### Payment Required (402)

```json
{
  "error": "X-PAYMENT header is required",
  "paymentRequirements": {
    "scheme": "exact",
    "network": "base",
    "maxAmountRequired": "1000",
    "resource": "http://localhost:4021/weather",
    "description": "",
    "mimeType": "",
    "payTo": "0xYourAddress",
    "maxTimeoutSeconds": 60,
    "asset": "0x...",
    "outputSchema": null,
    "extra": null
  }
}
```

### Successful Response

```ts
// Body
{
  "report": {
    "weather": "sunny",
    "temperature": 70
  }
}
// Headers
{
  "X-PAYMENT-RESPONSE": "..." // Encoded response object
}
```

## Extending the Example

To add more paid endpoints, follow this pattern:

```typescript
// First, configure the payment middleware with your routes
app.use(
  paymentMiddleware(payTo, {
    // Define your routes and their payment requirements
    "/your-endpoint": {
      price: "$0.10",
      network,
    },
    "/premium/*": {
      price: {
        amount: "100000",
        asset: {
          address: "0xabc",
          decimals: 18,
          eip712: {
            name: "WETH",
            version: "1",
          },
        },
      },
      network,
    },
  }),
);

// Then define your routes as normal
app.get("/your-endpoint", c => {
  return c.json({
    // Your response data
  });
});

app.get("/premium/content", c => {
  return c.json({
    content: "This is premium content",
  });
});
```
