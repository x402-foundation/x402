# @x402/keeta

Keeta implementation of the x402 payment protocol for the [**exact** payment scheme](../../../../specs/schemes/exact/scheme_exact_keeta.md).

## Installation

```bash
npm install @x402/keeta
# or
pnpm add @x402/keeta
```

## Overview

This package provides three main components for handling x402 payments on Keeta:

- **Client** - For applications that need to make payments (have wallets/signers)
- **Facilitator** - For payment processors that verify and settle blocks
- **Server** - For resource servers that accept payments and build payment requirements

**Key Differences from EVM/SVM:**

- **Block-based** - payments are encoded as signed Keeta blocks
- **Fee payer settlement** - the facilitator submits blocks on behalf of clients via a fee payer account
- **Instant settlement** - Once the server's call to `/settle` completes the payment has been settled on the network
- **Per-fee-payer serialization** - a built-in `SettlementQueue` ensures blocks are submitted sequentially per fee payer while allowing parallelism across different fee payers

## Package Exports

### Main Package (`@x402/keeta`)

**Client:**

- `ExactKeetaScheme` - Client implementation for creating payment blocks
- `toClientKeetaSigner(account)` - Converts a Keeta `Account` to a client signer
- `ClientKeetaSigner` - TypeScript type for client signers

**Facilitator:**

- `ExactKeetaScheme` - Facilitator for payment verification and settlement
- `toFacilitatorKeetaSigner(accounts)` - Converts Keeta `Account` array to a facilitator signer
- `FacilitatorKeetaSigner` - TypeScript type for facilitator signers

**Server:**

- `ExactKeetaScheme` - Server for building payment requirements

**Utilities:**

- `getUsdcAddress(network)` - Get USDC token address for a network
- `networkToKeetaNetwork(network)` - Convert CAIP-2 identifier to Keeta network name

**Types:**

- `ExactKeetaPayload` - Payment payload type

**Constants:**

- `KEETA_MAINNET_CAIP2` = `"keeta:21378"`
- `KEETA_TESTNET_CAIP2` = `"keeta:1413829460"`
- `KTA_MAINNET_ADDRESS` = Base token address for mainnet
- `KTA_TESTNET_ADDRESS` = Base token address for testnet

## Usage

### Client

```typescript
import * as KeetaNet from "@keetanetwork/keetanet-client";
import { ExactKeetaScheme, toClientKeetaSigner, KEETA_TESTNET_CAIP2 } from "@x402/keeta";

const account = KeetaNet.lib.Account.fromSeed(
  await KeetaNet.lib.Account.seedFromPassphrase(process.env.CLIENT_MNEMONIC),
  0,
);

// await using cleans up the signer when the code block ends.
// For long-running processes call signer.destroy() on
// SIGINT / SIGTERM to cleanup the signer and allow the NodeJS
// process to terminate (see facilitator example below).
await using signer = toClientKeetaSigner(account);

const client = new x402Client();
client.register(KEETA_TESTNET_CAIP2, new ExactKeetaScheme(signer));
```

Use either `await using` or call `await signer.destroy()` manually to clean up resources and allow the Node process to exit cleanly.

### Facilitator

For long-running processes, call `signer.destroy()` on shutdown to clean up resources.

```typescript
import * as KeetaNet from "@keetanetwork/keetanet-client";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorKeetaSigner, KEETA_TESTNET_CAIP2 } from "@x402/keeta";
import { ExactKeetaScheme } from "@x402/keeta/exact/facilitator";

const account = KeetaNet.lib.Account.fromSeed(
  await KeetaNet.lib.Account.seedFromPassphrase(process.env.FACILITATOR_MNEMONIC),
  0,
);

const signer = toFacilitatorKeetaSigner([account]);

const facilitator = new x402Facilitator();
// Register Keeta facilitator with console logger
facilitator.register(KEETA_TESTNET_CAIP2, new ExactKeetaScheme(signer, console));

// Tear down signer on shutdown so the process exits cleanly.
async function shutdown() {
  await signer.destroy();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

### Server

```typescript
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { KEETA_TESTNET_CAIP2 } from "@x402/keeta";
import { ExactKeetaScheme } from "@x402/keeta/exact/server";

const facilitatorClient = new HTTPFacilitatorClient({
  url: "http://localhost:4022",
});

const server = new x402ResourceServer(facilitatorClient);
server.register(KEETA_TESTNET_CAIP2, new ExactKeetaScheme());
```

## Supported Networks

- `keeta:21378` - Mainnet
- `keeta:1413829460` - Testnet

## Asset Support

Supports any Keeta token:

- **USDC** (primary, 6 decimals)
- **KTA** (native token)
- Any token with a valid Keeta token address

## Testnet Resources

For testing on Keeta Testnet:

1. Go to [Keeta Testnet Wallet](https://wallet.test.keeta.com/) and follow the steps to create your wallet. Save your mnemonic (seed phrase) to keep access. To get your Keeta address, click on "Receive" and copy the deposit address (starting with `keeta_`).
2. Use the [Keeta Testnet Faucet](https://faucet.test.keeta.com/) to send Testnet KTA to your wallet.
3. To get Testnet USDC on Keeta, go to the "Receive" page in the wallet, click on "Any token from Keeta Testnet", select "USDC from Base (Sepolia) Testnet" and copy the deposit address (starting with `0x`). Then go to the [Circle Faucet](https://faucet.circle.com/), select Base network and enter your Base deposit address.

## Integration Tests

The integration tests generate and fund new Keeta accounts by default, so no configuration is necessary.
If desired, the client, server, and facilitator used for the tests can be specified via the following environment variables:

```bash
# Client's BIP-39 mnemonic
KEETA_CLIENT_MNEMONIC="..."
# Server's Keeta address
KEETA_SERVER_ADDRESS="keeta_..."
# Facilitator's BIP-39 mnemonic
KEETA_FACILITATOR_MNEMONIC="..."
```

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

## Related Packages

- `@x402/core` - Core protocol types and client
- `@x402/fetch` - HTTP wrapper with automatic payment handling
- `@x402/evm` - EVM/Ethereum implementation
- `@x402/svm` - Solana/SVM implementation

## License

Apache-2.0
