# x402-fetch Example Client

This is an example client that demonstrates how to use the `x402-fetch` package to make HTTP requests to endpoints protected by the x402 payment protocol.

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- A running x402 server (you can use the example express server at `examples/typescript/servers/express`)
- A valid Ethereum private key for making payments

## Setup

1. Install and build all packages from the typescript examples root:
```bash
cd ../../
pnpm install
pnpm build
cd clients/fetch
```

2. Copy `.env-local` to `.env` and add your Ethereum private key:
```bash
cp .env-local .env
```

3. Start the example client:
```bash
pnpm dev
```

## How It Works

The example demonstrates how to:
1. Create a wallet client using viem
2. Wrap the native fetch function with x402 payment handling
3. Make a request to a paid endpoint
4. Handle the response or any errors

## Example Code

```typescript
import { config } from "dotenv";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "x402-fetch";
import { baseSepolia } from "viem/chains";

config();

const { RESOURCE_SERVER_URL, PRIVATE_KEY, ENDPOINT_PATH } = process.env;

// Create wallet client
const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const client = createWalletClient({
  account,
  transport: http(),
  chain: baseSepolia,
});

// Wrap fetch with payment handling
const fetchWithPay = wrapFetchWithPayment(fetch, client);

// Make request to paid endpoint
fetchWithPay(`${RESOURCE_SERVER_URL}${ENDPOINT_PATH}`, {
  method: "GET",
})
  .then(async response => {
    const body = await response.json();
    console.log(body);
  })
  .catch(error => {
    console.error(error.response?.data?.error);
  });
```
