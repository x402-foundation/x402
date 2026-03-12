# @x402/tvm

TVM (TON) mechanism for the [x402 payment protocol](https://github.com/coinbase/x402).

Supports gasless USDT payments on TON via TONAPI relay using W5R1 wallets.

## Installation

```bash
npm install @x402/tvm @x402/core
```

## Quick Start

### Client (Buyer)

```typescript
import { createTvmClient, toClientTvmSigner } from "@x402/tvm/exact/client";
import { mnemonicToPrivateKey } from "@ton/crypto";

const keyPair = await mnemonicToPrivateKey(mnemonic.split(" "));
const signer = toClientTvmSigner(keyPair, process.env.TONAPI_KEY);
const client = createTvmClient({ signer });
```

### Server (Seller)

```typescript
import { registerExactTvmScheme } from "@x402/tvm/exact/server";
import { x402ResourceServer } from "@x402/core/server";

const server = new x402ResourceServer(facilitatorClient);
registerExactTvmScheme(server, { networks: ["tvm:-239"] });
```

### Facilitator

```typescript
import { registerExactTvmScheme, toFacilitatorTvmSigner } from "@x402/tvm/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";

const signer = toFacilitatorTvmSigner(process.env.TONAPI_KEY);
const facilitator = new x402Facilitator();
registerExactTvmScheme(facilitator, { signer, networks: "tvm:-239" });
```

## Networks

| Network | CAIP-2 ID | Description |
|---------|-----------|-------------|
| TON Mainnet | `tvm:-239` | Production network |
| TON Testnet | `tvm:-3` | Test network |

## License

MIT
