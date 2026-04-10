# @x402/core

Core implementation of the x402 payment protocol for TypeScript/JavaScript applications. Provides transport-agnostic client, server and facilitator components.

## Installation

```bash
pnpm install @x402/core
```

## Quick Start

### Client Usage

```typescript
import { x402Client } from '@x402/core/client';
import { x402HTTPClient } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';

// Create core client and register payment schemes
const coreClient = new x402Client()
  .register('eip155:*', new ExactEvmScheme(evmSigner));

// Wrap with HTTP client for header encoding/decoding
const client = new x402HTTPClient(coreClient);

// Make a request
const response = await fetch('https://api.example.com/protected');

if (response.status === 402) {
  // Extract payment requirements from response
  const paymentRequired = client.getPaymentRequiredResponse(
    (name) => response.headers.get(name),
    await response.json()
  );
  
  // Create and send payment
  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  
  const paidResponse = await fetch('https://api.example.com/protected', {
    headers: client.encodePaymentSignatureHeader(paymentPayload),
  });
  
  // Get settlement confirmation
  const settlement = client.getPaymentSettleResponse(
    (name) => paidResponse.headers.get(name)
  );
  console.log('Transaction:', settlement.transaction);
}
```

### Server Usage

```typescript
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { x402HTTPResourceServer } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/server';

// Connect to facilitator
const facilitatorClient = new HTTPFacilitatorClient({
  url: 'https://x402.org/facilitator',
});

// Create resource server with payment schemes
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register('eip155:*', new ExactEvmScheme());

// Initialize (fetches supported kinds from facilitator)
await resourceServer.initialize();

// Configure routes with payment requirements
const routes = {
  'GET /api/data': {
    accepts: {
      scheme: 'exact',
      network: 'eip155:8453',
      payTo: '0xYourAddress',
      price: '$0.01',
    },
    description: 'Premium data access',
    mimeType: 'application/json',
  },
};

// Create HTTP server wrapper
const httpServer = new x402HTTPResourceServer(resourceServer, routes);
```

### Facilitator Usage

```typescript
import { x402Facilitator } from '@x402/core/facilitator';
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator';

const facilitator = new x402Facilitator();

// Register scheme implementations using helper
registerExactEvmScheme(facilitator, {
  signer: evmSigner,
  networks: 'eip155:84532',
});

// Verify payment
const verifyResult = await facilitator.verify(paymentPayload, paymentRequirements);

if (verifyResult.isValid) {
  // Settle payment
  const settleResult = await facilitator.settle(paymentPayload, paymentRequirements);
  console.log('Transaction:', settleResult.transaction);
}
```

## Route Configuration

Routes use the `accepts` field to define payment options:

```typescript
const routes = {
  // Single payment option
  'GET /api/data': {
    accepts: {
      scheme: 'exact',
      network: 'eip155:8453',
      payTo: '0xAddress',
      price: '$0.01',
    },
    description: 'Data endpoint',
    mimeType: 'application/json',
  },
  
  // Multiple payment options (EVM + SVM)
  'POST /api/*': {
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        payTo: evmAddress,
        price: '$0.05',
      },
      {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        payTo: svmAddress,
        price: '$0.05',
      },
    ],
  },
};
```

## Client Configuration

Use `fromConfig()` for declarative setup:

```typescript
const client = x402Client.fromConfig({
  schemes: [
    { network: 'eip155:8453', client: new ExactEvmScheme(evmSigner) },
    { network: 'solana:mainnet', client: new ExactSvmScheme(svmSigner) },
  ],
  policies: [
    // Filter by max price
    (version, reqs) => reqs.filter(r => BigInt(r.amount) < BigInt('1000000')),
  ],
});
```

## Lifecycle Hooks

### Client Hooks

```typescript
client
  .onBeforePaymentCreation(async (ctx) => {
    console.log('Creating payment for:', ctx.selectedRequirements.network);
    // Return { abort: true, reason: '...' } to cancel
  })
  .onAfterPaymentCreation(async (ctx) => {
    console.log('Payment created:', ctx.paymentPayload);
  })
  .onPaymentCreationFailure(async (ctx) => {
    console.error('Payment failed:', ctx.error);
    // Return { recovered: true, payload: ... } to recover
  });
```

### Server Hooks

```typescript
resourceServer
  .onBeforeVerify(async (ctx) => { /* ... */ })
  .onAfterVerify(async (ctx) => { /* ... */ })
  .onBeforeSettle(async (ctx) => { /* ... */ })
  .onAfterSettle(async (ctx) => { /* ... */ });
```

### Facilitator Hooks

```typescript
facilitator
  .onBeforeVerify(async (ctx) => { console.log('Before verify', ctx); })
  .onAfterVerify(async (ctx) => { console.log('After verify', ctx); })
  .onVerifyFailure(async (ctx) => { console.log('Verify failure', ctx); })
  .onBeforeSettle(async (ctx) => { console.log('Before settle', ctx); })
  .onAfterSettle(async (ctx) => { console.log('After settle', ctx); })
  .onSettleFailure(async (ctx) => { console.log('Settle failure', ctx); });
```

## HTTP Headers

### v2 Protocol (Current)

| Header | Description |
|--------|-------------|
| `PAYMENT-SIGNATURE` | Base64-encoded payment payload |
| `PAYMENT-REQUIRED` | Base64-encoded payment requirements |
| `PAYMENT-RESPONSE` | Base64-encoded settlement response |

### v1 Protocol (Legacy)

| Header | Description |
|--------|-------------|
| `X-PAYMENT` | Base64-encoded payment payload |
| `X-PAYMENT-RESPONSE` | Base64-encoded settlement response |

## Network Pattern Matching

Register handlers for network families using wildcards:

```typescript
// All EVM networks
server.register('eip155:*', new ExactEvmScheme());

// Specific network takes precedence
server.register('eip155:8453', new ExactEvmScheme());
```

## Types

```typescript
type Network = `${string}:${string}`; // e.g., "eip155:8453"

type PaymentRequirements = {
  scheme: string;
  network: Network;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};

type PaymentPayload = {
  x402Version: number;
  resource: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};

type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
};
```

## Framework Integration

For framework-specific middleware, use:

- `@x402/express` - Express.js middleware
- `@x402/hono` - Hono middleware  
- `@x402/next` - Next.js integration
- `@x402/axios` - Axios interceptor
- `@x402/fetch` - Fetch wrapper

## Implementation Packages

For blockchain-specific implementations:

- `@x402/evm` - Ethereum and EVM-compatible chains
- `@x402/svm` - Solana blockchain

## Examples

See the [examples directory](https://github.com/x402-foundation/x402/tree/main/examples/typescript) for complete examples.

## Contributing

Contributions welcome! See [Contributing Guide](https://github.com/x402-foundation/x402/blob/main/CONTRIBUTING.md).
