# Sign-In-With-X (SIWX) Server Example

Express.js server demonstrating both SIWX patterns supported by x402:
- Auth-only routes that require a wallet signature but no payment
- Paid routes where a wallet can pay once, then authenticate with SIWX on later requests

```typescript
import express from "express";
import { paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  declareSIWxExtension,
  siwxResourceServerExtension,
  createSIWxSettleHook,
  createSIWxRequestHook,
  InMemorySIWxStorage,
} from "@x402/extensions/sign-in-with-x";

const storage = new InMemorySIWxStorage();

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .registerExtension(siwxResourceServerExtension)
  .onAfterSettle(createSIWxSettleHook({ storage }));

const httpServer = new x402HTTPResourceServer(resourceServer, routes)
  .onProtectedRequest(createSIWxRequestHook({ storage }));

const app = express();
app.use(paymentMiddlewareFromHTTPServer(httpServer));
```

## How It Works

1. **Auth-only route** — Server returns a SIWX challenge and grants access on a valid signature alone
2. **Paid route** — First request requires payment
3. **Server records** — Payment is recorded against the wallet address in storage
4. **Later paid-route request** — Signature proves wallet ownership and grants access without re-payment

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- At least one payout address: EVM, SVM, or both
- Facilitator URL (see [facilitator list](https://www.x402.org/ecosystem?category=facilitators))

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variables:

- `FACILITATOR_URL` - Facilitator endpoint URL
- `EVM_ADDRESS` - (Optional) Ethereum address to receive payments
- `SVM_ADDRESS` - (Optional) Solana address for SVM payments

At least one of `EVM_ADDRESS` or `SVM_ADDRESS` is required.

2. Install and build from typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd servers/sign-in-with-x
```

3. Run the server:

```bash
pnpm dev
```

## Testing the Server

Start the SIWX client to test:

```bash
cd ../../clients/sign-in-with-x
# Ensure .env is setup with EVM_PRIVATE_KEY or SVM_PRIVATE_KEY
pnpm start
```

The client will:
1. Access `/profile` with SIWX and no payment
2. Make first request and pay for `/weather`
3. Make second request to `/weather` with SIWX instead of payment
4. Make first request and pay for `/joke`
5. Make second request to `/joke` with SIWX instead of payment

## Example Endpoints

- `GET /profile` — Auth-only wallet-gated profile data (no payment)
- `GET /weather` — Weather data ($0.001 USDC)
- `GET /joke` — Joke content ($0.001 USDC)

`/profile` requires only a valid SIWX signature. `/weather` and `/joke` require payment once per wallet address, then accept SIWX on later requests.

## SIWX Extension Configuration

The server uses three key components:

### 1. Extension Declaration

```typescript
const routes = {
  "GET /weather": {
    accepts: [{ scheme: "exact", price: "$0.001", network: "eip155:84532", payTo: evmAddress }],
    description: "Weather data",
    mimeType: "application/json",
    extensions: declareSIWxExtension(), // Announces SIWX support
  },
  "GET /profile": {
    accepts: [],
    description: "Auth-only: wallet signature required",
    extensions: declareSIWxExtension({
      network: ["eip155:84532", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
      statement: "Sign in to view your profile",
      expirationSeconds: 300,
    }),
  },
};
```

### 2. Settle Hook (Records Payments)

```typescript
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .registerExtension(siwxResourceServerExtension)
  .onAfterSettle(createSIWxSettleHook({ storage })); // Records paid addresses
```

### 3. Request Hook (Verifies SIWX)

```typescript
const httpServer = new x402HTTPResourceServer(resourceServer, routes)
  .onProtectedRequest(createSIWxRequestHook({ storage })); // Checks SIWX auth
```

For routes declared with `accepts: []`, the request hook grants access on valid SIWX alone. For paid routes, it also checks whether that wallet has already paid.

## Storage Backend

This example uses in-memory storage (`InMemorySIWxStorage`). For production, implement persistent storage:

```typescript
import { SIWxStorage } from "@x402/extensions/sign-in-with-x";

class RedisSIWxStorage implements SIWxStorage {
  async recordPayment(resource: string, address: string): Promise<void> {
    // Store in Redis/database
  }

  async hasPaid(resource: string, address: string): Promise<boolean> {
    // Check Redis/database
  }
}

const storage = new RedisSIWxStorage();
```

## Optional SVM Support

To enable Solana (SVM) payments, provide `SVM_ADDRESS` in `.env`:

```typescript
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new ExactSvmScheme());
```

## Event Logging

Monitor SIWX events:

```typescript
function onEvent(event: { type: string; resource: string; address?: string }) {
  console.log(`[SIWX] ${event.type}`, event);
}

createSIWxRequestHook({ storage, onEvent });
```

Event types:
- `payment_recorded` — Wallet paid for resource
- `access_granted` — SIWX signature verified and access granted
- `validation_failed` — Header parsing, message validation, or signature verification failed
- `nonce_reused` — A previously used SIWX nonce was replayed
