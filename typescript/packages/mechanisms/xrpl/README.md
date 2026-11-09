# `@x402/xrpl` [![npm version](https://img.shields.io/npm/v/%40x402%2Fxrpl.svg)](https://www.npmjs.com/package/@x402/xrpl)

XRPL implementation of the x402 payment protocol using the **Exact** payment scheme with payer-signed XRP Ledger `Payment` transactions.

## Installation

```bash
npm install @x402/xrpl
# or
pnpm add @x402/xrpl
```

## Overview

This package provides three components for x402 payments on XRPL:

- **Client** - Builds and signs XRPL `Payment` transactions.
- **Server** - Builds XRPL payment requirements and invoice ids.
- **Facilitator** - Verifies signed XRPL transactions and submits them for settlement.

The payer signs a complete XRPL `Payment` transaction and pays the XRPL transaction fee, so `extra.areFeesSponsored` is always `false`; facilitator-sponsored fees are not supported by this scheme.

## Package Exports

### Main Package (`@x402/xrpl`)

- `createXrplWalletSigner(wallet)` - Creates a client signer from an `xrpl` `Wallet`.
- `createTickets(signer, network, ticketCount)` - Creates XRPL Tickets for `ticketSequence` payments.
- `getXrplTicketSequences(account, network)` - Lists an account's available ticket sequences.
- `invoiceIdToInvoiceIdField(invoiceId)` - Converts an invoice id to an XRPL `InvoiceID`.
- XRPL network constants: `XRPL_MAINNET`, `XRPL_TESTNET`, `XRPL_DEVNET`.

### Subpath Exports

- `@x402/xrpl/exact/client` - `ExactXrplScheme` client implementation.
- `@x402/xrpl/exact/server` - `ExactXrplScheme` server implementation.
- `@x402/xrpl/exact/facilitator` - `ExactXrplScheme` facilitator implementation.

## Supported Networks

- `xrpl:0` - XRPL mainnet.
- `xrpl:1` - XRPL testnet.
- `xrpl:2` - XRPL devnet.
- `xrpl:<networkId>` - Custom XRPL networks with numeric `NetworkID`.

## Asset Support

- Native XRP: `asset` is `"XRP"` and `amount` is an integer drops string (1 XRP = 1,000,000 drops).
- XRPL issued currencies (IOUs): `asset` is the currency code (3-character or 40-hex), `amount` is the exact XRPL issued-currency decimal `value` string (for example `"10.5"`), and `extra.issuer` is the issuer classic address.

There is no `extra.decimals` field: XRPL issued-currency amounts are ledger decimal values, so the requirement `amount` is used verbatim as the signed `value`. XRPL exact payments use explicit `AssetAmount` pricing; dollar-string default asset mapping is not included for XRPL.

## Asset Transfer Methods

`extra.assetTransferMethod` selects how the signed transaction is sequenced:

