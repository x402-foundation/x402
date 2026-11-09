# @x402/tvm

TVM (TON) mechanism for the [x402 payment protocol](https://github.com/x402-foundation/x402).

Supports sponsored TEP-74 Jetton payments on TON. Clients sign W5R1
`internal_signed` messages, and the native facilitator relays them through a
Highload V3 wallet while sponsoring TON gas.

## Installation

```bash
npm install @x402/tvm @x402/core
```

## Client

```typescript
import { x402Client } from "@x402/core/client";
import { ExactTvmScheme } from "@x402/tvm/exact/client";
import { toClientTvmSigner, TVM_PROVIDER_TONAPI } from "@x402/tvm";
import { mnemonicToPrivateKey } from "@ton/crypto";

const keyPair = await mnemonicToPrivateKey(mnemonic.split(" "));
const signer = toClientTvmSigner(keyPair, {
  network: "tvm:-3",
  apiKey: process.env.TONCENTER_API_KEY,
});

// Optional: use TonAPI instead of Toncenter.
// const signer = toClientTvmSigner(keyPair, {
//   network: "tvm:-3",
//   provider: TVM_PROVIDER_TONAPI,
//   apiKey: process.env.TONAPI_API_KEY,
//   providerBaseUrl: process.env.TONAPI_BASE_URL,
// });

const client = new x402Client().register("tvm:*", new ExactTvmScheme(signer));
```

## Server

```typescript
import { x402ResourceServer } from "@x402/core/server";
import { ExactTvmScheme } from "@x402/tvm/exact/server";

const server = new x402ResourceServer(facilitatorClient).register(
  "tvm:*",
  new ExactTvmScheme(),
);
```

## Facilitator

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactTvmScheme } from "@x402/tvm/exact/facilitator";
import { HighloadV3Config, toFacilitatorTvmSigner } from "@x402/tvm";

const signer = toFacilitatorTvmSigner({
  "tvm:-3": HighloadV3Config.fromPrivateKey(process.env.TVM_PRIVATE_KEY!, {
    provider: "toncenter",
    apiKey: process.env.TONCENTER_API_KEY,
  }),
});

const facilitator = new x402Facilitator().register(
  "tvm:-3",
  new ExactTvmScheme(signer),
);
```

Call `scheme.close()` when you are done with a long-lived client scheme so its
cached provider clients are released.

## Provider Selection

Toncenter is the default provider. Set `provider: TVM_PROVIDER_TONAPI` on the
client signer or `HighloadV3Config` to switch REST calls to TonAPI.

- Toncenter REST defaults: `https://toncenter.com`, `https://testnet.toncenter.com`
- TonAPI REST defaults: `https://tonapi.io`, `https://testnet.tonapi.io`

`apiKey` is sent as `X-Api-Key` for Toncenter and `Authorization: Bearer <key>`
for TonAPI. For custom deployments, set `providerBaseUrl`,
`providerTimeoutSeconds`, and `providerEmulationTimeoutSeconds`.

## Architecture

The TON mechanism follows the `exact` TON spec:

1. The client resolves its W5R1 seqno and source Jetton wallet through TON RPC.
2. The client signs one W5R1 `internal_signed` Jetton transfer.
3. The facilitator verifies the BoC locally, including signature, wallet state,
   Jetton wallet ownership, amount, asset, recipient, timeout, seqno, and trace
   emulation.
4. Settlement re-runs verification, deduplicates the BoC hash, batches relay
   requests, broadcasts a Highload V3 external message, and verifies the
   finalized trace.

## Networks

| Network | CAIP-2 ID | Description |
|---------|-----------|-------------|
| TON Mainnet | `tvm:-239` | Production network |
| TON Testnet | `tvm:-3` | Test network |

## Testnet Funding

To fund a TVM payer wallet, request testnet TON from
[@testgiver_ton_bot](https://t.me/testgiver_ton_bot) for fees. Then open the
[testnet USDT transfer link](https://app.tonkeeper.com/transfer/kQDNUDJC0iQvJoZp0ml-YteL1NtTXKphU03CTI5v4VtBhGYs?amount=49000000&bin=te6cckEBAQEAFgAAKClXdJkAAAAAAAAAAAAAAAAAmJaAhDUekg)
to obtain testnet USDT.

The facilitator wallet also needs testnet TON and must hold at least 1.1 TON
before running tests. The facilitator uses a Highload V3 wallet, so fund the
Highload V3 address, not the W5 address derived from the same key.
