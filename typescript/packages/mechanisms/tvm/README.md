# @x402/tvm

TVM (TON) mechanism for the [x402 payment protocol](https://github.com/coinbase/x402).

Supports sponsored USDT payments on TON via W5R1 wallets. The client resolves its seqno and Jetton wallet through TON RPC, signs a W5R1 `internal_signed` message, and the facilitator sponsors relay gas.

## Installation

```bash
npm install @x402/tvm @x402/core
```

## Quick Start

### Client (Buyer)

```typescript
import { createTvmClient } from "@x402/tvm/exact/client";
import { toClientTvmSigner } from "@x402/tvm";
import { mnemonicToPrivateKey } from "@ton/crypto";

const keyPair = await mnemonicToPrivateKey(mnemonic.split(" "));
const signer = toClientTvmSigner(keyPair, { network: "tvm:-3" });
const client = createTvmClient({ signer, rpcUrl: "https://testnet.toncenter.com/api/v2/jsonRPC" });
```

### Server (Seller)

```typescript
import { registerExactTvmScheme } from "@x402/tvm/exact/server";

registerExactTvmScheme(server, { networks: ["tvm:-239"] });
```

### Facilitator

```typescript
import { registerExactTvmScheme } from "@x402/tvm/exact/facilitator";

registerExactTvmScheme(facilitator, {
  facilitatorUrl: "https://ton-facilitator.okhlopkov.com",
  networks: ["tvm:-239"],
});
```

## Architecture

The TON mechanism uses **self-relay**: the facilitator sponsors relay gas while the client-signed message carries the TON value needed by the Jetton transfer.

1. Client resolves seqno, account state, and Jetton wallet through TON RPC
2. Client signs a W5R1 `internal_signed` Jetton transfer
3. Merchant calls facilitator `/verify` + `/settle`
4. Facilitator relays the signed transfer on-chain, sponsoring gas

## Networks

| Network | CAIP-2 ID | Description |
|---------|-----------|-------------|
| TON Mainnet | `tvm:-239` | Production network |
| TON Testnet | `tvm:-3` | Test network |

## License

MIT
