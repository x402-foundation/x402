# @x402/fetch Example Client

Example client demonstrating how to use `@x402/fetch` to make HTTP requests to endpoints protected by the x402 payment protocol.

```typescript
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY) });
registerExactSvmScheme(client, { signer: (await createKeyPairSignerFromBytes(base58.decode(process.env.SVM_PRIVATE_KEY))) });

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const response = await fetchWithPayment("http://localhost:4021/weather");
console.log(await response.json());
```

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- A running x402 server (see [express server example](../../servers/express))
- Valid EVM and/or SVM private keys for making payments

## Setup

1. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd clients/fetch
```

2. Copy `.env-local` to `.env` and add your private keys:

```bash
cp .env-local .env
```

Required environment variables:

- `EVM_PRIVATE_KEY` - Ethereum private key for EVM payments
- `SVM_PRIVATE_KEY` - Solana private key for SVM payments

Optional environment variables:

- `EVM_RPC_URL` - JSON-RPC endpoint for on-chain reads. Enables gas sponsoring extensions (EIP-2612 and ERC-20 approval). Example: `https://sepolia.base.org`

3. Run the client:

```bash
pnpm start
```

## Next Steps

See [Advanced Examples](../advanced/) for builder pattern registration, payment lifecycle hooks, and network preferences.