- `"sequence"` (default) - consumes the payer account's current `Sequence`. No preflight transaction and no extra reserve, but the account supports only one pending payment at a time.
- `"ticketSequence"` - consumes a pre-created XRPL [Ticket](https://xrpl.org/docs/concepts/accounts/tickets) (`Sequence = 0` plus `TicketSequence`), allowing multiple concurrent pending payments per account.

The client follows the method pinned in the payment requirements and defaults to `"sequence"`. Resource servers offer `"ticketSequence"` by advertising it in `extra.assetTransferMethod` (optionally as a second `accepts` entry so clients can choose either method).

For `"ticketSequence"` payments, the client automatically creates one ticket when none is
available. Set `ticketCreateCount` to create more at once, or to `0` to disable automatic creation.
To provision ticket inventory explicitly:

```typescript
import { Wallet } from "xrpl";
import { createTickets, createXrplWalletSigner } from "@x402/xrpl";

const wallet = Wallet.fromSeed(process.env.XRPL_SEED!);
const signer = createXrplWalletSigner(wallet);
const ticketSequences = await createTickets(signer, "xrpl:1", 5);
```

Each outstanding ticket locks owner reserve (currently 0.2 XRP on mainnet) until it is used or deleted, and an account can hold at most 250 outstanding tickets.

## Testnet Setup

1. Create and fund a payer account with the [XRPL Testnet faucet](https://xrpl.org/resources/dev-tools/xrp-faucets) (`wss://s.altnet.rippletest.net:51233`, network `xrpl:1`).
2. Keep the [base and owner reserves](https://xrpl.org/docs/concepts/accounts/reserves) funded: accounts need the base reserve (currently 1 XRP) plus 0.2 XRP owner reserve per outstanding ticket.
3. For issued-currency (IOU) payments, the receiving account must hold a [trust line](https://xrpl.org/docs/concepts/tokens/fungible-tokens) to the issuer, and the payer needs a sufficient issued-currency balance.
4. The facilitator needs no funded account: the payer signs and pays the XRPL transaction fee, and the facilitator only reads ledger state and submits the signed blob.

## Usage

### Client

```typescript
import { Wallet } from "xrpl";
import { x402Client } from "@x402/core/client";
import { createXrplWalletSigner } from "@x402/xrpl";
import { ExactXrplScheme } from "@x402/xrpl/exact/client";

const wallet = Wallet.fromSeed(process.env.XRPL_SEED!);
const signer = createXrplWalletSigner(wallet);

const client = new x402Client().register("xrpl:*", new ExactXrplScheme(signer));
```

The default client uses `xrpl.Client` to autofill ledger-derived fields before signing:

- `Sequence` (or `Sequence = 0` plus an available `TicketSequence` for ticket payments)
- `Fee`
- `LastLedgerSequence`
- `NetworkID` for custom XRPL networks

Use `wsUrlByNetwork` or `clientFactory` to customize the XRPL connection, and `feeDrops` only when the client should use an explicit fee instead of the network autofill value. If a wallet or application prepares transactions externally, pass `preparePaymentTransaction`; the returned transaction must satisfy the selected asset transfer method, and include `Fee`, `LastLedgerSequence`, and the correct custom-network `NetworkID` when applicable.

For `"ticketSequence"` payments, `ticketCreateCount` controls automatic ticket creation when the
account has no available tickets. It defaults to `1`; set it to `0` to require pre-provisioned
tickets.

While a `"sequence"` payment is pending, the payer account should not sign or submit other transactions until the payment settles or its `LastLedgerSequence` passes; consuming the sequence elsewhere permanently invalidates the payment.

### Server

```typescript
import { x402ResourceServer } from "@x402/core/server";
import { ExactXrplScheme } from "@x402/xrpl/exact/server";

const server = new x402ResourceServer(facilitatorClient);
server.register("xrpl:*", new ExactXrplScheme());
```

Use explicit asset pricing:

```typescript
{
  scheme: "exact",
  price: {
    amount: "1000000",
    asset: "XRP"
  },
  network: "xrpl:1",
  payTo: "r...",
}
```

The server scheme adds `extra.areFeesSponsored: false` to the advertised requirements. Invoice binding is enforced when the resource configuration provides `extra.invoiceId`; requirements are rebuilt for every request, so the scheme never injects per-request values.

### Facilitator

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactXrplScheme } from "@x402/xrpl/exact/facilitator";

const facilitator = new x402Facilitator().register("xrpl:*", new ExactXrplScheme());
```

Verification enforces the spec's checks: envelope consistency, offline signature validation, signer-to-account authorization (the embedded `SigningPubKey` must be the account's master key pair, unless disabled, or its configured regular key), destination and amount matching, NetworkID binding, per-method sequencing (current account `Sequence`, or ticket availability), `LastLedgerSequence` expiry policy, invoice binding via `InvoiceID`, fee caps, safety rejections (`Delegate`, `Memos`, `Paths`, `DeliverMin`, partial payments, multisigned blobs), and an XRPL simulation. Settlement re-runs verification, submits the signed blob, and succeeds only on a validated `tesSUCCESS` result.

## Duplicate Settlement Protection

This package includes a built-in `SettlementCache` that prevents a race condition where the same signed payment could be settled multiple times before its on-chain effects become visible: XRPL submission is idempotent on the transaction hash, so `submitAndWait` for an already-submitted blob resolves with the same validated `tesSUCCESS` outcome instead of failing.

The cache rejects concurrent `/settle` calls that carry the same signed transaction blob, returning a `duplicate_settlement` error for the second and subsequent attempts. Entries are keyed on the signed transaction hash and retained for the transaction's landable window — sized from the payment's `maxTimeoutSeconds` (which bounds its `LastLedgerSequence`) — so an entry cannot be evicted while a slow-to-validate duplicate could still pass re-verification. Because entries are not cleared on failure, a `duplicate_settlement` result means the transaction was already seen, not that it settled.

**No additional configuration is required** — each `ExactXrplScheme` facilitator instance creates its own cache by default. Pass a shared `SettlementCache` as the second constructor argument if you register several scheme instances that should block each other's duplicates. This is a per-process guard: a horizontally scaled facilitator must back it with a shared atomic store so duplicates routed to different replicas are still caught.

For full details on the race condition and mitigation strategy, see the [Exact XRPL Scheme Specification](../../../../specs/schemes/exact/scheme_exact_xrpl.md#duplicate-settlement-mitigation-required).

## Development

```bash
pnpm build
pnpm test
pnpm test:integration
pnpm lint:check
```

For protocol details, see [`scheme_exact_xrpl.md`](../../../../specs/schemes/exact/scheme_exact_xrpl.md).

## License

Apache-2.0
