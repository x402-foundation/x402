# @x402/hedera

Hedera implementation of the x402 `exact` payment scheme (v2).

## Installation

```bash
pnpm add @x402/hedera
```

## Features

- x402 v2 exact scheme support for Hedera (`hedera:mainnet`, `hedera:testnet`)
- HBAR (`asset: 0.0.0`) and HTS fungible token payment validation
- Facilitator fee payer model via `paymentRequirements.extra.feePayer`
- Configurable alias handling policy (`allow` or `reject`, default `reject`)
- Server-side money parser chain with configured HTS fallback conversion

## Usage

### Client

```ts
import { x402Client } from "@x402/core/client";
import { createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { PrivateKey } from "@hiero-ledger/sdk";

const signer = createClientHederaSigner(
  "0.0.1111",
  PrivateKey.fromString(process.env.HEDERA_PRIVATE_KEY!),
  {
    network: "hedera:testnet",
  },
);

const client = new x402Client().register("hedera:*", new ExactHederaScheme(signer));
```

### Server

```ts
import { x402ResourceServer } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

const server = new x402ResourceServer(facilitatorClient);
server.register(
  "hedera:*",
  new ExactHederaScheme({
    defaultAssets: {
      "hedera:testnet": { asset: "0.0.6001", decimals: 6 },
      "hedera:mainnet": { asset: "0.0.9001", decimals: 6 },
    },
  }),
);
```

### Facilitator

```ts
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactHederaScheme } from "@x402/hedera/exact/facilitator";

const facilitatorSigner = {
  getAddresses: () => ["0.0.5001"],
  signAndSubmitTransaction: async () => ({ transactionId: "0.0.5001@1700000000.000000000" }),
};

const facilitator = new x402Facilitator().register(
  "hedera:*",
  new ExactHederaScheme(facilitatorSigner, { aliasPolicy: "reject" }),
);
```

## Amount Units

- HBAR (`asset: "0.0.0"`): amount is in tinybars (1 HBAR = 10^8 tinybars).
- HTS fungible token: amount is in token smallest units according to token decimals.

## Alias Policy

- `reject` (default): facilitator may reject `payTo` values that resolve as aliases/non-existing accounts.
- `allow`: facilitator allows alias destinations.

Implementations should document and monitor this policy because alias-based auto-account creation may introduce additional cost.

## Hedera SDK primitives

This package re-exports a curated subset of `@hiero-ledger/sdk` primitives
(`AccountBalanceQuery`, `AccountId`, `AccountInfoQuery`, `Client`, `Hbar`,
`PrivateKey`, `TokenAssociateTransaction`, `TokenId`, `Transaction`,
`TransactionId`, `TransferTransaction`) so that a consuming application
always resolves a single SDK instance through `@x402/hedera`, even when it
lives in a sibling workspace from the one where `@x402/hedera` itself was
installed. Importing `@hiero-ledger/sdk` directly alongside `@x402/hedera`
in such setups yields duplicate on-disk installs — the SDK's internal
string-brand / `instanceof` checks then throw `t.startsWith is not a
function` at runtime.

The re-exports are pinned to the `@hiero-ledger/sdk` version declared in
this package's `dependencies`. Consuming the re-exported symbols couples
your application to that version until `@x402/hedera` bumps its pin; a
major SDK bump is treated as a breaking change in this package.

## Testnet Faucet

To run on `hedera:testnet` you need funded client and facilitator accounts plus
testnet HBAR for fees.

- **Hedera Portal (faucet + account creation):** https://portal.hedera.com/
  - Sign up, create a testnet account, and claim testnet HBAR.
  - The portal also exposes your account id and ECDSA/ED25519 keys to plug into
    `HEDERA_CLIENT_PRIVATE_KEY` / `HEDERA_FACILITATOR_PRIVATE_KEY`.
- **Circle USDC testnet faucet:** https://faucet.circle.com/ — select
  "Hedera Testnet" to mint test USDC (`0.0.429274`) to an already-associated
  account.

## Token Association

Hedera requires every HTS token to be explicitly associated with each account
before the account can receive it. Both the payer and the recipient must be
associated with the token used by the payment before settlement, otherwise the
transfer fails on chain with `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`.

The Hedera portal does not expose token association, so use the Hiero SDK
directly:

```ts
import { AccountId, Client, PrivateKey, TokenAssociateTransaction, TokenId } from "@x402/hedera";

const client = Client.forTestnet().setOperator(
  AccountId.fromString(accountId),
  PrivateKey.fromStringECDSA(privateKey),
);
await new TokenAssociateTransaction()
  .setAccountId(AccountId.fromString(accountId))
  .setTokenIds([TokenId.fromString("0.0.429274")]) // testnet USDC
  .execute(client)
  .then(response => response.getReceipt(client));
client.close();
```

Alternatively, configure `maxAutomaticTokenAssociations` on the recipient
account (see the Hiero SDK `AccountUpdateTransaction`) to opt into automatic
associations for future HTS tokens.

## Live Integration Testing

The integration suite supports an env-gated live Hedera test in
`test/integrations/exact-hedera.test.ts`.

- Create or update `typescript/packages/mechanisms/hedera/.env.test`.
- This live suite currently assumes **ECDSA** private keys for both client and facilitator.
- Use `0x`-prefixed ECDSA key strings in:
  - `HEDERA_CLIENT_PRIVATE_KEY`
  - `HEDERA_FACILITATOR_PRIVATE_KEY`
- Fund all accounts from the testnet faucet above before running.

Run:

```bash
pnpm test:integration
```
