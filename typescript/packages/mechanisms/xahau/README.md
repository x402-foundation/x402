# `@x402/xahau` [![npm version](https://img.shields.io/npm/v/%40x402%2Fxahau.svg)](https://www.npmjs.com/package/@x402/xahau)

Xahau implementation of the x402 payment protocol using the **Exact** payment scheme with payer-signed Xahau `Payment` transactions, built on [xahau.js](https://github.com/Xahau/xahau.js).

## Installation

```bash
npm install @x402/xahau
# or
pnpm add @x402/xahau
```

## Overview

This package provides three components for x402 payments on Xahau:

- **Client** - Builds and signs Xahau `Payment` transactions.
- **Server** - Builds Xahau payment requirements and invoice ids.
- **Facilitator** - Verifies signed Xahau transactions and submits them for settlement.

The payer signs a complete Xahau `Payment` transaction and pays the Xahau transaction fee, so `extra.areFeesSponsored` is always `false`; facilitator-sponsored fees are not supported by this scheme.

## Package Exports

### Main Package (`@x402/xahau`)

- `createXahauWalletSigner(wallet)` - Creates a client signer from an `xahau` `Wallet`.
- `createTickets(signer, network, ticketCount)` - Creates Xahau Tickets for `ticketSequence` payments.
- `getXahauTicketSequences(account, network)` - Lists an account's available ticket sequences.
- `invoiceIdToInvoiceIdField(invoiceId)` - Converts an invoice id to a Xahau `InvoiceID`.
- Xahau network constants: `XAHAU_MAINNET`, `XAHAU_TESTNET`.

### Subpath Exports

- `@x402/xahau/exact/client` - `ExactXahauScheme` client implementation.
- `@x402/xahau/exact/server` - `ExactXahauScheme` server implementation.
- `@x402/xahau/exact/facilitator` - `ExactXahauScheme` facilitator implementation.

## Supported Networks

- `xahau:21337` - Xahau mainnet (`wss://xahau.network`).
- `xahau:21338` - Xahau testnet (`wss://xahau-test.net`).
- `xahau:<networkId>` - Other Xahau networks with numeric `NetworkID`; configure an endpoint with `wsUrlByNetwork`.

## Asset Support

- Native XAH: `asset` is `"XAH"` and `amount` is an integer drops string (1 XAH = 1,000,000 drops).
- Xahau issued currencies (IOUs): `asset` is the currency code (3-character or 40-hex), `amount` is the exact Xahau issued-currency decimal `value` string (for example `"10.5"`), and `extra.issuer` is the issuer classic address.

There is no `extra.decimals` field: Xahau issued-currency amounts are ledger decimal values, so the requirement `amount` is used verbatim as the signed `value`. Xahau exact payments use explicit `AssetAmount` pricing or a registered money parser; no default USD asset is configured, so dollar-string prices throw.

## Asset Transfer Methods

`extra.assetTransferMethod` selects how the signed transaction is sequenced:

- `"sequence"` (default) - consumes the payer account's current `Sequence`. No preflight transaction and no extra reserve, but the account supports only one pending payment at a time.
- `"ticketSequence"` - consumes a pre-created Xahau [Ticket](https://xahau.network/docs/protocol-reference/ledger-data/ledger-objects-types/ticket/) (`Sequence = 0` plus `TicketSequence`), allowing multiple concurrent pending payments per account.

The client follows the method pinned in the payment requirements and defaults to `"sequence"`. Resource servers offer `"ticketSequence"` by advertising it in `extra.assetTransferMethod` (optionally as a second `accepts` entry so clients can choose either method).

For `"ticketSequence"` payments, the client automatically creates one ticket when none is
available. Set `ticketCreateCount` to create more at once, or to `0` to disable automatic creation.
To provision ticket inventory explicitly:

```typescript
import { Wallet } from "xahau";
import { createTickets, createXahauWalletSigner } from "@x402/xahau";

const wallet = Wallet.fromSeed(process.env.XAHAU_SEED!);
const signer = createXahauWalletSigner(wallet);
const ticketSequences = await createTickets(signer, "xahau:21338", 5);
```

Each outstanding ticket locks owner reserve (0.2 XAH on mainnet at the time of writing) until it is used or deleted, and an account can hold at most 250 outstanding tickets.

## Testnet Setup

1. Create and fund a payer account with the [Xahau Testnet faucet](https://xahau.network/docs/features/faucet-and-explorer/) (`wss://xahau-test.net`, network `xahau:21338`). The faucet returns a secp256k1 seed; load it with `Wallet.fromSeed(seed, { algorithm: "ecdsa-secp256k1" })`.
2. Keep the base and owner reserves funded: accounts need the base reserve (1 XAH at the time of writing) plus 0.2 XAH owner reserve per outstanding ticket.
3. For issued-currency (IOU) payments, the receiving account must hold a [trust line](https://xahau.network/docs/protocol-reference/transactions/transaction-types/trustset/) to the issuer, and the payer needs a sufficient issued-currency balance.
4. The facilitator needs no funded account: the payer signs and pays the Xahau transaction fee, and the facilitator only reads ledger state and submits the signed blob.

## Usage

### Client

```typescript
import { Wallet } from "xahau";
import { x402Client } from "@x402/core/client";
import { createXahauWalletSigner } from "@x402/xahau";
import { ExactXahauScheme } from "@x402/xahau/exact/client";

const wallet = Wallet.fromSeed(process.env.XAHAU_SEED!);
const signer = createXahauWalletSigner(wallet);

const client = x402Client.fromConfig({
  schemes: [{ network: "xahau:*", client: new ExactXahauScheme(signer) }],
  spendControls: { allowedAssets: [{ network: "xahau:*", asset: "XAH" }] },
});
```

XAH is not a USD default asset, so the client must opt in to it through `spendControls.allowedAssets`.

The default client uses `xahau.Client` to autofill ledger-derived fields before signing:

- `Sequence` (or `Sequence = 0` plus an available `TicketSequence` for ticket payments)
- `Fee`, from the `fee` RPC with the transaction blob, so it includes strong Hook execution on the payer and destination
- `LastLedgerSequence`
- `NetworkID`

Use `wsUrlByNetwork` or `clientFactory` to customize the Xahau connection, and `feeDrops` only when the client should use an explicit fee instead of the network autofill value. If a wallet or application prepares transactions externally, pass `preparePaymentTransaction`; the returned transaction must satisfy the selected asset transfer method, and include `Fee`, `LastLedgerSequence`, and the network's `NetworkID`.

For `"ticketSequence"` payments, `ticketCreateCount` controls automatic ticket creation when the
account has no available tickets. It defaults to `1`; set it to `0` to require pre-provisioned
tickets.

While a `"sequence"` payment is pending, the payer account should not sign or submit other transactions until the payment settles or its `LastLedgerSequence` passes; consuming the sequence elsewhere permanently invalidates the payment.

### Server

```typescript
import { x402ResourceServer } from "@x402/core/server";
import { ExactXahauScheme } from "@x402/xahau/exact/server";

const server = new x402ResourceServer(facilitatorClient);
server.register("xahau:*", new ExactXahauScheme());
```

Use explicit asset pricing:

```typescript
{
  scheme: "exact",
  price: {
    amount: "1000000",
    asset: "XAH"
  },
  network: "xahau:21338",
  payTo: "r...",
}
```

The server scheme adds `extra.areFeesSponsored: false` to the advertised requirements. Invoice binding is enforced when the resource configuration provides `extra.invoiceId`; requirements are rebuilt for every request, so the scheme never injects per-request values.

### Facilitator

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactXahauScheme } from "@x402/xahau/exact/facilitator";

const facilitator = new x402Facilitator().register("xahau:*", new ExactXahauScheme());
```

Verification enforces the spec's checks: envelope consistency, offline signature validation, signer-to-account authorization (the embedded `SigningPubKey` must be the account's master key pair, unless disabled, or its configured regular key), destination and amount matching, NetworkID binding, per-method sequencing (current account `Sequence`, or ticket availability), `LastLedgerSequence` expiry policy, invoice binding via `InvoiceID`, fee caps, safety rejections (`Memos`, `Paths`, `DeliverMin`, partial payments, multisigned blobs), and a `simulate` RPC call that must return `tesSUCCESS`. Settlement re-runs verification, submits the signed blob, and succeeds only on a validated `tesSUCCESS` result.

`maxFeeDrops` (default `100000`, 0.1 XAH) caps the payer's `Fee`. Strong Hooks on the payer and destination are paid for in that fee; hooked mainnet payments observed when this default was chosen paid up to ~60000 drops. Raise it for `payTo` accounts with heavier Hooks.

## Duplicate Settlement Protection

This package includes a built-in `SettlementCache` that prevents a race condition where the same signed payment could be settled multiple times before its on-chain effects become visible: Xahau submission is idempotent on the transaction hash, so `submitAndWait` for an already-submitted blob resolves with the same validated `tesSUCCESS` outcome instead of failing.

The cache rejects concurrent `/settle` calls that carry the same signed transaction blob, returning a `duplicate_settlement` error for the second and subsequent attempts. Entries are keyed on the signed transaction hash and retained for the transaction's landable window — sized from the payment's `maxTimeoutSeconds` (which bounds its `LastLedgerSequence`) — so an entry cannot be evicted while a slow-to-validate duplicate could still pass re-verification. Because entries are not cleared on failure, a `duplicate_settlement` result means the transaction was already seen, not that it settled.

**No additional configuration is required** — each `ExactXahauScheme` facilitator instance creates its own cache by default. Pass a shared `SettlementCache` as the second constructor argument if you register several scheme instances that should block each other's duplicates. This is a per-process guard: a horizontally scaled facilitator must back it with a shared atomic store so duplicates routed to different replicas are still caught.

For full details on the race condition and mitigation strategy, see the [Exact Xahau Scheme Specification](../../../../specs/schemes/exact/scheme_exact_xahau.md#duplicate-settlement-mitigation-required).

## Development

```bash
pnpm build
pnpm test
pnpm test:integration
pnpm lint:check
```

For protocol details, see [`scheme_exact_xahau.md`](../../../../specs/schemes/exact/scheme_exact_xahau.md).

## License

Apache-2.0
