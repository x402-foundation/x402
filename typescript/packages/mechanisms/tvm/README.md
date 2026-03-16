# @x402/tvm

TVM (TON) mechanism for the [x402 payment protocol](https://github.com/coinbase/x402).

Supports gasless USDT payments on TON via self-relay gas sponsorship using W5R1 wallets. The client makes **zero blockchain calls** — all on-chain interaction is handled by the facilitator service.

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
const signer = toClientTvmSigner(keyPair);
const client = createTvmClient({ signer });
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

The TON mechanism uses **self-relay**: the facilitator sponsors gas so clients never need TON.

1. Client calls facilitator `/prepare` → gets seqno + messages to sign
2. Client signs W5R1 `internal_signed` transfer (zero blockchain calls)
3. Merchant calls facilitator `/verify` + `/settle`
4. Facilitator relays the signed transfer on-chain, sponsoring gas

## Networks

| Network | CAIP-2 ID | Description |
|---------|-----------|-------------|
| TON Mainnet | `tvm:-239` | Production network |
| TON Testnet | `tvm:-3` | Test network |

## License

MIT
