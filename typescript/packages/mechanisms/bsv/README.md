# @x402/bsv

BSV (Bitcoin SV) blockchain implementation of the x402 payment protocol using the **Exact** payment scheme with **BRC-29 / BRC-121 native satoshi payments**.

## Installation

```bash
npm install @x402/bsv
```

## Overview

This package provides three components for handling x402 payments on BSV:

- **Client** — Derives a per-payment key from the recipient's identity key (BRC-42/BRC-29) and asks the client's BRC-100 wallet to create a fully-signed, fully-funded transaction paying it (BEEF format, SPV ancestry included)
- **Facilitator** — Wraps the _recipient's_ BRC-100 wallet: verifies payload structure, freshness, and exact amount, then settles by internalizing the payment output into the wallet (`internalizeAction`), which SPV-validates, takes custody, and rejects replays
- **Server** — Builds `PaymentRequirements` with satoshi price parsing (no silent fiat conversion — register a money parser for USD prices)

## Payment Flow (BRC-121 adapted to x402)

Unlike account-based chains, a BSV payment output is locked to a key that by default only the payer and the recipient can link to the recipient's identity key (BRC-42 ECDH derivation). A third party cannot take custody, and cannot verify the destination unilaterally, so the facilitator role is fulfilled by the recipient's own wallet — run in-process by the resource server or self-hosted as a facilitator service. (Either counterparty _can_ voluntarily prove a specific payment's linkage via BRC-100 `revealSpecificKeyLinkage` — BRC-69, verifiable per BRC-94's Schnorr ZKP — a path toward third-party verification and regulated-asset extensions; not required by this scheme.)

1. Server advertises `payTo` = the recipient wallet's identity public key (never appears on chain)
2. Client generates a fresh derivation prefix (nonce) and a timestamp suffix, derives the recipient's per-payment key, and creates the payment via `createAction` — the client pays the miner fee
3. Client sends `{ transaction (base64 BEEF), derivationPrefix, derivationSuffix, senderIdentityKey, outputIndex }`
4. Facilitator verifies structure, wallet-chain agreement, ±30 s freshness, **exact** amount, and that the P2PKH output pays the BRC-42-derived key for this payment
5. Settlement internalizes the output into the recipient wallet; replays are rejected via a facilitator txid dedup cache plus the wallet's merge signal (`isMerge` without newly internalized satoshis)
6. The wallet handles network propagation (e.g. via ARC)

## Supported Assets

| Type   | Symbol | Description     | Decimals |
| ------ | ------ | --------------- | -------- |
| Native | BSV    | Native satoshis | 8        |

Amounts are denominated in satoshis. There is no default USD conversion; use an explicit `{ amount: "<satoshis>", asset: "BSV" }` price, or register the bundled WhatsOnChain rate-feed parser (below) to accept dollar prices.

## Networks

| Network                         | Identifier    |
| ------------------------------- | ------------- |
| Mainnet                         | `bsv:mainnet` |
| Testnet                         | `bsv:testnet` |
| Teranode Test Net (Teratestnet) | `bsv:ttn`     |
| Teranode Scaling Test Net       | `bsv:tstn`    |
| Wildcard                        | `bsv:*`       |

