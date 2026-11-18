# x402-axios

> **Deprecated (v1)**  
> This npm package implements x402 **v1**. It is **deprecated** and will only receive **security patches**. Please migrate to **v2** (`@x402/axios`, `@x402/evm`, etc.). See the [Migration guide: v1 to v2](https://docs.x402.org/guides/migration-v1-to-v2).
> Legacy examples are available at git tag `archive/legacy-v1-examples`.

A utility package that extends Axios to automatically handle 402 Payment Required responses using the x402 payment protocol. This package enables seamless integration of payment functionality into your applications when making HTTP requests with Axios.

## Installation

```bash
npm install x402-axios
```

## Quick Start

```typescript
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { withPaymentInterceptor } from "x402-axios";
import axios from "axios";
import { baseSepolia } from "viem/chains";

// Create a wallet client
const account = privateKeyToAccount("0xYourPrivateKey");
const client = createWalletClient({
  account,
  transport: http(),
  chain: baseSepolia,
});

// Create an Axios instance with payment handling
const api = withPaymentInterceptor(
  axios.create({
    baseURL: "https://api.example.com",
  }),
  client
);

// Make a request that may require payment
const response = await api.get("/paid-endpoint");
console.log(response.data);
```

## Features

- Automatic handling of 402 Payment Required responses
- Automatic retry of requests with payment headers
- Payment verification and header generation
- Exposes payment response headers

## API

### `withPaymentInterceptor(axiosClient, walletClient)`

Adds a response interceptor to an Axios instance to handle 402 Payment Required responses automatically.

#### Parameters

- `axiosClient`: The Axios instance to add the interceptor to
- `walletClient`: The wallet client used to sign payment messages (must implement the x402 wallet interface)

#### Returns

The modified Axios instance with the payment interceptor that will:
1. Intercept 402 responses
2. Parse the payment requirements
3. Create a payment header using the provided wallet client
4. Retry the original request with the payment header
5. Expose the X-PAYMENT-RESPONSE header in the final response
