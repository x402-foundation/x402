# @x402/starknet

Starknet mechanism for the x402 payment protocol (v2).

This package implements the `exact` scheme on Starknet as specified in [`specs/schemes/exact/scheme_exact_starknet.md`](../../../../specs/schemes/exact/scheme_exact_starknet.md). A client signs a SNIP-12 typed-data message authorizing a SNIP-9 v2 `OutsideExecution` that contains exactly one SNIP-2 `transfer`, and the facilitator causes it to execute via `execute_from_outside_v2` on the payer's account and pays all gas. The payer needs only a token balance: no gas, and no token approval.

`PaymentRequirements.extra.feePayer` is REQUIRED: it is the address that will be the onchain caller. The facilitator advertises it on `/supported`, the resource server copies it verbatim, and the client sets it as the SNIP-9 `Caller`.

Supported networks: `starknet:SN_MAIN`, `starknet:SN_SEPOLIA`.

## Install

```bash
# starknet is a peer dependency: this package takes a `starknet.Account` you
# construct. v8 is required - v7 cannot broadcast to an RPC 0.9.0 node and
# v9+ drops RPC 0.8.1 support.
pnpm add @x402/starknet @x402/core "starknet@^8.9.2"
```

## Client

```ts
import { Account } from "starknet";
import { x402Client } from "@x402/core/client";
import { createStarknetProvider, toClientStarknetSigner } from "@x402/starknet";
import { ExactStarknetScheme } from "@x402/starknet/exact/client";

const provider = createStarknetProvider("starknet:SN_SEPOLIA");
const signer = toClientStarknetSigner(
  new Account({
    provider,
    address: process.env.STARKNET_ADDRESS!,
    signer: process.env.STARKNET_PRIVATE_KEY!,
  }),
);

const client = new x402Client();
client.register("starknet:*", new ExactStarknetScheme(signer));
```

## Resource server

```ts
import { x402ResourceServer } from "@x402/core/server";
import { ExactStarknetScheme } from "@x402/starknet/exact/server";

const server = new x402ResourceServer(facilitatorClient);
server.register("starknet:*", new ExactStarknetScheme());
```

The scheme copies `extra.feePayer` from the facilitator's `/supported` entry into the advertised requirements, so a resource server cannot serve a Starknet 402 without a facilitator that announces one. Dollar-string prices (`"$0.10"`, `"0.10 USDC"`) resolve through the package's `DEFAULT_ASSETS` table - Circle USDC on both networks, 6 decimals (`USDC_MAINNET` / `USDC_SEPOLIA`); use `registerMoneyParser` or an explicit `AssetAmount` price for any other SNIP-2 token. The same table backs `findDefaultAsset` on the client scheme, so `x402Client` spend controls recognize USDC as a USD-pegged default and apply their USD cap to it.

## Facilitator

```ts
import { Account } from "starknet";
import { x402Facilitator } from "@x402/core/facilitator";
import { createStarknetProvider, toFacilitatorStarknetSigner } from "@x402/starknet";
import { ExactStarknetScheme } from "@x402/starknet/exact/facilitator";

const provider = createStarknetProvider("starknet:SN_SEPOLIA");
const signer = toFacilitatorStarknetSigner(
  new Account({
    provider,
    address: process.env.FACILITATOR_ADDRESS!,
    signer: process.env.FACILITATOR_PRIVATE_KEY!,
  }),
);

const facilitator = new x402Facilitator();
facilitator.register("starknet:SN_SEPOLIA", new ExactStarknetScheme(signer));
```

