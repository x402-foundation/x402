# Builder Code Example Client

Example client for the [builder-code server](../../servers/builder-code/). Makes a paid request and verifies that ERC-8021 builder-code attribution was appended to the settlement transaction calldata.

```typescript
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(privateKeyToAccount(process.env.EVM_PRIVATE_KEY!)));

const response = await wrapFetchWithPayment(fetch, client)("http://localhost:4021/weather");
console.log(await response.json());
```

## Prerequisites

- Node.js v20+
- pnpm v10
- Running [builder-code server](../../servers/builder-code/) and [builder-code facilitator](../../facilitator/builder-code/)
- EVM private key funded on Base Sepolia

## Setup

1. Install and build from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd clients/builder-code
```

2. Copy `.env-local` to `.env` and set `EVM_PRIVATE_KEY`.

3. Run the client:

```bash
pnpm dev
```

On success, the client prints the settlement transaction hash and the builder codes parsed from on-chain calldata (for example `a` for the service app code and `w` for the facilitator wallet code).
