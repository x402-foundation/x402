# @x402/core Custom Server

Demonstrates how to implement x402 payment handling manually without using pre-built middleware packages like `@x402/express` or `@x402/hono`.

```typescript
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: facilitatorUrl }),
).register("eip155:84532", new ExactEvmScheme());

// In your request handler:
if (!paymentHeader) {
  const paymentRequired = resourceServer.createPaymentRequiredResponse([requirements], resource);
  res.status(402).set("PAYMENT-REQUIRED", encode(paymentRequired)).json({});
  return;
}

const paymentPayload = decode(paymentHeader);
const verifyResult = await resourceServer.verifyPayment(paymentPayload, requirements);
if (!verifyResult.isValid) return res.status(402).json({ error: verifyResult.invalidReason });

// Execute handler, then settle
const settleResult = await resourceServer.settlePayment(paymentPayload, requirements);
res.set("PAYMENT-RESPONSE", encode(settleResult));
```

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- Valid EVM address for receiving payments
- URL of a facilitator supporting the desired payment network, see [facilitator list](https://www.x402.org/ecosystem?category=facilitators)

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variables:

- `FACILITATOR_URL` - Facilitator endpoint URL
- `EVM_ADDRESS` - Ethereum address to receive payments

2. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd servers/custom
```

3. Run the server

```bash
pnpm dev
```

## Testing the Server

You can test the server using one of the example clients:

### Using the Fetch Client

```bash
cd ../../clients/fetch
# Ensure .env is setup
pnpm dev
```

### Using the Axios Client

```bash
cd ../../clients/axios
# Ensure .env is setup
pnpm dev
```

These clients will demonstrate how to:

1. Make an initial request to get payment requirements
2. Process the payment requirements
3. Make a second request with the payment token

## Example Endpoint

The server includes a single example endpoint at `/weather` that requires a payment of 0.001 USDC on Base Sepolia to access. The endpoint returns weather data for a given city.

## HTTP Headers

### Request Headers

When submitting payment, include one of these headers (both are supported for backwards compatibility):

| Header              | Protocol | Description                         |
| ------------------- | -------- | ----------------------------------- |
| `PAYMENT-SIGNATURE` | v2       | Base64-encoded JSON payment payload |
| `X-PAYMENT`         | v1       | Base64-encoded JSON payment payload |

Example request with payment:

```
GET /weather HTTP/1.1
Host: localhost:4021
PAYMENT-SIGNATURE: eyJwYXltZW50IjoiLi4uIn0=
```

### Response Headers

| Header             | Status | Description                                   |
| ------------------ | ------ | --------------------------------------------- |
| `PAYMENT-REQUIRED` | 402    | Base64-encoded JSON with payment requirements |
| `PAYMENT-RESPONSE` | 200    | Base64-encoded JSON with settlement details   |

## Response Format

### Payment Required (402)

```
HTTP/1.1 402 Payment Required
Content-Type: application/json; charset=utf-8
PAYMENT-REQUIRED: <base64-encoded JSON>

{"error":"Payment Required","message":"This endpoint requires payment"}
```

The `PAYMENT-REQUIRED` header contains base64-encoded JSON with the payment requirements:

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://localhost:4021/weather",
    "description": "Weather data",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "1000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x...",
      "maxTimeoutSeconds": 300,
      "extra": {
        "name": "USDC",
        "version": "2",
        "resourceUrl": "http://localhost:4021/weather"
      }
    }
  ]
}
```

### Successful Response (with payment)

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
PAYMENT-RESPONSE: <base64-encoded JSON>

{"city":"San Francisco","weather":"foggy","temperature":60,"timestamp":"2024-01-01T12:00:00.000Z"}
```

The `PAYMENT-RESPONSE` header contains base64-encoded JSON with the settlement details:

```json
{
  "success": true,
  "transaction": "0x...",
  "network": "eip155:84532",
  "payer": "0x...",
  "requirements": {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "1000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x...",
    "maxTimeoutSeconds": 300,
    "extra": {
      "name": "USDC",
      "version": "2",
      "resourceUrl": "http://localhost:4021/weather"
    }
  }
}
```

## Payment Flow

The custom implementation demonstrates each step of the x402 payment flow:

1. **Request Arrives** — Middleware intercepts all requests
2. **Route Check** — Determine if route requires payment
3. **Payment Check** — Look for `PAYMENT-SIGNATURE` or `X-PAYMENT` header
4. **Decision Point**:
   - **No Payment**: Return 402 with requirements in `PAYMENT-REQUIRED` header
   - **Payment Provided**: Verify with facilitator
5. **Verification** — Check payment signature and validity
6. **Handler Execution** — Run protected endpoint handler
7. **Settlement** — Settle payment on-chain (for 2xx responses)
8. **Response** — Add settlement details in `PAYMENT-RESPONSE` header

## Key Implementation Details

### Defining Payment Requirements

```typescript
const routeConfigs: Record<string, RoutePaymentConfig> = {
  "GET /weather": {
    scheme: "exact",
    price: "$0.001",
    network: "eip155:84532",
    payTo: evmAddress,
    description: "Weather data",
    mimeType: "application/json",
  },
};
```

### Checking for Payment

```typescript
const paymentHeader = (req.headers["payment-signature"] || req.headers["x-payment"]) as
  | string
  | undefined;

if (!paymentHeader) {
  const paymentRequired = resourceServer.createPaymentRequiredResponse([requirements], {
    url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
    description: routeConfig.description,
    mimeType: routeConfig.mimeType,
  });
  const requirementsHeader = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");

  res.status(402);
  res.set("PAYMENT-REQUIRED", requirementsHeader);
  res.json({
    error: "Payment Required",
    message: "This endpoint requires payment",
  });
  return;
}
```

### Verifying Payment

```typescript
const paymentPayload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
const verifyResult = await resourceServer.verifyPayment(paymentPayload, requirements);

if (!verifyResult.isValid) {
  res.status(402).json({
    error: "Invalid Payment",
    reason: verifyResult.invalidReason,
  });
  return;
}
```

### Settling Payment

```typescript
const settleResult = await resourceServer.settlePayment(paymentPayload, requirements);
const settlementHeader = Buffer.from(JSON.stringify(settleResult)).toString("base64");
res.set("PAYMENT-RESPONSE", settlementHeader);
```

## Middleware vs Custom Comparison

| Aspect                 | With Middleware (@x402/express) | Custom Implementation |
| ---------------------- | ------------------------------- | --------------------- |
| Code Complexity        | ~10 lines                       | ~150 lines            |
| Automatic Verification | ✅ Yes                          | ❌ Manual             |
| Automatic Settlement   | ✅ Yes                          | ❌ Manual             |
| Header Management      | ✅ Automatic                    | ❌ Manual             |
| Flexibility            | Limited                         | ✅ Complete control   |
| Error Handling         | ✅ Built-in                     | ❌ You implement      |
| Maintenance            | x402 team                       | You maintain          |

## When to Use Each Approach

**Use Middleware (@x402/express, @x402/hono) when:**

- Building standard applications
- Want quick integration
- Prefer automatic payment handling
- Using supported frameworks (Express, Hono)

**Use Custom Implementation when:**

- Using unsupported frameworks (Koa, Fastify, etc.)
- Need complete control over flow
- Require custom error handling
- Want to understand internals
- Building custom abstractions

## Adapting to Other Frameworks

To use this pattern with other frameworks:

1. Create middleware function for your framework
2. Check for payment requirements per route
3. Use `x402ResourceServer` to verify/settle payments
4. Intercept responses to add settlement headers

The pattern in `index.ts` can be adapted to any Node.js web framework.
