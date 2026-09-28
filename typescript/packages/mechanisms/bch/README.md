# `@x402/bch`

Bitcoin Cash native exact payments for x402 v2.

The normative wire contract is documented in
[`scheme_exact_bch.md`](../../../../specs/schemes/exact/scheme_exact_bch.md).
The initial scheme uses `bch:bitcoincash` and `bch:bchtest`, native BCH in
satoshi units, fully prefixed CashAddr P2PKH recipients, and a finalized raw
transaction payload. Client transactions use `SIGHASH_ALL | SIGHASH_FORKID`
(`0x41`), a 1 satoshi/byte fee target, one merchant output, and one optional
non-dust change output.

CashTokens, CashScript, PSBT, sponsorship, alternate address formats, and
batch/debit settlement are not part of this package's initial exact mechanism.

## Client

```ts
import { ExactBchScheme } from '@x402/bch/exact/client';

client.register('bch:*', new ExactBchScheme(signer, provider));
```

`BchSigner` signs BCH sighash digests and reports its P2PKH address. `BchProvider`
supplies UTXOs and authoritative source outputs. `FulcrumProvider` implements
the Electrum Cash JSON-RPC boundary. Facilitators should inject a shared
`BchSettlementStore` when running more than one process.

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

Use `{ amount: '1000', asset: 'BCH' }` for a 1,000-satoshi price.
