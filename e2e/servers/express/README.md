# E2E Test Server: Express (TypeScript)

This server demonstrates and tests the x402 Express.js middleware with EVM, SVM, and optional Stellar payment protection.

## What It Tests

### Core Functionality
- ✅ **V2 Protocol** - Modern x402 server middleware
- ✅ **Payment Protection** - Middleware protecting specific routes
- ✅ **Multi-chain Support** - EVM, SVM, and (optional) Stellar payment acceptance
- ✅ **Facilitator Integration** - HTTP communication with facilitator
- ✅ **Extension Support** - Bazaar discovery metadata
- ✅ **Settlement Handling** - Payment verification and confirmation

### Protected Endpoints
- ✅ `GET /protected` - Requires EVM payment (USDC on Base Sepolia)
- ✅ `GET /protected-svm` - Requires SVM payment (USDC on Solana Devnet)
- ✅ `GET /protected-stellar` - Requires Stellar payment (USDC on Stellar Testnet)

## What It Demonstrates

### Server Setup

```typescript
import express from "express";
import { x402Middleware } from "@x402/server/express";
import { ExactEvmServer } from "@x402/evm";
import { ExactSvmServer } from "@x402/svm";
import { ExactStellarServer } from "@x402/stellar";

const app = express();

// Define payment requirements for routes
const routes = {
  "GET /protected": {
    scheme: "exact",
    network: "eip155:84532",
    payTo: "0xYourAddress",
    price: "$0.001",
    extensions: {
      bazaar: discoveryMetadata
    }
  },
  "GET /protected-svm": {
    scheme: "exact",
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    payTo: "YourSolanaAddress",
    price: "$0.001",
    extensions: {
      bazaar: discoveryMetadata
    }
  },
  "GET /protected-stellar": {
    scheme: "exact",
    network: "stellar:testnet",
    payTo: "YourStellarAddress",
    price: "$0.001",
    extensions: {
      bazaar: discoveryMetadata
    }
  }
};

// Apply x402 middleware with EVM, SVM, and Stellar servers
app.use(x402Middleware({
  routes,
  facilitatorUrl: "http://localhost:4023",
  servers: {
    "eip155:84532": new ExactEvmServer(),
    "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": new ExactSvmServer(),
    "stellar:testnet": new ExactStellarServer()
  }
}));

// Define protected endpoints
app.get("/protected", (req, res) => {
  res.json({ message: "EVM payment successful!" });
});

app.get("/protected-svm", (req, res) => {
  res.json({ message: "SVM payment successful!" });
});

app.get("/protected-stellar", (req, res) => {
  res.json({ message: "Stellar payment successful!" });
});
```

### Key Concepts Shown

1. **Route-Based Configuration** - Payment requirements per route
2. **Multi-Chain Services** - Different services for different networks
3. **Price Parsing** - Dollar amounts converted to token units
4. **Facilitator Client** - HTTP communication with payment processor
5. **Extension Metadata** - Bazaar discovery info embedded in responses
6. **Automatic 402 Responses** - Middleware generates payment requirements

## Test Scenarios

This server is tested with:
- **Clients:** TypeScript Fetch, Go HTTP
- **Facilitators:** TypeScript, Go
- **Payment Types:** EVM (Base Sepolia), SVM (Solana Devnet), Stellar (Stellar Testnet)
- **Protocols:** V2 (primary), V1 (via client negotiation)

### Request Flow
1. Client makes initial request (no payment)
2. Middleware returns 402 with payment requirements
3. Client creates payment payload
4. Client retries with payment signature
5. Middleware verifies payment via facilitator
6. Middleware returns protected content

## Running

```bash
# Via e2e test suite
cd e2e
pnpm test --server=express

# Direct execution
cd e2e/servers/express
export FACILITATOR_URL="http://localhost:4023"
export EVM_PAYEE_ADDRESS="0x..."
export SVM_PAYEE_ADDRESS="..."
export STELLAR_PAYEE_ADDRESS="G..." # optional
export PORT=4022
pnpm start
```

## Environment Variables

### Required
- `PORT` - HTTP server port (default: 4022)
- `FACILITATOR_URL` - Facilitator endpoint URL
- `EVM_PAYEE_ADDRESS` - Ethereum address to receive payments
- `SVM_PAYEE_ADDRESS` - Solana address to receive payments

### Optional
- `STELLAR_PAYEE_ADDRESS` - Stellar address to receive payments - enables Stellar endpoint
- `EVM_NETWORK` - EVM network (default: eip155:84532)
- `SVM_NETWORK` - SVM network (default: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1)
- `STELLAR_NETWORK` - Stellar network (default: stellar:testnet)

## Response Examples

### 402 Payment Required (No Payment Sent)

```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64-encoded-payment-requirements>

{
  "error": "Payment required",
  "x402Version": 2,
  "accepts": [...]
}
```

### 200 Success (Payment Verified)

```
HTTP/1.1 200 OK
PAYMENT-RESPONSE: <base64-encoded-settlement-response>

{
  "message": "Protected endpoint accessed successfully"
}
```

## Package Dependencies

- `@x402/server` - Express middleware
- `@x402/evm` - EVM server
- `@x402/svm` - SVM server
- `@x402/stellar` - Stellar server
- `@x402/extensions/bazaar` - Discovery extension
- `express` - HTTP server framework

## Implementation Highlights

### Middleware Features
- **Automatic 402 Responses** - Generates payment requirements
- **Payment Verification** - Validates via facilitator
- **Settlement Tracking** - Includes payment response headers
- **Extension Support** - Embeds bazaar metadata
- **Error Handling** - Clear error messages for payment failures

### Service Integration
- **EVM Server** - Handles Base Sepolia USDC payments
- **SVM Server** - Handles Solana Devnet USDC payments
- **Stellar Server** - Handles Stellar Testnet USDC contract payments (SEP-41)
- **Price Conversion** - "$0.001" → token amounts with decimals
- **Asset Resolution** - Automatic USDC contract/mint lookup
