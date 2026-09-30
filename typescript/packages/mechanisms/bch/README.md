# `@x402/bch`

Bitcoin Cash support for x402 v2 `exact` payments. BCH payments carry a
complete, client-signed transaction rather than an account authorization.

The public x402 network identifiers are `bch:bitcoincash` (mainnet) and
`bch:bchtest` (Chipnet). The wallet-facing transaction request uses the
corresponding network names `mainnet` and `chipnet`.

The package supports native BCH and CashTokens, including fungible tokens and
NFTs, with P2PKH, P2SH20, and P2SH32 payment outputs. Libauth is used for BCH
transaction parsing, serialization, signing serialization, CashToken data, and
address/script handling. CashScript contracts are represented by their
compiled locking bytecode; x402 pays the contract output but does not execute
or validate the contract's later spending conditions.

## BCH transaction model

Unlike account-based networks, BCH does not have a balance, nonce, or
facilitator-side transfer call. A wallet must construct a state transition:

```text
consume selected UTXOs
  -> merchant output (BCH and optional CashToken state)
  -> BCH change output
  -> token change output, when required
  -> miner fee
```

The wallet owns UTXO discovery, selection and reservation, fee calculation,
change-address selection, signing, and broadcast. The x402 client owns the
payment protocol and validates the wallet's returned transaction before
placing it in the payment payload. Mnemonics and private keys remain inside
the wallet adapter and are not part of the x402 client API.

The facilitator fetches authoritative source outputs from its provider and
checks input/output value, token conservation, signatures, network, payment
output, fee/dust policy, and transaction identity before broadcasting the
same raw transaction. It does not add inputs, rewrite outputs, or create BCH
change after signing.

## Client

```ts
import type { BchWallet } from '@x402/bch';
import { ExactBchScheme } from '@x402/bch/exact/client';

client.register('bch:*', new ExactBchScheme(signer, provider));
```

For a low-level integration, `BchSigner` signs BCH sighash digests and
`BchProvider` supplies UTXOs and authoritative source outputs. For a normal
wallet integration, implement `BchWallet.createPayment(request)` and let the
wallet perform the complete transaction construction and signing:

```ts
const wallet: BchWallet = {
  async createPayment(request) {
    // Select and reserve UTXOs, add BCH/token change, and sign locally.
    return walletBackend.createSignedBchTransaction(request);
  },
};

const clientScheme = new ExactBchScheme(wallet, provider);
client.register('bch:*', clientScheme);
```

`BchTransactionRequest` contains `network`, `recipient.address`, BCH
`amount` in satoshis, and an optional CashToken request. For a fungible token,
`token` contains a category and atomic amount. For an NFT it additionally
contains `nft.capability` (`none`, `mutable`, or `minting`) and its commitment.
The BCH value attached to a token output is wallet policy and must satisfy BCH
dust/standardness requirements.

`BchSigner` is retained for integrations that already own UTXO selection and
transaction construction. `FulcrumProvider` implements the Electrum Cash
JSON-RPC boundary. Facilitators should inject a shared `BchSettlementStore`
when running more than one process.

The adapter accounts for Fulcrum's two amount encodings: verbose transaction
outputs are BCH decimal values, while blockchain.scripthash.listunspent returns
integer satoshis.

The package test suite includes `test/fixtures/bch-exact-p2pkh.json`, a
deterministic native-BCH P2PKH payment fixture shared with the Rust
`x402-chain-bch` implementation. It covers the serialized transaction, source
output, merchant amount, payer, transaction ID, and fee so integrations can
compare results across both SDKs.

## Electrum endpoint redundancy

The `FulcrumProvider` accepts an injected `FulcrumTransport`; it does not
silently select or trust a public server. For live deployments, applications
should configure a failover transport with more than one endpoint and prefer
TLS (port `50002`) or WSS (port `50004`) where available. The following set is
the BCH Electrum set referenced by CashScript's network-provider sources and
migration notes:

| Network | Endpoints                                                      |
| ------- | -------------------------------------------------------------- |
| Mainnet | `bch.imaginary.cash`, `blackie.c3-soft.com`, `electroncash.dk` |
| Chipnet | `chipnet.bch.ninja`                                            |

`FailoverFulcrumTransport` provides the minimum sequential failover behavior:
pass it caller-created transports in the desired order. It retries all
requests, including broadcasts; if a broadcast response is lost after the
server accepts a transaction, applications must reconcile the result by
checking transaction status rather than assuming the broadcast failed.

```ts
const transport = new FailoverFulcrumTransport([primaryTransport, secondaryTransport]);
const provider = new FulcrumProvider('bch:bitcoincash', transport);
```

Availability redundancy is not chain verification. A failover transport may
retry a request against another server, but applications should compare chain
tip/header data across independent servers when making operational decisions.

Endpoint availability and chain consistency are deployment concerns and should
be revalidated by each operator. Do not disable certificate validation for a
failover endpoint.

## Facilitator

```ts
import { ExactBchFacilitatorScheme } from '@x402/bch/exact/facilitator';

facilitator.register(
  'bch:*',
  new ExactBchFacilitatorScheme(provider, {
    settlementStrategy: { kind: 'confirmations', count: 1 },
  }),
);
```

Mempool/0-conf mode is opt-in. The `noDoubleSpendProof` strategy accepts an
unconfirmed transaction only while the provider reports no BCH double-spend
proof; a proof is conflict evidence, not confirmation.

## Server

```ts
import { ExactBchServerScheme } from '@x402/bch/exact/server';

server.register('bch:*', new ExactBchServerScheme());
```

Use `{ amount: '1000', asset: 'BCH' }` for a 1,000-satoshi native BCH price.
CashToken requirements use the token category as `asset` and describe the
fungible/NFT state in `extra.token` with
`extra.assetTransferMethod: 'cashtoken'`. Amounts are decimal strings in the
x402 wire objects; wallet-facing amounts are converted to `bigint`.

## Network and settlement notes

`bch:bitcoincash` and `bch:bchtest` are distinct networks. A mainnet address,
UTXO, provider, or transaction must never be reused for Chipnet. `maxTimeoutSeconds`
is an HTTP/resource acceptance window; it is not a BCH transaction expiry.

The facilitator can use mempool, no-double-spend-proof, or confirmation-count
settlement strategies. Mempool/0-conf acceptance is an explicit deployment
choice, not a confirmation. A broadcast whose status is temporarily unknown
must be reconciled by transaction ID rather than blindly rebuilt, because BCH
inputs are discrete outpoints and a retry can conflict with the original
transaction.

## Scope boundary

This package supports exact upfront payments. It does not turn x402 into a
general CashScript execution engine, provide facilitator fee sponsorship, or
implement account-style `upto` debits. PSBT, hardware-wallet transport,
WalletConnect, address discovery, UTXO reservation, and recovery from wallet
storage remain wallet/application responsibilities; the finalized raw
transaction is the x402 settlement object.
