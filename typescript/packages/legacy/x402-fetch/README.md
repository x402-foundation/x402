# x402-fetch

> **Deprecated (v1)**  
> This npm package implements x402 **v1**. It is **deprecated** and will only receive **security patches**. Please migrate to **v2** (`@x402/fetch`, `@x402/evm`, etc.). See the [Migration guide: v1 to v2](https://docs.x402.org/guides/migration-v1-to-v2).
> Legacy examples are available at git tag `archive/legacy-v1-examples`.

A utility package that extends the native `fetch` API to automatically handle 402 Payment Required responses using the x402 payment protocol. This package enables seamless integration of payment functionality into your applications when making HTTP requests.

## Installation

```bash
npm install x402-fetch
```

## Quick Start

```typescript
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "x402-fetch";
import { baseSepolia } from "viem/chains";

// Create a wallet client
const account = privateKeyToAccount("0xYourPrivateKey");
const client = createWalletClient({
  account,
  transport: http(),
  chain: baseSepolia,
});

// Wrap the fetch function with payment handling
const fetchWithPay = wrapFetchWithPayment(fetch, client);

// Make a request that may require payment
const response = await fetchWithPay("https://api.example.com/paid-endpoint", {
  method: "GET",
});

const data = await response.json();
```

## API

### `wrapFetchWithPayment(fetch, walletClient, maxValue?, paymentRequirementsSelector?)`

Wraps the native fetch API to handle 402 Payment Required responses automatically.

#### Parameters

- `fetch`: The fetch function to wrap (typically `globalThis.fetch`)
- `walletClient`: The wallet client used to sign payment messages (must implement the x402 wallet interface)
- `maxValue`: Optional maximum allowed payment amount in base units (defaults to 0.1 USDC)
- `paymentRequirementsSelector`: Optional function to select payment requirements from the response (defaults to `selectPaymentRequirements`)

#### Returns

A wrapped fetch function that automatically handles 402 responses by:
1. Making the initial request
2. If a 402 response is received, parsing the payment requirements
3. Verifying the payment amount is within the allowed maximum
4. Creating a payment header using the provided wallet client
5. Retrying the request with the payment header

## Example

```typescript
import { config } from "dotenv";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "x402-fetch";
import { baseSepolia } from "viem/chains";

config();

const { PRIVATE_KEY, API_URL } = process.env;

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const client = createWalletClient({
  account,
  transport: http(),
  chain: baseSepolia,
});

const fetchWithPay = wrapFetchWithPayment(fetch, client);

// Make a request to a paid API endpoint
fetchWithPay(API_URL, {
  method: "GET",
})
  .then(async response => {
    const data = await response.json();
    console.log(data);
  })
  .catch(error => {
    console.error(error);
  });
```

