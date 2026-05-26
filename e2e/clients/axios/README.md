# E2E Test Client: TypeScript Axios

This client demonstrates and tests the `@x402/axios` package with EVM, SVM, and Stellar payment support.

## What It Tests

### Core Functionality
- ✅ **V2 Protocol** - Modern x402 protocol with CAIP-2 networks
- ✅ **V1 Protocol** - Legacy x402 protocol with simple network names
- ✅ **Multi-chain Support** - EVM, SVM, and (optional) Stellar in a single client
- ✅ **Automatic Payment Handling** - Transparent 402 response handling
- ✅ **Payment Response Decoding** - Extracts settlement information from headers

### Payment Mechanisms
- ✅ **EVM V2** - `eip155:*` wildcard scheme
- ✅ **EVM V1** - `base-sepolia` and `base` networks
- ✅ **SVM V2** - `solana:*` wildcard scheme
- ✅ **SVM V1** - `solana-devnet` and `solana` networks
- ✅ **Stellar V2** - `stellar:*` wildcard scheme (optional)

## What It Demonstrates

### Usage Pattern

```typescript
import axios from "axios";
import { wrapAxiosWithPayment } from "@x402/axios";
import { x402Client } from "@x402/core/client";
import { ExactEvmClient } from "@x402/evm";
import { ExactEvmClientV1 } from "@x402/evm/v1";
import { ExactSvmClient } from "@x402/svm";
import { ExactSvmClientV1 } from "@x402/svm/v1";
import { ExactStellarClient } from "@x402/stellar";

// Build x402 client with direct registration
const client = new x402Client()
  .register("eip155:*", new ExactEvmClient(evmAccount))
  .register("solana:*", new ExactSvmClient(svmSigner))
  .register("stellar:*", new ExactStellarClient(stellarSigner))
  .registerV1("base-sepolia", new ExactEvmClientV1(evmAccount))
  .registerV1("base", new ExactEvmClientV1(evmAccount))
  .registerV1("solana-devnet", new ExactSvmClientV1(svmSigner))
  .registerV1("solana", new ExactSvmClientV1(svmSigner));

// Wrap axios with payment handling
const axiosWithPayment = wrapAxiosWithPayment(axios.create(), client);

// Make request - 402 responses handled automatically
const response = await axiosWithPayment.get(url);
```

### Key Concepts Shown

1. **Builder Pattern** - Fluent API for registering multiple schemes
2. **Multi-Version Support** - V1 and V2 protocols side-by-side
3. **Multi-Chain Support** - EVM, SVM, and (optional) Stellar in one client
4. **Network Flexibility** - Wildcards for V2, specific networks for V1
5. **Transparent Payment** - No manual 402 handling needed

## Test Scenarios

This client is tested against:
- **Servers:** Express (TypeScript), Gin (Go)
- **Facilitators:** TypeScript, Go
- **Endpoints:** `/protected` (EVM), `/protected-svm` (SVM), `/protected-stellar` (Stellar)
- **Networks:** Base Sepolia (EVM), Solana Devnet (SVM), Stellar Testnet (Stellar)

### Success Criteria
- ✅ Request succeeds with 200 status
- ✅ Payment response header present
- ✅ Transaction hash returned
- ✅ Payment marked as successful

## Running

```bash
# Via e2e test suite
cd e2e
pnpm test --client=axios

# Direct execution (requires environment variables)
cd e2e/clients/axios
export RESOURCE_SERVER_URL="http://localhost:4022"
export ENDPOINT_PATH="/protected"
export EVM_PRIVATE_KEY="0x..."
export SVM_PRIVATE_KEY="..."
export STELLAR_PRIVATE_KEY="S..." # optional
pnpm start
```

## Environment Variables

### Required
- `RESOURCE_SERVER_URL` - Server base URL
- `ENDPOINT_PATH` - Path to protected endpoint
- `EVM_PRIVATE_KEY` - Ethereum private key (hex with 0x prefix)
- `SVM_PRIVATE_KEY` - Solana private key (base58 encoded)

### Optional
- `STELLAR_PRIVATE_KEY` - Stellar private key (S... format) - enables Stellar support

## Output Format

```json
{
  "success": true,
  "data": { "message": "Protected endpoint accessed" },
  "status_code": 200,
  "payment_response": {
    "success": true,
    "transaction": "0x...",
    "network": "eip155:84532",
    "payer": "0x..."
  }
}
```

## Package Dependencies

- `@x402/axios` - Axios wrapper with payment handling
- `@x402/core` - Core x402 client and types
- `@x402/evm` - EVM payment mechanisms (V2)
- `@x402/evm/v1` - EVM payment mechanisms (V1)
- `@x402/svm` - SVM payment mechanisms (V2)
- `@x402/svm/v1` - SVM payment mechanisms (V1)
- `@x402/stellar` - Stellar payment mechanisms (V2)
- `viem` - Ethereum library for account creation
- `@solana/kit` - Solana keypair utilities
