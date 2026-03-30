# E2E Test Facilitator: TypeScript

This facilitator demonstrates and tests the TypeScript x402 facilitator implementation with EVM, SVM, and optional Stellar payment verification and settlement.

## What It Tests

### Core Functionality
- ✅ **V2 Protocol** - Modern x402 facilitator protocol
- ✅ **V1 Protocol** - Legacy x402 facilitator protocol
- ✅ **Payment Verification** - Validates payment payloads off-chain
- ✅ **Payment Settlement** - Executes transactions on-chain
- ✅ **Multi-chain Support** - EVM, SVM, and (optional) Stellar mechanisms
- ✅ **HTTP API** - Express.js server exposing facilitator endpoints

### Facilitator Endpoints
- ✅ `POST /verify` - Verifies payment payload validity
- ✅ `POST /settle` - Settles payment on blockchain
- ✅ `GET /supported` - Returns supported payment kinds
- ✅ **Extension Support** - Bazaar discovery extension

## What It Demonstrates

### Lifecycle Hooks Usage

This e2e facilitator showcases **production-ready lifecycle hook patterns**:

```typescript
const facilitator = new x402Facilitator()
  .register("eip155:*", new ExactEvmFacilitator(evmSigner))
  .register("stellar:*", new ExactStellarScheme([stellarSigner]))
  .registerExtension(BAZAAR)
  // Hook 1: Track verified payments + extract discovery info
  .onAfterVerify(async (context) => {
    if (context.result.isValid) {
      const paymentHash = createPaymentHash(context.paymentPayload);
      verifiedPayments.set(paymentHash, context.timestamp);
      
      // Catalog discovered resources
      const discovered = extractDiscoveryInfo(context.paymentPayload, context.requirements);
      if (discovered) {
        bazaarCatalog.catalogResource(discovered);
      }
    }
  })
  // Hook 2: Validate payment was verified before settlement
  .onBeforeSettle(async (context) => {
    const paymentHash = createPaymentHash(context.paymentPayload);
    if (!verifiedPayments.has(paymentHash)) {
      return { abort: true, reason: "Payment must be verified first" };
    }
    
    // Check timeout
    const age = context.timestamp - verifiedPayments.get(paymentHash)!;
    if (age > 5 * 60 * 1000) {
      return { abort: true, reason: "Verification expired" };
    }
  })
  // Hook 3: Clean up tracking after settlement
  .onAfterSettle(async (context) => {
    const paymentHash = createPaymentHash(context.paymentPayload);
    verifiedPayments.delete(paymentHash);
  })
  // Hook 4: Clean up on failure too
  .onSettleFailure(async (context) => {
    const paymentHash = createPaymentHash(context.paymentPayload);
    verifiedPayments.delete(paymentHash);
  });
```


### Facilitator Setup

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmFacilitator } from "@x402/evm";
import { ExactEvmFacilitatorV1, NETWORKS as EVM_NETWORKS } from "@x402/evm/v1";
import { ExactSvmFacilitator } from "@x402/svm";
import { ExactSvmFacilitatorV1, NETWORKS as SVM_NETWORKS } from "@x402/svm/v1";
import { ExactStellarFacilitator } from "@x402/stellar";

// Create facilitator with bazaar extension
const facilitator = new x402Facilitator()
  .registerExtension("bazaar");

// Register EVM V2 wildcard
facilitator.register(
  "eip155:*",
  new ExactEvmFacilitator(evmSigner)
);

// Register all EVM V1 networks
EVM_NETWORKS.forEach(network => {
  facilitator.registerSchemeV1(
    network,
    new ExactEvmFacilitatorV1(evmSigner)
  );
});

// Register SVM schemes similarly...

// Register Stellar (v2) schemes similarly...
```

### HTTP Server

```typescript
import express from "express";
import { createFacilitatorRouter } from "@x402/server/facilitator";

const app = express();
app.use(express.json());

// Mount facilitator routes at root
app.use("/", createFacilitatorRouter(facilitator));

app.listen(port, () => {
  console.log(`Facilitator ready at http://localhost:${port}`);
});
```

### Key Concepts Shown

1. **Extension Registration** - Bazaar discovery
2. **Comprehensive Network Support** - All EVM V1 networks, all SVM V1 networks
3. **Wildcard Schemes** - Efficient V2 registration with `eip155:*`, `solana:*`, and `stellar:*`
4. **HTTP Router Integration** - `@x402/server/facilitator` for Express
5. **Real Signers** - Actual blockchain transaction submission
6. **Multi-Protocol** - V1 and V2 side-by-side

## Test Scenarios

This facilitator is tested with:
- **Clients:** TypeScript Fetch, Go HTTP
- **Servers:** Express (TypeScript), Gin (Go)
- **Networks:** Base Sepolia (EVM), Solana Devnet (SVM), Stellar Testnet (Stellar)
- **Test Cases:**
  - V1 EVM payments
  - V2 EVM payments
  - V1 SVM payments
  - V2 SVM payments
  - V2 Stellar payments (optional)

### Success Criteria
- ✅ Verification returns valid status
- ✅ Settlement returns transaction hash
- ✅ Supported endpoint lists all mechanisms
- ✅ Bazaar extension included

## Running

```bash
# Via e2e test suite
cd e2e
pnpm test --facilitator=typescript

# Direct execution
cd e2e/facilitators/typescript
export EVM_PRIVATE_KEY="0x..."
export SVM_PRIVATE_KEY="..."
export STELLAR_PRIVATE_KEY="S..." # optional
export PORT=4025
pnpm start
```

## Environment Variables

### Required
- `PORT` - HTTP server port
- `EVM_PRIVATE_KEY` - Ethereum private key (hex with 0x prefix)
- `SVM_PRIVATE_KEY` - Solana private key (base58 encoded)

### Optional
- `STELLAR_PRIVATE_KEY` - Stellar private key (S... format) - enables Stellar support
- `EVM_NETWORK` - EVM network (default: eip155:84532)
- `SVM_NETWORK` - SVM network (default: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1)
- `STELLAR_NETWORK` - Stellar network (default: stellar:testnet)

## Package Dependencies

- `@x402/core` - Core facilitator
- `@x402/server` - Facilitator HTTP router
- `@x402/evm` - EVM facilitator (V2)
- `@x402/evm/v1` - EVM facilitator (V1) + NETWORKS
- `@x402/svm` - SVM facilitator (V2)
- `@x402/svm/v1` - SVM facilitator (V1) + NETWORKS
- `@x402/stellar` - Stellar facilitator (V2, SEP-41)
- `express` - HTTP server
- `viem` - Ethereum transactions
- `@solana/web3.js` - Solana transactions
