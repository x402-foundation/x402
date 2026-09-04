# `@x402/sui` [![npm version](https://img.shields.io/npm/v/%40x402%2Fsui.svg)](https://www.npmjs.com/package/@x402/sui)

Sui implementation of the x402 `exact` payment scheme.

## Installation

```bash
npm install @x402/sui
# or
pnpm add @x402/sui
```

## Usage

The package exports the `exact` scheme for all three x402 roles under `@x402/sui/exact/{client,server,facilitator}`. Each is registered on the matching core object for the `sui:*` network family.

### Client

```typescript
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { x402Client } from "@x402/core/client";
import { ExactSuiScheme } from "@x402/sui/exact/client";

// Any Sui signer works — Ed25519, Secp256k1, or a wallet-backed signer.
const keypair = Ed25519Keypair.generate();
const client = new x402Client().register("sui:*", new ExactSuiScheme(keypair));

// On a 402 response, `client` builds and signs the payment transaction from the
// returned PaymentRequirements — sourcing the asset and arranging gas per the
// requirements — then retries the request with the signed PaymentPayload.
```

### Server

```typescript
import { x402ResourceServer } from "@x402/core/server";
import { ExactSuiScheme } from "@x402/sui/exact/server";

const server = new x402ResourceServer({
  facilitatorUrl: "https://facilitator.example",
}).register("sui:*", new ExactSuiScheme());

// Price resources in USDC — "$0.01" or an explicit { amount, asset }. The scheme
// converts the price to atomic units in the PaymentRequirements it builds.
```

### Facilitator

```typescript
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactSuiScheme } from "@x402/sui/exact/facilitator";

// No key is needed for self-paid or gasless payments. All options are optional:
//   clients             per-network Sui client overrides (any core-API client);
//                       networks without one fall back to the public fullnode
//   executeTransaction  a custom executor settlement is delegated to (e.g. a gas
//                       sponsor); absent, the facilitator broadcasts directly
//   feePayer            a sponsor address to advertise as `extra.feePayer`
//   settlementGuard     a dedup guard (default: in-process, digest-keyed)
const facilitator = new x402Facilitator().register(
  "sui:*",
  new ExactSuiScheme({
    clients: {
      "sui:mainnet": new SuiGrpcClient({ network: "mainnet", baseUrl: "https://my-node:443" }),
    },
  }),
);
```

#### Gas sponsorship

Advertise a `feePayer` (which clients set as the gas owner) and supply an `executeTransaction` that co-signs the gas. The executor is a plain function that submits the signed bytes and returns the result; a gas sponsor is one example:

```typescript
import type { SuiExecutor } from "@x402/sui";

// e.g. wrap the mysten-incubation sponsor SDK's createSponsor(...).
const executeTransaction: SuiExecutor = ({ transaction, signatures }) =>
  sponsor.signAndExecuteTransaction({ transaction, userSignature: signatures });

new ExactSuiScheme({ feePayer: sponsorAddress, executeTransaction });
```

#### Cross-instance dedup

A horizontally-scaled facilitator should supply a shared `settlementGuard` so a payment can't be served twice across instances. It is keyed on the tx digest (with the declared nonce when present):

```typescript
import type { SettlementGuard } from "@x402/sui";

const settlementGuard: SettlementGuard = {
  // Atomic reserve, e.g. Redis SET NX; true when the digest was already present.
  async isDuplicate({ digest }) {
    return (await redis.set(`settle:${digest}`, "1", { NX: true, EX: 600 })) === null;
  },
};
```

## Features

- **Effects-only verification**: the facilitator checks that `payTo` is credited exactly `amount` from the transaction's `balanceChanges`, not how the transaction is built — so payments may be sourced from an Address Balance, coins, swaps, or withdrawals.
- **Gas sponsorship**: optional, advertised as `extra.feePayer`; settlement is delegated to a custom `executeTransaction` (e.g. a gas sponsor that co-signs under its own policy).
- **Network support**: Mainnet (`sui:mainnet`), Testnet (`sui:testnet`), and Devnet (`sui:devnet`).

## Testnet Resources

- **Test SUI**: https://faucet.sui.io/
- **Test USDC**: https://faucet.circle.com/

## License

Apache-2.0
