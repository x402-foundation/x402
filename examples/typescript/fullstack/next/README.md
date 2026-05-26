# x402-next Example App

Next.js application demonstrating how to protect routes with a paywall using the `@x402/next` middleware.

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- Valid EVM and SVM addresses for receiving payments
- URL of a facilitator supporting the desired payment network, see [facilitator list](https://www.x402.org/ecosystem?category=facilitators)

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variables:

- `FACILITATOR_URL` - Facilitator endpoint URL
- `EVM_ADDRESS` - Ethereum address to receive payments
- `SVM_ADDRESS` - Solana address to receive payments

2. Install and build all packages from the typescript examples root:
```bash
cd ../../
pnpm install && pnpm build
cd fullstack/next
```

3. Run the server:
```bash
pnpm dev
```

## Example Routes

The app includes protected routes that require payment to access:

### Protected Page Route

The `/protected` route is protected using `paymentProxy`. Page routes are protected using this approach:

```typescript
// proxy.ts
import { paymentProxy } from "@x402/next";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { createPaywall } from "@x402/paywall";
import { evmPaywall } from "@x402/paywall/evm";
import { svmPaywall } from "@x402/paywall/svm";

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const server = new x402ResourceServer(facilitatorClient);

// Register schemes
registerExactEvmScheme(server);
registerExactSvmScheme(server);

// Build paywall using builder pattern
const paywall = createPaywall()
  .withNetwork(evmPaywall)
  .withNetwork(svmPaywall)
  .withConfig({
    appName: "Next x402 Demo",
    appLogo: "/x402-icon-blue.png",
    testnet: true,
  })
  .build();

export const proxy = paymentProxy(
  {
    "/protected": {
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
      description: "Premium music: x402 Remix",
      mimeType: "text/html",
    },
  },
  server,
  undefined, // paywallConfig (using custom paywall instead)
  paywall,   // custom paywall provider
);

export const config = {
  matcher: ["/protected/:path*"],
};
```

### Weather API Route (using withX402)

The `/api/weather` route demonstrates the `withX402` wrapper for individual API routes:

```typescript
// app/api/weather/route.ts
import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { server, paywall, evmAddress, svmAddress } from "../../../proxy";

const handler = async (_: NextRequest) => {
  return NextResponse.json({
    report: {
      weather: "sunny",
      temperature: 72,
    },
  });
};

export const GET = withX402(
  handler,
  {
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
    description: "Access to weather API",
    mimeType: "application/json",
  },
  server,
  undefined, // paywallConfig (using custom paywall from proxy.ts)
  paywall,
);
```

## Response Format

### Payment Required (402)

```
HTTP/1.1 402 Payment Required
Content-Type: application/json; charset=utf-8
PAYMENT-REQUIRED: <base64-encoded JSON>

{}
```

The `PAYMENT-REQUIRED` header contains base64-encoded JSON with the payment requirements.
Note: `amount` is in atomic units (e.g., 1000 = 0.001 USDC, since USDC has 6 decimals):

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://localhost:3000/api/weather",
    "description": "Access to weather API",
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

### Successful Response

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
PAYMENT-RESPONSE: <base64-encoded JSON>

{"report":{"weather":"sunny","temperature":72}}
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

## paymentProxy vs withX402

The `paymentProxy` function is used to protect page routes. It can also protect API routes, however this will charge clients for failed API responses.

The `withX402` function wraps API route handlers. This is the recommended approach to protect API routes as it guarantees payment settlement only AFTER successful API responses (status < 400).

| Approach | Use Case |
|----------|----------|
| `paymentProxy` | Protecting page routes or multiple routes with a single configuration |
| `withX402` | Protecting individual API routes where you need precise control over settlement timing |

## Extending the Example

To add more protected routes, update the proxy configuration:

```typescript
export const proxy = paymentProxy(
  {
    "/protected": {
      accepts: {
        scheme: "exact",
        price: "$0.001",
        network: "eip155:84532",
        payTo: evmAddress,
      },
      description: "Access to protected content",
    },
    "/premium": {
      accepts: {
        scheme: "exact",
        price: "$0.10",
        network: "eip155:84532",
        payTo: evmAddress,
      },
      description: "Premium content access",
    },
  },
  server,
  undefined,
  paywall,
);

export const config = {
  matcher: ["/protected/:path*", "/premium/:path*"],
};
```

**Network identifiers** use [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) format, for example:
- `eip155:84532` — Base Sepolia
- `eip155:8453` — Base Mainnet
- `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` — Solana Devnet
- `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` — Solana Mainnet
