# @x402/fetch Example Client

Example client demonstrating how to use `@x402/fetch` to make HTTP requests to endpoints protected by the x402 payment protocol.

```typescript
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { AuthCaptureEvmScheme } from "@x402/evm/auth-capture/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

const client = new x402Client()
  .register("eip155:*", new ExactEvmScheme(privateKeyToAccount(process.env.EVM_PRIVATE_KEY)))
  .register("eip155:*", new UptoEvmScheme(privateKeyToAccount(process.env.EVM_PRIVATE_KEY)))
  .register("eip155:*", new AuthCaptureEvmScheme(privateKeyToAccount(process.env.EVM_PRIVATE_KEY)))
  .register("solana:*", new ExactSvmScheme(await createKeyPairSignerFromBytes(base58.decode(process.env.SVM_PRIVATE_KEY))))
  .setSpendControls({
    maxAmountPerPayment: "$1",
  });

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const response = await fetchWithPayment("http://localhost:4021/weather");
console.log(await response.json());
```

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- A running x402 server (see [express server example](../../servers/express) or [auth-capture server example](../../servers/auth-capture))
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
- `EXPECTED_AMOUNT_ATOMIC` - the most this client will pay for the resource, in the selected asset's atomic units (`10000` is $0.01 USDC). It is a maximum, not an exact price: a 402 that asks for more is refused before anything is signed, and a lower price signs. An amount that is not a whole number of atomic units is refused. Atomic units depend on the asset, so pin the asset and network with it when the server offers more than one.
- `EXPECTED_NETWORK` - the CAIP-2 network you expect to pay on, e.g. `eip155:8453`. Required with either of the two below, because the same address text can name a different account or token on another network.
- `EXPECTED_PAY_TO`, `EXPECTED_ASSET` - refuse to sign for any other recipient or asset. Addresses are compared by the network's rules: on EVM networks letter case is only a checksum and is ignored; Solana addresses are Base58, where case changes the value, so their decoded bytes are compared. On any other network a pinned recipient or asset never matches, so the payment is refused.

The spend cap (`maxAmountPerPayment`) is a ceiling, not a price check: a server that asks ten times the usual price of a cheap resource stays under $1 and gets paid. The `onBeforePaymentCreation` hook in `index.ts` enforces the expectation; the check itself is in `expectation.ts`, with tests in `expectation.test.ts` (`pnpm test`).

3. Run the client:

```bash
pnpm start
```

## Next Steps

See [Advanced Examples](../advanced/) for builder pattern registration, payment lifecycle hooks, network preferences, and spend controls.