Network identifiers follow the registered ChainAgnostic [`bsv` namespace](https://github.com/ChainAgnostic/namespaces/blob/main/bsv/caip2.md). `bip122` genesis references are ambiguous for BSV (shared genesis with BTC/BCH); this package refuses them rather than defaulting to BSV.

## Usage

### 1. Client Setup

The paying side needs a running BRC-100 wallet — `WalletClient` connects to the user's wallet (e.g. BSV Desktop).

```typescript
import { ExactBsvScheme } from "@x402/bsv/exact/client";
import { WalletClient } from "@bsv/sdk";
import { x402Client } from "@x402/core/client";

const client = new x402Client();
client.register("bsv:*", new ExactBsvScheme(new WalletClient()));
```

### 2. Server Setup

```typescript
import { ExactBsvScheme } from "@x402/bsv/exact/server";
import { x402ResourceServer } from "@x402/core/server";

server.register("bsv:*", new ExactBsvScheme());

// Route config — payTo is the recipient wallet's identity public key
const accepts = [
  {
    scheme: "exact",
    network: "bsv:mainnet",
    price: { amount: "1000", asset: "BSV" }, // 1000 satoshis
    payTo: process.env.BSV_IDENTITY_KEY!,
  },
];
```

#### USD prices via the WhatsOnChain rate feed

Register the bundled money parser to accept `price: "$0.001"` like other chains. Rates come from the WhatsOnChain exchange-rate API (cached 60 s, bounded stale fallback on outages); the satoshi amount is pinned when the 402 challenge is issued.

```typescript
import { createWhatsOnChainMoneyParser } from "@x402/bsv";

const serverScheme = new ExactBsvScheme().registerMoneyParser(createWhatsOnChainMoneyParser());
server.register("bsv:*", serverScheme);

// Now dollar prices work:
const accepts = [{ scheme: "exact", network: "bsv:mainnet", price: "$0.001", payTo: identityKey }];
```

### 3. Facilitator Setup

The facilitator holds the wallet that RECEIVES payments — settlement takes custody into it. Server deployments use a key-based wallet such as `ServerWallet` from [`@bsv/simple`](https://www.npmjs.com/package/@bsv/simple) (any BRC-100 `WalletInterface` works):

```typescript
import { ExactBsvScheme } from "@x402/bsv/exact/facilitator";
import { ServerWallet } from "@bsv/simple/server";
import { x402Facilitator } from "@x402/core/facilitator";

const wallet = await ServerWallet.create({
  privateKey: process.env.SERVER_PRIVATE_KEY!,
  network: "main",
  storageUrl: process.env.WALLET_STORAGE_URL ?? "https://store-us-1.bsvb.tech",
});

const scheme = await ExactBsvScheme.create({ wallet: wallet.getClient() });

// Register ONLY the network the wallet operates on. A scheme instance wraps a
// single wallet, and `verify`/`settle` reject any network that doesn't match
// the wallet's own `getNetwork()` (`invalid_network`). For multiple networks
// (mainnet / testnet / ttn / tstn), build a separate wallet + scheme per network.
const facilitator = new x402Facilitator();
facilitator.register("bsv:mainnet", scheme);
```

## Security Notes

- `payTo` **must** equal the facilitator wallet's identity key — the facilitator rejects payments it cannot take custody of (`invalid_exact_bsv_payload_payee_mismatch`)
- The payment output must carry **exactly** `requirements.amount` satoshis (stricter than plain BRC-121, which accepts overpayment) and must pay the BRC-42-derived key — verified via the wallet's own `forSelf` derivation before any resource work
- Freshness window: the timestamp encoded in `derivationSuffix` must be within ±30 s at verify time (configurable via `paymentWindowMs`); at settle time the window extends by `maxTimeoutSeconds`, the advertised settlement budget
- Replay protection: a facilitator-side txid dedup cache plus the wallet's merge signal (`isMerge` without newly internalized satoshis — both wallet-toolbox extensions to BRC-100); verification re-runs at settlement
- The subject transaction is resolved via the Atomic BEEF `atomicTxid`, matching what the wallet internalizes; SPV validity is enforced by the wallet during `internalizeAction` — settlement is the authoritative acceptance step

## References

- [BRC-121: Simple 402 Payments](https://bsv.brc.dev/payments/0121)
- [BRC-29: Simple Authenticated BSV P2PKH Payment Protocol](https://bsv.brc.dev/payments/0029)
- [BRC-42: BSV Key Derivation Scheme](https://bsv.brc.dev/key-derivation/0042)
- [BRC-62: BEEF](https://bsv.brc.dev/transactions/0062) / [BRC-95: Atomic BEEF](https://bsv.brc.dev/transactions/0095)
- [BRC-69: Revealing Key Linkages](https://bsv.brc.dev/key-derivation/0069) / [BRC-94: Verifiable Shared-Secret Revelation (Schnorr)](https://bsv.brc.dev/key-derivation/0094)
- [BRC-100: Wallet-to-Application Interface](https://bsv.brc.dev/wallet/0100)
- Spec: `specs/schemes/exact/scheme_exact_bsv.md`
