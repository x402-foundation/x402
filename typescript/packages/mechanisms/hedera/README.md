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
- Two asset transfer methods: `cryptoTransfer` (default, the payer signs a
  `TransferTransaction`) and [`transferExecutor`](#transferexecutor) (an
  admitted executor contract moves funds a contract controls)

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
import {
  AccountId,
  Client,
  PrivateKey,
  createHederaPreflightTransfer,
  createHederaSignAndSubmitTransaction,
  createHederaVerifyPayerSignature,
  type FacilitatorHederaSigner,
} from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/facilitator";

const feePayer = "0.0.5001";
const feePayerKey = PrivateKey.fromStringECDSA(process.env.HEDERA_FACILITATOR_PRIVATE_KEY!);
const buildClient = (network: string) =>
  (network === "hedera:mainnet" ? Client.forMainnet() : Client.forTestnet()).setOperator(
    AccountId.fromString(feePayer),
    feePayerKey,
  );

const facilitatorSigner: FacilitatorHederaSigner = {
  getAddresses: () => [feePayer],
  signAndSubmitTransaction: createHederaSignAndSubmitTransaction(buildClient, feePayerKey),
  verifyPayerSignature: createHederaVerifyPayerSignature(),
  preflightTransfer: createHederaPreflightTransfer(),
};

