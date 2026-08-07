# `@x402/sui` [![npm version](https://img.shields.io/npm/v/%40x402%2Fsui.svg)](https://www.npmjs.com/package/@x402/sui)

Sui implementation of the x402 payment protocol — **zero-gas USDC payments**: no gas token, no sponsor, no interactive gas-station round trip, no coin-object storage cost.

Implements [`scheme_exact_sui.md`](../../../../specs/schemes/exact/scheme_exact_sui.md), including the spec's stated follow-up: payments ride Sui's **Address Balances** gasless stablecoin transfers (protocol v125) — transactions with `gasPayment: []`, `gasPrice: 0`, composed exclusively of protocol-allowlisted stablecoin operations.

## Installation

```bash
npm install @x402/sui
# or
pnpm add @x402/sui
```

## Networks

| CAIP-2 | Default USDC | Decimals |
| --- | --- | --- |
| `sui:mainnet` | `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC` | 6 |
| `sui:testnet` | `0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC` | 6 |
| `sui:devnet` | none (pass an explicit `AssetAmount` price) | — |

## Usage

### Client

```typescript
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { ExactSuiScheme } from "@x402/sui/exact/client";
import { toClientSuiSigner } from "@x402/sui";

const keypair = Ed25519Keypair.fromSecretKey("suiprivkey1...");
const client = new SuiGrpcClient({
  network: "testnet",
  baseUrl: "https://fullnode.testnet.sui.io:443",
});
const signer = toClientSuiSigner(keypair, client);

x402Client.register("sui:testnet", new ExactSuiScheme(signer));
```

`toClientSuiSigner` accepts any `Signer` from `@mysten/sui/cryptography` — the abstract class is the contract, not `Ed25519Keypair`. `Secp256k1Keypair`, wallet adapters, and remote-custody signers such as [`@mysten/aws-kms-signer`](https://www.npmjs.com/package/@mysten/aws-kms-signer) drop in unchanged: the private key never has to enter process memory.

### Server

```typescript
import { x402ResourceServer } from "@x402/core/server";
import { ExactSuiScheme } from "@x402/sui/exact/server";

const server = new x402ResourceServer(facilitatorClient);
server.register("sui:testnet", new ExactSuiScheme());

// parsePrice converts "$0.05" / 0.05 / { amount, asset } to atomic USDC.
```

### Facilitator

```typescript
import { ExactSuiScheme } from "@x402/sui/exact/facilitator";
import { toFacilitatorSuiSigner } from "@x402/sui";

// Gasless is keyless — no sponsor key needed; the facilitator relays the
// payer's already-signed bytes and verifies on-chain effects.
const signer = toFacilitatorSuiSigner();
facilitator.register("sui:testnet", new ExactSuiScheme(signer));
```

## Gasless construction

The client builds one `0x2::balance::send_funds<USDC>` per recipient, drawn from the payer's Address Balance, and forces the gasless election (`gasBudget(0n)`). The facilitator's verify asserts `gasPrice == 0` ∧ `gasPayment == []` and that every command is an allowlisted gasless operation — the four functions that exist on-chain (`balance::send_funds` / `balance::redeem_funds`, `coin::send_funds` / `coin::into_balance`) plus the native `SplitCoins` / `MergeCoins` a coin-object source needs (see below). `TransferObjects` and every other command stay rejected; the exact-fee balance-change check binds the actual money movement, so there is no facilitator gas to drain and no hidden recipient is possible. Below an enforcing network's `0.01` minimum, fall back to the classic `Coin<T>` path.

When the payer's USDC is a classic `Coin<T>` OBJECT rather than an Address Balance (the common case after a normal coin transfer), the SDK's `tx.balance({ type, balance })` intent resolves to `[SplitCoins, coin::into_balance, balance::send_funds, coin::send_funds]` — still gasless. The allowlist tolerates `SplitCoins` / `MergeCoins` for exactly this coin-plumbing; nothing else.

## Declared outputs

`PaymentRequirements.extra.outputs` (OPTIONAL) declares a multi-recipient split summing to `amount`. Verification anchors on the EXACT payer debit: every declared recipient is credited exactly its amount, the payer is debited exactly `amount`, and no undeclared recipient of the asset is allowed. Absent, verification is the unchanged single-`payTo` rule.

## Asset transfer methods

The Sui spec defines two `extra.assetTransferMethod` values: `address-balance` (the gasless Address-Balance path) and `coin` (the classic gas-paying path, optionally gas-station sponsored). This package implements `address-balance` end to end — the client builds gasless PTBs and the facilitator verifies the gasless shape and settles keylessly — and the facilitator announces the method in its `/supported` extras, so a resource server relays it into `PaymentRequirements.extra` and the payload echoes it. A declared or echoed `coin` method is rejected as unsupported; independently of any declaration, the facilitator derives the effective method from the decoded bytes (`gasPayment == []`), so a mislabeled payment cannot slip through.

## License

Apache-2.0
