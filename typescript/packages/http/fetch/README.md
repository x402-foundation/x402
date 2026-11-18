# `@x402/fetch` [![npm version](https://img.shields.io/npm/v/%40x402%2Ffetch.svg)](https://www.npmjs.com/package/@x402/fetch)

A utility package that extends the native `fetch` API to automatically handle 402 Payment Required responses using the x402 payment protocol v2. This package enables seamless integration of payment functionality into your applications when making HTTP requests.

## Installation

```bash
pnpm install @x402/fetch
```

## Quick Start

```typescript
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

// Create an account
const account = privateKeyToAccount("0xYourPrivateKey");

// Wrap the fetch function with payment handling
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network: "eip155:8453", // Base Mainnet
      client: new ExactEvmScheme(account),
    },
  ],
});

// Make a request that may require payment
const response = await fetchWithPayment("https://api.example.com/paid-endpoint", {
  method: "GET",
});

const data = await response.json();
```

## API

### `wrapFetchWithPayment(fetch, client)`

Wraps the native fetch API to handle 402 Payment Required responses automatically.

#### Parameters

- `fetch`: The fetch function to wrap (typically `globalThis.fetch`)
- `client`: An x402Client instance with registered payment schemes

### `wrapFetchWithPaymentFromConfig(fetch, config)`

Convenience wrapper that creates an x402Client from a configuration object.

#### Parameters

- `fetch`: The fetch function to wrap (typically `globalThis.fetch`)
- `config`: Configuration object with the following properties:
  - `schemes`: Array of scheme registrations, each containing:
    - `network`: Network identifier (e.g., 'eip155:8453', 'solana:mainnet', 'eip155:*' for wildcards)
    - `client`: The scheme client implementation (e.g., `ExactEvmScheme`, `ExactSvmScheme`)
    - `x402Version`: Optional protocol version (defaults to 2, set to 1 for legacy support)
  - `paymentRequirementsSelector`: Optional function to select payment requirements from multiple options

#### Returns

A wrapped fetch function that automatically handles 402 responses by:
1. Making the initial request
2. If a 402 response is received, parsing the payment requirements
3. Creating a payment header using the configured scheme client
4. Retrying the request with the payment header

## Examples

### Basic Usage with EVM

```typescript
import { config } from "dotenv";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { ExactEvmScheme } from "@x402/evm";

config();

const { EVM_PRIVATE_KEY, API_URL } = process.env;

const account = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network: "eip155:*", // Support all EVM chains
      client: new ExactEvmScheme(account),
    },
  ],
});

// Make a request to a paid API endpoint
fetchWithPayment(API_URL, {
  method: "GET",
})
  .then(async response => {
    const data = await response.json();
    
    // Optionally decode the payment response header
    const paymentResponse = response.headers.get("PAYMENT-RESPONSE");
    if (paymentResponse) {
      const decoded = decodePaymentResponseHeader(paymentResponse);
      console.log("Payment details:", decoded);
    }
    
    console.log("Response data:", data);
  })
  .catch(error => {
    console.error(error);
  });
```

### Using Builder Pattern

For more control, you can use the builder pattern to register multiple schemes:

```typescript
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

// Create signers
const evmSigner = privateKeyToAccount("0xYourPrivateKey");
const svmSigner = await createKeyPairSignerFromBytes(base58.decode("YourSvmPrivateKey"));

// Build client with multiple schemes
const client = new x402Client()
  .register("eip155:*", new ExactEvmScheme(evmSigner))
  .register("solana:*", new ExactSvmScheme(svmSigner));

// Wrap fetch with the client
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
```

### Multi-Chain Support

```typescript
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { ExactSvmScheme } from "@x402/svm";

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    // EVM chains
    {
      network: "eip155:8453", // Base Sepolia
      client: new ExactEvmScheme(evmAccount),
    },
    // SVM chains
    {
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", // Solana devnet
      client: new ExactSvmScheme(svmSigner),
    },
  ],
});
```

### Custom Payment Requirements Selector

```typescript
import { wrapFetchWithPaymentFromConfig, type SelectPaymentRequirements } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";

// Custom selector that prefers the cheapest option
const selectCheapestOption: SelectPaymentRequirements = (version, accepts) => {
  if (!accepts || accepts.length === 0) {
    throw new Error("No payment options available");
  }
  
  // Sort by value and return the cheapest
  const sorted = [...accepts].sort((a, b) => 
    BigInt(a.value) - BigInt(b.value)
  );
  
  return sorted[0];
};

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network: "eip155:8453",
      client: new ExactEvmScheme(account),
    },
  ],
  paymentRequirementsSelector: selectCheapestOption,
});
```

