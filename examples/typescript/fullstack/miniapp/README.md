# x402 Farcaster Mini App Example (v2 SDK)

This is a [Next.js](https://nextjs.org) project demonstrating how to build a [Farcaster Mini App](https://miniapps.farcaster.xyz/) with x402 payment-protected API endpoints using the `@x402/next`, `@x402/fetch` and `@x402/evm` packages.

## Prerequisites

- Node.js 22+
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- USDC on Base Sepolia testnet

## Getting Started

1. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd fullstack/miniapp
```

2. Copy environment variables:

```bash
cp .env-local .env
```

3. Configure your environment variables (see Environment Setup below)

4. Start the development server:

```bash
pnpm dev
```

5. Open [http://localhost:3000](http://localhost:3000) with your browser

## Environment Setup

Configure the following variables in your `.env`:

### Required Variables

```bash
# x402 Payment Configuration (required)
FACILITATOR_URL=https://x402.org/facilitator
EVM_ADDRESS=0xYourWalletAddress

# OnchainKit Configuration
NEXT_PUBLIC_ONCHAINKIT_API_KEY=your_onchainkit_api_key_here
NEXT_PUBLIC_ONCHAINKIT_PROJECT_NAME=x402 Mini App

# App URLs and Images
NEXT_PUBLIC_URL=http://localhost:3000
NEXT_PUBLIC_APP_HERO_IMAGE=https://example.com/app-logo.png
NEXT_PUBLIC_SPLASH_IMAGE=https://example.com/app-logo-200x200.png
NEXT_PUBLIC_SPLASH_BACKGROUND_COLOR=#3b82f6
NEXT_PUBLIC_ICON_URL=https://example.com/app-logo.png
```

### Getting API Keys

1. **OnchainKit API Key**: Get from [OnchainKit](https://onchainkit.xyz)
2. **EVM Address**: Your wallet address to receive payments
3. **Facilitator URL**: Use a public facilitator or run your own

## How It Works

### Server-Side Payment Protection

The `/api/protected` endpoint uses the `withX402` wrapper for payment protection:

```typescript
// app/api/protected/route.ts
import { withX402 } from "@x402/next";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";

const facilitatorClient = new HTTPFacilitatorClient({
  url: process.env.FACILITATOR_URL,
});
const server = new x402ResourceServer(facilitatorClient);
registerExactEvmScheme(server);

export const GET = withX402(
  handler,
  {
    accepts: [
      {
        scheme: "exact",
        price: "$0.01",
        network: "eip155:84532", // base-sepolia
        payTo: process.env.EVM_ADDRESS,
      },
    ],
    description: "Access to protected Mini App API",
    mimeType: "application/json",
  },
  server,
);
```

### Client-Side Payment Handling

The frontend uses `@x402/fetch` to handle payments:

```typescript
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

// Create client and register EVM scheme
const client = new x402Client();
registerExactEvmScheme(client, { signer: wagmiToClientSigner(walletClient) });

// Wrap fetch with payment handling
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

// Make request - payment is handled automatically
const response = await fetchWithPayment("/api/protected");
```

### Farcaster Mini App Integration

The app uses the Farcaster Mini App SDK to detect Mini App context:

```typescript
import { sdk } from "@farcaster/miniapp-sdk";

await sdk.actions.ready();
const isInMiniApp = await sdk.isInMiniApp();
```

### Manifest Configuration

The app serves a manifest at `/.well-known/farcaster.json` which is required for publishing the Mini App to Farcaster and the Base app. Configure your app in `minikit.config.ts`:

```typescript
// minikit.config.ts
export const minikitConfig = {
  // Generate at https://warpcast.com/~/developers/mini-apps/manifest
  accountAssociation: {
    header: "your-signed-header",
    payload: "your-signed-payload",
    signature: "your-signature",
  },
  baseBuilder: {
    ownerAddress: "0xYourWalletAddress",
  },
  miniapp: {
    version: "1",
    name: "x402 Mini App",
    // ... other config
  },
};
```

**Before publishing**, you must:

1. Generate `accountAssociation` using [Base Dev Mini App Tools](https://www.base.dev/preview?tab=account) or [Farcaster Manifest Tool](https://farcaster.xyz/~/developers/mini-apps/manifest)
2. Set `baseBuilder.ownerAddress` to your wallet address
3. Set `NEXT_PUBLIC_URL` to your production domain
4. Ensure images meet size requirements:
   - `iconUrl`: 1024x1024px PNG, no alpha
   - `splashImageUrl`: 200x200px
   - `heroImageUrl`: 1200x630px (1.91:1 aspect ratio)

## Response Format

### Payment Required (402)

```
HTTP/1.1 402 Payment Required
Content-Type: application/json
PAYMENT-REQUIRED: <base64-encoded JSON>
```

The `PAYMENT-REQUIRED` header contains payment requirements:

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "10000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x...",
      "maxTimeoutSeconds": 300,
      "extra": { "name": "USDC", "version": "2" }
    }
  ]
}
```

### Successful Response

```json
{
  "success": true,
  "message": "Protected action completed successfully",
  "timestamp": "2024-01-01T00:00:00Z",
  "data": {
    "secretMessage": "This content was paid for with x402!",
    "accessedAt": 1704067200000
  }
}
```

## Extending the Example

### Adding More Protected Routes

Create a new route file (e.g., `app/api/premium/route.ts`) and use the `withX402` wrapper:

```typescript
// app/api/premium/route.ts
import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";

const facilitatorClient = new HTTPFacilitatorClient({
  url: process.env.FACILITATOR_URL,
});
const server = new x402ResourceServer(facilitatorClient);
registerExactEvmScheme(server);

const handler = async (_: NextRequest) => {
  return NextResponse.json({ message: "Premium content!" });
};

export const GET = withX402(
  handler,
  {
    accepts: [
      {
        scheme: "exact",
        price: "$0.10",
        network: "eip155:84532",
        payTo: process.env.EVM_ADDRESS,
      },
    ],
    description: "Premium content access",
    mimeType: "application/json",
  },
  server,
);
```

### Network Identifiers

Network identifiers use [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) format:

- `eip155:84532` - Base Sepolia
- `eip155:8453` - Base Mainnet

## Resources

- [Farcaster Mini Apps Documentation](https://miniapps.farcaster.xyz/)
- [x402 Protocol Documentation](https://x402.org)
- [OnchainKit Documentation](https://onchainkit.xyz)
- [MiniKit Documentation](https://docs.base.org/builderkits/minikit/overview)
- [Next.js Documentation](https://nextjs.org/docs)
- [Tailwind CSS v4 Documentation](https://tailwindcss.com/docs)
