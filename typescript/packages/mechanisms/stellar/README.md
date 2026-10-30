# `@x402/stellar` [![npm version](https://img.shields.io/npm/v/%40x402%2Fstellar.svg)](https://www.npmjs.com/package/@x402/stellar)

Stellar implementation of the x402 payment protocol using the **Exact** and **Upto** payment schemes with [Soroban token](https://stellar.org/protocol/sep-41) transfers.

## Installation

```bash
npm install @x402/stellar
```

## Overview

This package provides three main components for handling x402 payments on Stellar:

- **Client** - For applications that need to make payments (have wallets/signers)
- **Facilitator** - For payment processors that verify and execute on-chain transactions
- **Server** - For resource servers that accept payments and build payment requirements

**Key Differences from EVM/SVM:**

- **Ledger-based expiration** (not timestamps) - default ~12 ledgers ≈ 60 seconds
- **Auth entry signing** - client signs authorization entries only, facilitator rebuilds and submits transaction
- **Mainnet requires custom RPC URL** (see [Stellar RPC Providers](https://developers.stellar.org/docs/data/apis/rpc/providers))

## Package Exports

### Main Package (`@x402/stellar`)

**V2 Protocol Support** - x402 v2 protocol with CAIP-2 network identifiers

**Client:**

- `ExactStellarScheme` - Client implementation using Soroban token transfers
- `createEd25519Signer(privateKey, defaultNetwork)` - Creates a Stellar signer from private key that implements `SignAuthEntry` and `SignTransaction` according to [SEP-43](https://stellar.org/protocol/sep-43)
- `ClientStellarSigner` - TypeScript type for client signers

**Facilitator:**

- `ExactStellarScheme` - Facilitator for payment verification and settlement
- `FacilitatorStellarSigner` - TypeScript type for facilitator signers

> [!NOTE]
> Facilitators currently always sponsor transaction fees (`areFeesSponsored: true`). Settlement fees are derived from the settle-time simulation (`simulationResourceFee + inclusionBuffer`); `maxTransactionFeeStroops` is a safety ceiling, not a per-transaction budget. A non-sponsored flow will be added later. See [spec](../../../specs/schemes/exact/scheme_exact_stellar.md#paymentrequirements-for-exact) for details.

**Server:**

- `ExactStellarScheme` - Server for building payment requirements

**Utilities:**

- `getRpcUrl(network, config?)` - Get RPC URL for a network
- `getRpcClient(network, config?)` - Create Soroban RPC client
- `getNetworkPassphrase(network)` - Get network passphrase
- `validateStellarDestinationAddress(address)` - Validate destination address
- `validateStellarAssetAddress(address)` - Validate asset/contract address
- `convertToTokenAmount(amount, decimals)` - Convert decimal to token units
- `getUsdcAddress(network)` - Get USDC contract address

**Constants:**

- `STELLAR_PUBNET_CAIP2` = `"stellar:pubnet"`
- `STELLAR_TESTNET_CAIP2` = `"stellar:testnet"`
- `USDC_PUBNET_ADDRESS` - USDC contract on mainnet
- `USDC_TESTNET_ADDRESS` - USDC contract on testnet
- `DEFAULT_TOKEN_DECIMALS` = `7`

### Subpath Exports

- `@x402/stellar/exact/client` - `ExactStellarScheme` (client)
- `@x402/stellar/exact/server` - `ExactStellarScheme` (server)
- `@x402/stellar/exact/facilitator` - `ExactStellarScheme` (facilitator)
- `@x402/stellar/upto/client` - `UptoStellarScheme` (client)
- `@x402/stellar/upto/server` - `UptoStellarScheme` (server)
- `@x402/stellar/upto/facilitator` - `UptoStellarScheme` (facilitator)

## Supported Networks

**V2 Networks** (via [CAIP-28](https://namespaces.chainagnostic.org/stellar/caip2)):

- `stellar:pubnet` - Mainnet (requires custom RPC URL)
- `stellar:testnet` - Testnet (default: [https://soroban-testnet.stellar.org](https://soroban-testnet.stellar.org))
- `stellar:*` - Wildcard (matches all Stellar networks)

## Asset Support

Supports Soroban tokens implementing [SEP-41](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md):

- Any Soroban token contract with `transfer(from, to, amount)` function
- Default asset is USDC (primary, 7 decimals)

> **For detailed protocol flow, transaction structure, and verification rules, see the [Exact Scheme Specification](../../../specs/schemes/exact/scheme_exact_stellar.md).**

## Usage Patterns

### 1. Direct Registration (Recommended)

```typescript
import { x402Client } from "@x402/core/client";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const signer = createEd25519Signer(privateKey, "stellar:testnet");
const client = new x402Client().register("stellar:*", new ExactStellarScheme(signer));
```

### 2. Custom Configuration

```typescript
// Client with custom RPC
const client = new x402Client().register(
  "stellar:*",
  new ExactStellarScheme(signer, { url: "https://custom-rpc.example.com" }),
);

// Server with custom money parser
const scheme = new ExactStellarScheme().registerMoneyParser(async (amount, network) => ({
  amount: customConvert(amount),
  asset: "TOKEN_ADDRESS",
  extra: {},
}));

// Facilitator
const facilitator = new x402Facilitator().register(
  "stellar:testnet",
  new ExactStellarScheme([signer]),
);
```

## Upto Scheme

The `upto` scheme charges the actual usage after the request is served, up to a maximum the client authorizes. The client signs one Soroban authorization entry over the terms — recipient, token, maximum, expiration and the facilitator's settlement authority — for the `x402-upto-stellar` settlement contract ([source](../../../../contracts/stellar/upto)). The amount is not part of what the client signs: the facilitator settles `settle(payer, terms, amount)` as the settlement authority, the contract enforces `0 ≤ amount ≤ maximum`, and the Soroban host enforces the signature, the expiration and single use. The payload is `{ authorization, signerAuthorizations? }`.

```typescript
// Client
import { UptoStellarScheme } from "@x402/stellar/upto/client";
const client = new x402Client().register("stellar:*", new UptoStellarScheme(signer));

// Resource server: the price is the maximum; set the actual charge after serving the request
import { UptoStellarScheme } from "@x402/stellar/upto/server";
server.register("stellar:*", new UptoStellarScheme());
setSettlementOverrides(res, { amount: "50%" }); // atomic units, a percentage of the maximum, or "$0.001"

// Facilitator: channel accounts as transaction sources; the settlement authority defaults to the first signer
import { UptoStellarScheme } from "@x402/stellar/upto/facilitator";
facilitator.register("stellar:testnet", new UptoStellarScheme([signer], { feeBumpSigner: sponsor }));
```

- The settlement contract is built in for `stellar:testnet` (`UPTO_TESTNET_DEPLOYMENT`). Other networks need the `contracts` option (by network) on the client and the facilitator.
- `/supported` advertises `extra: { areFeesSponsored: true, facilitatorAddress }`; the server copies both into the requirements.
- A zero amount is settled on-chain: it uses up the authorization and moves nothing.
- A repeat of a settlement returns its result, also shortly after the authorization expires, and a repeat for another amount is refused. These records live in the memory of one process. A settlement that may have been broadcast is answered `settlement_pending` with its hash.
- The client signs for at most 300 seconds (`maxTimeoutSeconds` option), and only for a `G…` settlement authority. The facilitator accepts a `maxTimeoutSeconds` from 15 to 300 seconds (`maxTimeoutSeconds` option).
- Contract-account payers pass an `authorizeEntry` signer to the client, which may also return `signerAuthorizations`.
- `maxTransactionFeeStroops` defaults to 500,000 stroops for `upto` and counts the fee bump's own inclusion fee. Smart-account payers and first payments through a contract token can cost more; size it for the payers you serve.
- Concurrent settlements need several signers (transaction sources), used in turn.
- Every refusal has a stable code; `uptoStellarCodes` lists them with a default reason.

> **For the verification rules, the settlement transaction and the security model, see the [Upto Scheme Specification](../../../../specs/schemes/upto/scheme_upto_stellar.md).**

## Development

```bash
# Build
pnpm build

# Test
pnpm test

# Integration tests
pnpm test:integration

# Lint & Format
pnpm lint
pnpm format
```

## Integration Tests

Integration tests require four funded Stellar testnet accounts:

```bash
CLIENT_PRIVATE_KEY=S...           # Client's secret key
FACILITATOR_PRIVATE_KEY=S...      # Facilitator's secret key
FACILITATOR_ADDRESS=G...          # Facilitator's public address
RESOURCE_SERVER_ADDRESS=G...      # Resource server's public address
```

The `upto` integration test (`test/integrations/upto-stellar.test.ts`) uses the same four accounts and settles on the testnet deployment of the settlement contract. It runs when the variables are set and is skipped otherwise.

### Stellar Testnet Account Setup

1. Go to [Stellar Laboratory](https://lab.stellar.org/account/create) ➡️ Generate keypair ➡️ Fund account with Friendbot, then copy the `Secret` and `Public` keys so you can use them.
2. Add USDC trustline (required for client and resource server): go to [Fund Account](https://lab.stellar.org/account/fund) ➡️ Paste your `Public Key` ➡️ Add USDC Trustline ➡️ paste your `Secret key` ➡️ Sign transaction ➡️ Add Trustline.
3. Get testnet USDC from [Circle Faucet](https://faucet.circle.com/) (select Stellar network).

> [!NOTE]
> The facilitator account only needs XLM (step 1). Client and resource server accounts need all three steps.

## Related Packages

- `@x402/core` - Core protocol types and client
- `@x402/fetch` - HTTP wrapper with automatic payment handling
- `@x402/evm` - EVM/Ethereum implementation
- `@x402/svm` - Solana/SVM implementation