const facilitator = new x402Facilitator().register(
  ["hedera:testnet", "hedera:mainnet"],
  new ExactHederaScheme(facilitatorSigner, { aliasPolicy: "reject" }),
);
```

Register concrete networks rather than `"hedera:*"`: a resource server matches
the facilitator's `/supported` kinds by exact network.

## Amount Units

- HBAR (`asset: "0.0.0"`): amount is in tinybars (1 HBAR = 10^8 tinybars).
- HTS fungible token: amount is in token smallest units according to token decimals.

## Alias Policy

- `reject` (default): facilitator may reject `payTo` values that resolve as aliases/non-existing accounts.
- `allow`: facilitator allows alias destinations.

Implementations should document and monitor this policy because alias-based auto-account creation may introduce additional cost.

## transferExecutor

`transferExecutor` lets a payer whose funds a smart contract controls pay an
`exact` quote: smart accounts, vaults and multisigs, or accounts that granted a
contract a HIP-336 allowance. The client names an executor contract and hands
over an opaque `authorization`. The facilitator builds the
`executeTransfer(from, asset, to, amount, authorization)` call from the payment
requirements, simulates it, submits it as a `ContractExecuteTransaction` it pays
for, and judges the outcome from the consensus record.

A quote selects it with `extra.assetTransferMethod: "transferExecutor"`. Quotes
without the field, or with `"cryptoTransfer"`, pay with `cryptoTransfer`
exactly as before. The normative rules are in the
[exact Hedera scheme spec](../../../../specs/schemes/exact/scheme_exact_hedera.md)
("AssetTransferMethod: `transferExecutor`").

### Prerequisites

- An executor implementing `ITransferExecutor`
  (`executeTransfer(address,address,address,uint256,bytes)`, selector
  `0xea8f19fd`) deployed on the network. No executor is canonical, and this
  package names none. The spec's
  ["Annex: Reference executors"](../../../../specs/schemes/exact/scheme_exact_hedera.md#annex-reference-executors)
  lists known ones. The `0.0.7000` below is a placeholder.
- A funding path: either the payer is the executor's own account and holds the
  funds, or the payer has granted the executor a HIP-336 allowance for the asset
  covering the amount.
- For HTS assets, `asset` is a fungible token on the network and `payTo` is
  associated with it (see [Token Association](#token-association)). Tokens with
  custom fees are rejected.
- The payer and `payTo` resolve to EVM addresses on the mirror node. Where an
  account has an alias, the facilitator uses the alias address.
- `amount` is at most 9,007,199,254,740,991 base units
  (`Number.MAX_SAFE_INTEGER`). The mirror node reports transfers as JSON
  numbers, which can't hold a larger amount exactly, so the settlement record
  could never be matched. The facilitator rejects such a quote with
  `invalid_payment_requirements` before submitting anything.

### Client

Implement the optional `createTransferExecutorAuthorization` hook on your
`ClientHederaSigner`. The package never builds authorizations: their format
belongs to each executor.

```ts
import { x402Client } from "@x402/core/client";
import type { ClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

const signer: ClientHederaSigner = {
  accountId: "0.0.4242", // the account the executor debits, e.g. the vault
  createPartiallySignedTransferTransaction: async () => {
    throw new Error("this payer pays with transferExecutor only");
  },
  createTransferExecutorAuthorization: async requirements => ({
    executor: "0.0.7000", // one of requirements.extra.executors
    authorization: await myExecutor.authorize(requirements), // 0x-hex the executor validates
  }),
};

const client = new x402Client().register("hedera:testnet", new ExactHederaScheme(signer));
```

- `accountId` becomes `payload.payer`. Set it to the account the executor
  debits (the vault or smart account), not to the key that signs the
  authorization. It must be a `0.0.x` account id: the client throws, before
  calling the hook, otherwise.
- Where the authorization embeds an expiry, bound it by
  `requirements.maxTimeoutSeconds`.
- Make one single-use authorization per payment. The executor consumes it on
  success.
- `executor` must be a `0.0.x` contract id listed in `extra.executors` (a `"*"`
  entry allows any), and `authorization` must be `0x`-prefixed hex. The client
  throws before sending anything otherwise. It also throws when the hook returns
  something other than an object, when the quote's `extra.executors` is missing
  or empty, when the signer lacks the hook, or when `extra.assetTransferMethod`
  is not a value this package defines. A `null` method counts as absent and pays
  with `cryptoTransfer`.
- `createPartiallySignedTransferTransaction` is still part of
  `ClientHederaSigner`. A signer that only pays with `transferExecutor` can
  implement it by throwing: it is only called for `cryptoTransfer` quotes.
- `extra.feePayer` is not used: the client builds no Hedera transaction.
- Core's client pays the first entry it supports, so a signer without the hook
  throws when that entry is a `transferExecutor` one. To pay such quotes with
  `cryptoTransfer`, drop those entries with a policy:
  `client.registerPolicy((_, accepts) => accepts.filter(r => r.extra?.assetTransferMethod !== "transferExecutor"))`.

### Resource server

Quote `transferExecutor` on a route through `extra`:

```ts
const routes = {
  "GET /premium": {
    accepts: {
      scheme: "exact",
      network: "hedera:testnet",
      payTo: "0.0.7001",
      price: { amount: "10000", asset: "0.0.429274" },
      extra: {
        assetTransferMethod: "transferExecutor",
        executors: ["0.0.7000"], // optional: narrow the facilitator's list
        // paymentFlow: "upfront", // optional: settle before the handler runs
      },
    },
  },
};
```

- Quote each method in its own `accepts[]` entry. A client pays the method the
  entry names, and the facilitator requires `accepted` to name the same one, so
  a `cryptoTransfer` client cannot pay a `transferExecutor` entry.
- When you offer both methods, list the `cryptoTransfer` entry first. Core's
  client takes the first entry it supports and does not skip one its signer
  can't pay, so a client without the `transferExecutor` hook throws on a
  `transferExecutor` entry listed first.
- The server copies `extra.executors` from the facilitator's `/supported` kind
  for the network. A route's own `executors` list narrows it and can never
  widen it: every entry must be one the facilitator advertises (any entry does
  when it advertises `"*"`). A route's `"*"` passes only where the facilitator
  advertises `"*"`.
- Executors match as exact strings. Configure them as `0.0.x` contract ids on
  the server and the facilitator: an EVM address never matches a `0.0.x` entry.
- Building the quote throws when the facilitator does not offer
  `transferExecutor` on the network (no executors, or an
  `assetTransferMethods` list without it), when the route's `executors` is not
  a non-empty array of strings, or when it lists an executor the facilitator
  does not advertise. The error names that executor.
- Both payment flows are available: `authorization` (the default) and
  `upfront` (`extra.paymentFlow: "upfront"`), which settles before the handler
  runs, for authorizations that could expire during it. Settlement verifies and
  simulates again before submitting in either flow.
- The exact scheme's multi-payee `extra.splits` extension is not implemented for
  `transferExecutor`. Any `splits` value other than an empty array or `null`
  (a non-empty list, an object, a string, a number) makes building the quote
  throw, and the facilitator rejects it with `invalid_payment_requirements`. An
  empty list or `null` counts as absent. `cryptoTransfer` quotes are unchanged.
- The server caches `/supported` at `initialize()`. After changing the
  facilitator's executor lists, call `initialize()` again so quotes pick up the
  change. The facilitator itself reads its lists on every request.

### Facilitator

Add the five `transferExecutor` capabilities to the signer from the
[Facilitator](#facilitator) example, and pass `transferExecutor` options:

```ts
import {
  createHederaGetTokenCustomFees,
  createHederaGetTransactionRecord,
  createHederaResolveEvmAddress,
  createHederaSimulateContractCall,
  createHederaSubmitContractExecute,
  type FacilitatorHederaSigner,
} from "@x402/hedera";

const mirror = {}; // or { mirrorNodeUrl: "https://..." } / { mirrorNodeUrl: { "hedera:testnet": "https://..." } }

const transferExecutorSigner: FacilitatorHederaSigner = {
  ...facilitatorSigner,
  resolveEvmAddress: createHederaResolveEvmAddress(mirror),
  getTokenCustomFees: createHederaGetTokenCustomFees(mirror),
  simulateContractCall: createHederaSimulateContractCall(mirror),
  submitContractExecute: createHederaSubmitContractExecute(buildClient, feePayerKey),
  getTransactionRecord: createHederaGetTransactionRecord(mirror),
};

const facilitator = new x402Facilitator().register(
  ["hedera:testnet", "hedera:mainnet"],
  new ExactHederaScheme(transferExecutorSigner, {
    transferExecutor: {
      executors: { "hedera:testnet": ["0.0.7000"] },
      gasLimit: 400_000,
      // simulationGasCeiling: 300_000, // opt-in, see below
    },
  }),
);
```

| Option | Meaning |
| --- | --- |
| `executors` | Admitted executor contract ids (`0.0.x`) per CAIP-2 network. A network that is omitted, or whose list is empty, admits nothing. `"*"` admits any contract: it is never implied, must be written out, and is NOT RECOMMENDED. The scheme reads `executors` from the `transferExecutor` object you passed on every request, so editing its lists, or assigning a new `executors` object to it, takes effect on the next request. Replacing the whole `transferExecutor` object has no effect. Settlement re-checks admission just before submitting. |
| `gasLimit` | Required. An integer from 1 to 15,000,000 (the mirror node's `contracts/call` cap). The same value is used for the simulation and for the submitted transaction. Fixed when the scheme is constructed: later edits are ignored. |
| `simulationGasCeiling` | Optional, at most `gasLimit`, off by default, and fixed when the scheme is constructed. When set, verification makes a second mirror `contracts/call` with `estimate: true` and rejects with `simulation_gas_exceeded` when the estimate is above the ceiling. Without it, the gas limit alone bounds the call: an over-budget call reverts in simulation (`simulation_reverted`). The scheme spec says a facilitator that can measure simulated usage SHOULD reject an unexpectedly high figure, and the default `createHederaSimulateContractCall` can, so set a ceiling in production. |

The constructor throws on invalid options. `transferExecutor` is enabled on a
network only when the options are set, the network's executor list is not empty,
the signer has all five capabilities, and `getAddresses()` is not empty. On such
a network, the `/supported` kind's `extra` adds
`assetTransferMethods: ["cryptoTransfer", "transferExecutor"]` and `executors`.
Elsewhere `extra` stays `{ feePayer }`, and `transferExecutor` payments are
rejected with `invalid_exact_hedera_unsupported_asset_transfer_method`.

Register concrete networks. Under `"hedera:*"`, core advertises one kind for the
pattern, which cannot list each network's executors. When core asks the scheme
for that kind (it does so to serve `/supported`), the scheme turns
`transferExecutor` off on that instance, so it then rejects every
`transferExecutor` payment. If the options admit any executor, it also throws a
configuration error, so `/supported` fails until the scheme is registered for
`hedera:mainnet` and/or `hedera:testnet`. Until `/supported` is first served,
the instance still accepts `transferExecutor` payments under its options.

| Capability | Default factory | Backed by |
| --- | --- | --- |
| `resolveEvmAddress` | `createHederaResolveEvmAddress(config?)` | Mirror `GET /api/v1/accounts/{id}` |
| `getTokenCustomFees` | `createHederaGetTokenCustomFees(config?)` | Mirror `GET /api/v1/tokens/{id}` |
| `simulateContractCall` | `createHederaSimulateContractCall(config?)` | Mirror `POST /api/v1/contracts/call` |
| `submitContractExecute` | `createHederaSubmitContractExecute(buildClient, feePayerKey)` | Hiero SDK `ContractExecuteTransaction` |
| `getTransactionRecord` | `createHederaGetTransactionRecord(config?)` | Mirror `GET /api/v1/transactions/{id}` and `/api/v1/contracts/results/{id}` |

- `mirrorNodeUrl` is a single URL for every network, or a record keyed by CAIP-2
  network. Networks without an entry use the public mirror node.
  `createHederaGetTransactionRecord` also takes `timeoutMs` (default 20,000) and
  `pollIntervalMs` (default 1,000) for waiting on the record. Both must be
  finite and positive.
- The mirror node answers an unknown or unparsable id with 404 or 400. Both
  mean "not found": an unresolvable payer or `payTo` gives
  `address_resolution_failed`, and an `asset` that is not a fungible token on
  the network gives `invalid_payment_requirements`. Other mirror failures give
  `unexpected_verify_error`.
- Simulation is mirror-node only. The scheme spec prefers a mirror or consensus
  node over a JSON-RPC relay for the state a payment depends on, so no relay
  adapter ships. To use another channel, supply your own `simulateContractCall`.
- Each verification picks its fee payer at random among `getAddresses()`, as
  `/supported` picks the `feePayer` it advertises. A payer that is one of
  those accounts pays its own fee instead: the record checks let a facilitator
  account lose `amount` only when it is also the fee payer. A `payTo` that is
  one of those accounts never pays the fee, because it would net `amount` minus
  the fee. When it is the only account, verification rejects the payment with
  `invalid_payment_requirements`. Settlement simulates and submits from the
  account its own verification picked. Like
  `createHederaSignAndSubmitTransaction`, `createHederaSubmitContractExecute`
  signs with one key: with several accounts, they must share it, or supply a
  `submitContractExecute` that signs for the `feePayer` it is given.
- The facilitator signs exactly one transaction per payment: the
  `ContractExecuteTransaction`. `signAndSubmitTransaction` is never called for
  `transferExecutor`.

Operator notes:

- **Admission.** Admission is by address, not by code. Prefer executors that
  cannot change under you (no admin key, no upgrade path). Every settlement is
  judged from the consensus record (parent and child transfer lists plus
  contract logs), never from the receipt alone.
- **Fee payer allowances.** Fee payer accounts must grant executors no
  allowance. The record checks fail any debit of a facilitator account, but only
  after consensus, when the fee is already spent.
- **Alias policy.** `aliasPolicy` applies to `transferExecutor` too. Under
  `reject` (the default), `payTo` must be a `0.0.x` id. Under `allow`, an alias
  `payTo` is accepted but must resolve to an existing account on the mirror node
  (otherwise `address_resolution_failed`), and the credit is checked against
  that account. `transferExecutor` never pays for auto-account creation.
- **In-flight guard.** Each scheme instance keeps an in-memory key per
  `(network, executor, payer, authorization)`. Settle takes it before any I/O: an
  identical concurrent settle gets `invalid_payload` ("payload already in
  flight"), and `/verify` rejects a payload whose key is held. The key is
  released on a definite outcome. On `settlement_pending` it is kept until 180
  seconds after the contract call was submitted (Hedera's maximum transaction
  valid duration), so a retry cannot submit a second contract call. A settle
  that outlives those 180 seconds keeps its pending key for another 180 seconds,
  and never frees a key that a later settle took. Meanwhile an identical settle with the same
  requirements, such as core's single retry of a `settlement_pending`, submits
  nothing: it reads the record of the transaction already submitted and runs
  the settlement checks on it. It reports success or a failure with that
  transaction id, or `settlement_pending` again while the record is still
  unavailable. An identical settle with other requirements, or one arriving
  while that read runs, gets `invalid_payload`. A submission that times out or
  meets a transport error may still have reached a node, so it is reported as
  `settlement_pending` with the transaction id too. Only a node's precheck
  rejection, or a failure before submission, gives `unexpected_settle_error`
  with no transaction id. The guard is per process. The executor's single-use
  authorization is the authoritative replay protection.
- **Staking rewards.** When a touched account has pending staking rewards, the
  record shows `0.0.800` debited and the reward credited. Before the debit and
  credit checks, the facilitator nets out only the payouts the record itself
  marks (`staking_reward_transfers`), per record and child record. Every other
  movement is judged literally.

Error codes are exported as constants from `@x402/hedera/exact/facilitator`
([`errors.ts`](src/exact/facilitator/errors.ts)). Their meanings are in the
spec's "Error codes" table. A `transferExecutor` payment whose requirements are
malformed gets a standard x402 code: `invalid_network`, `invalid_scheme`,
`invalid_payment_requirements` (bad `asset`, `payTo` or `amount`), or
`invalid_payload` (`accepted` differs from the requirements). `cryptoTransfer`
keeps the codes it has always returned.

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

### transferExecutor live test

`test/integrations/exact-hedera.transferExecutor.test.ts` settles one payment
through an admitted executor on `hedera:testnet` and prints the Hashscan link of
the transaction. It is skipped, with no network access, unless every required
variable is set.

| Variable | Required | Meaning |
| --- | --- | --- |
| `HEDERA_FACILITATOR_ACCOUNT_ID` | yes | Fee payer that submits the contract call |
| `HEDERA_FACILITATOR_PRIVATE_KEY` | yes | Its `0x`-prefixed ECDSA key |
| `HEDERA_RESOURCE_SERVER_ACCOUNT_ID` | yes | `payTo` |
| `HEDERA_TE_EXECUTOR_ID` | yes | Executor contract id (`0.0.x`). The test admits it. |
| `HEDERA_TE_PAYER_ACCOUNT_ID` | yes | Account the executor debits (`payload.payer`) |
| `HEDERA_TE_AUTHORIZATION` | yes | `0x`-hex authorization for exactly this payer, asset, `payTo` and amount |
| `HEDERA_TE_AMOUNT` | yes | Amount in the asset's smallest unit (tinybars for HBAR) |
| `HEDERA_TE_ASSET` | no | `0.0.0` (HBAR, the default) or an HTS token id |
| `HEDERA_TE_GAS_LIMIT` | no | Gas limit for simulation and submission (default 400,000) |
| `HEDERA_MIRROR_NODE_URL` | no | Mirror node base URL (default: the public testnet mirror) |

Before running, fund the accounts on testnet (see
[Testnet Faucet](#testnet-faucet)): the facilitator account pays the
`ContractExecuteTransaction` fee, so it needs HBAR, and the payer needs
`HEDERA_TE_AMOUNT` of the asset. For a token, `payTo` must be associated with
it. `HEDERA_TE_EXECUTOR_ID` is the `0.0.x` contract id of a deployed
`ITransferExecutor`. Look it up on Hashscan or with the mirror node's
`/api/v1/contracts/{evm address}`, or deploy one yourself.

Prepare the authorization shortly before running. It must be unexpired and
unused, and it settles once. The executor checks it against the call the
facilitator builds: `from` and `to` are the mirror node's `evm_address` of the
payer and `payTo` (the alias where one exists), and `asset` is `address(0)` for
HBAR or the token's long-zero address. For the Hedera Agentic Accounts
`PaymentRouter` (spec "Annex: Reference executors"):

1. The payer account grants the router a HIP-336 allowance for the asset, and
   signs a policy that admits the agent key and `payTo`.
2. The agent signs the EIP-712 intent with `source` = the payer, `asset`,
   `destination` = `payTo`, `value` = `HEDERA_TE_AMOUNT`, a fresh `intentNonce`,
   and a `validBefore` that covers the run (the test quotes
   `maxTimeoutSeconds: 180`).
3. Set `HEDERA_TE_AUTHORIZATION` to `abi.encode(signedConfig, signedIntent,
   merkleProof)` as `0x`-hex.

Run it alone with:

```bash
pnpm exec vitest run --config vitest.integration.config.ts test/integrations/exact-hedera.transferExecutor.test.ts
```