The optional second constructor argument accepts `{ rpcUrl, providerFactory, rpcTimeoutMs, confirmationTimeoutMs, maxSignatureFelts, pendingSettlementStore }`: `providerFactory` supplies the read provider (custom transport or retry policy, and takes over from `rpcTimeoutMs`); `rpcTimeoutMs` bounds each RPC request (default 15000); `confirmationTimeoutMs` bounds how long a settlement waits for its receipt before answering `settlement_pending` (default 75000, below core's 90 s facilitator HTTP timeout so that answer reaches the resource server); `maxSignatureFelts` bounds the signature array (default 32 - raise it to serve webauthn/passkey accounts, whose signatures are longer); and `pendingSettlementStore` is a `PendingSettlementStore` from `@x402/core/facilitator` that remembers a broadcast whose confirmation timed out (default: a per-instance in-memory store with a 5 minute retention; inject a shared, network-backed one so a settle retry landing on another replica still reconciles). Success is reported at `ACCEPTED_ON_L2`. An optional third argument takes a `SettlementCache` shared between schemes in the same process.

### Choosing a facilitator signer

Both signers announce their first address as `extra.feePayer`.

- `toFacilitatorStarknetSigner(account)` - the facilitator's own funded account is the announced `feePayer` **and** the account transactions originate from, so verification can simulate the full `execute_from_outside_v2` call tree. Use this unless you have a paymaster.
- `toFacilitatorStarknetPaymasterSigner({ feePayerAddresses, paymasterUrl, paymasterApiKey, relayerAddresses, timeoutMs })` - settles through a SNIP-29 applicative paymaster in sponsored fee mode. The announced `feePayer` is the paymaster's forwarder contract, which nothing can send a transaction as, so verification deterministically falls back to simulating the inner `transfer` from the payer (spec §8) while the paymaster runs its own full estimation at settlement. `relayerAddresses` are the paymaster's relayer accounts, listed as `signers` on `/supported` (the forwarder never signs, so nothing is listed without them); `timeoutMs` bounds each paymaster request (default 15000).

## What verification checks (spec §1–§9)

- **§1** Version, scheme, and network, plus `accepted` matching the server-supplied requirements field-by-field including `extra.feePayer`.
- **§2** Typed data is never hashed as received: `chainId` and the five message fields are reparsed and the SNIP-12 hash is taken over the facilitator's own canonical reconstruction.
- **§3** The account must be deployed and its `is_valid_signature` must return the SNIP-6 `VALID` magic for the reconstructed hash.
- **§4** `message.Caller` must equal `extra.feePayer`; zero, the payer, and the `ANY_CALLER` sentinel are rejected outright.
- **§5** Time bounds: at `/verify` the authorization must stay valid for the full advertised window (within a 30s skew margin) and must not exceed `maxTimeoutSeconds` by more than that margin; at both phases at least 30s must remain before `Execute Before`, and `Execute After` must already be in the past.
- **§6** `is_valid_outside_execution_nonce` must report the SNIP-9 nonce unused.
- **§7** Exactly one call, `To = asset`, `Selector = sn_keccak("transfer")`, and calldata exactly `[payTo, amount_low, amount_high]` summing to `amount`.
- **§8** Chain-state preflight: `balanceOf` / `balance_of` at least `amount`, plus a mandatory `starknet_simulateTransactions` whose trace must show exactly one `asset` `Transfer` from the payer to `payTo` for the exact amount.
- **§9** Facilitator safety: the `feePayer` must be one this facilitator manages, the payer must not be, and `payer` is echoed on a response only once the signature has verified.

Settlement re-verifies (never trusting a prior `/verify`), rejects a duplicate in-flight `(payer, nonce)`, broadcasts through the signer, and reports `success: true` only once the receipt shows `SUCCEEDED` **and** carries the exact payer to `payTo` transfer. A broadcast whose confirmation cannot be established returns the non-terminal `settlement_pending` code with the transaction hash and remembers that hash in the pending-settlement store; the resource server's single automatic retry of the identical payload then waits on that same transaction instead of re-verifying and re-broadcasting, and resolves to the one success, to a terminal failure, or to `settlement_pending` again (with the hash re-remembered) while the transaction is still unconfirmed. A consumed SNIP-9 nonce on any other settle request is terminal (`nonce_already_used`): the facilitator never searches the chain for the transaction that consumed it, because a settled payload is public and a success handed to a replay would release the resource a second time.

## Testnet setup

1. Deploy and fund the **facilitator** account with Sepolia STRK from the [Starknet Sepolia faucet](https://faucet.starknet.io/). It submits `execute_from_outside_v2` and pays gas for every settlement, so it must be a deployed account contract and stay funded.
2. Deploy the **payer** account contract (Argent X, Braavos, or `sncast account create` then `sncast account deploy`), which needs a one-time STRK balance from the same faucet. After deployment the payer needs no gas at all, because it only signs. The payer's account class MUST implement SNIP-9 v2, i.e. expose `execute_from_outside_v2` and `is_valid_outside_execution_nonce`; older account classes do not, and verification rejects a deployed account whose class lacks `is_valid_outside_execution_nonce` with `nonce_already_used` (an address that is not deployed at all is rejected with `account_not_deployed`). Current Argent and Braavos accounts qualify. To check a class before funding it: `starkli class-at <address> --rpc <url> | grep execute_from_outside_v2`.
3. Give the payer testnet USDC from the [Circle faucet](https://faucet.circle.com/) (select Starknet Sepolia). `USDC_SEPOLIA` is `0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343` (6 decimals).
4. The default RPC endpoints are public nodes; pass `rpcUrl` to the facilitator config to use your own. The client never calls an RPC: it builds and signs the authorization offline from the `PaymentRequirements` alone.

## Operational notes

### Residual gas exposure

Verification simulates every payment and fails closed, so a settlement that
would revert is rejected before it is broadcast. What simulation cannot rule out
is state changing between `/verify` and settlement: the payer can move its
balance, or another transaction can consume the SNIP-9 nonce. The authorization
is still safe - a revert rolls the nonce back and no funds move - but the
facilitator pays gas for the reverted transaction.

The spec makes the mitigations SHOULDs, and they are deployment policy rather
than scheme behavior, so this package does not impose them. A production
facilitator should:

- rate-limit `/settle` per payer, so a griefer cannot burn gas in a loop;
- cap what it will spend on one settlement - on the direct-executor path pass a
  bounded `tip` to `toFacilitatorStarknetSigner` and estimate the fee before
  broadcasting; on the paymaster path use the sponsorship limits of the SNIP-29
  provider;
- restrict which resource servers may request settlement, since settlement
  spends sponsored gas; applying the same allowlist to `/verify`, the
  unauthenticated entry point, bounds the RPC work it can be made to do.


The duplicate-settlement guard is held in memory on the facilitator instance. It is an optimization, not the authority: the SNIP-9 nonce is the onchain replay protection. Its API is synchronous, so it cannot be backed by a shared store; a horizontally scaled facilitator does not coordinate guards across replicas, and a duplicate `/settle` landing on another replica is caught by the onchain nonce, which makes the second broadcast revert rather than pay twice. The pending-settlement store is the one piece of settlement state worth sharing: back it with a network store (`pendingSettlementStore` above) so a `settlement_pending` retry reconciles on whichever replica it reaches.

## Development

```bash
pnpm build
pnpm test
pnpm test:integration
pnpm lint:check
```
