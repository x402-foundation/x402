# Upto Facilitator Example (SVM)

A Gin facilitator for the **`upto`** scheme on Solana Devnet. It co-signs and
broadcasts the client's payment-channel `open` at deposit time, then settles
only the metered amount the resource server vouches for.

It also runs [`RentCleanupManager`](../../../../go/mechanisms/svm/upto/facilitator/rent_cleanup.go)
against the scheme's channel storage on an interval, so abandoned Open channels
are sealed, Sealed ones are distributed, and rent is batch-reclaimed from
Distributed PDAs.

Pair it with [`servers/upto/`](../../servers/upto/) for a full usage-based
billing flow. For EVM `upto`, see [`facilitator/basic/`](../basic/), which
registers the EVM upto scheme alongside `exact`.

## Prerequisites

- Go 1.24+
- A Solana Devnet key with SOL. The facilitator fronts channel rent and pays
  every transaction fee; it holds the channel payee seat with a **zero**
  distribution share, so it needs no token balance.

**Security:** this key signs onchain settlement. Keep it separate from seller
`payTo` wallets and fund it only for gas.

## Setup

```bash
cp .env-example .env
# set SVM_PRIVATE_KEY

go run .
```

Default listen address: `http://localhost:4022` (`PORT` to override).

## Rent cleanup

The scheme records each sponsored channel in its `ChannelStorage` at settle
time; cleanup reads that store rather than scanning the chain. Sealing an
abandoned channel freezes the settlement watermark and refunds the unsettled
remainder to the client, so cleanup only acts after the voucher deadline plus a
grace period.

| Env var                           | Default | Purpose                                                 |
| --------------------------------- | ------- | ------------------------------------------------------- |
| `RENT_CLEANUP_INTERVAL_SECS`      | `300`   | Seconds between cleanup passes                          |
| `RENT_CLEANUP_ABANDON_GRACE_SECS` | `120`   | Grace after voucher expiry before abandon-close         |
| `MAX_CHANNEL_LIFETIME_SECS`       | `3600`  | Max channel lifetime accepted at verify/deposit         |

For production, inject a durable `ChannelStorage` via `uptosvm.Config` so
cleanup survives restarts and works across facilitator replicas:

```go
scheme := uptosvm.NewUptoSvmScheme(signer, &uptosvm.Config{
    ChannelStorage: myPostgresChannelStorage,
    RPCURL:         rpcURL,
})
```

## SVM receiver authorizer (optional delegation)

This example registers `UptoSvmScheme` with a **fee payer only** — no
`AuthorizerSigner` is configured, so `/supported` advertises `extra.feePayer`
but not `extra.receiverAuthorizer`. Servers must sign their own claim vouchers
(self-managed mode).

To let resource servers delegate voucher signing to your facilitator, extend
the SVM registration with a separate Ed25519 key and a `ResolveCallerIdentity`
hook. Delegation is not negotiated in x402 — it requires an out-of-band
agreement with each resource server, and authenticated settle requests so
claim vouchers are signed only for that server.

| Signer | Role | Onchain effect |
| ------ | ---- | -------------- |
| `SVM_PRIVATE_KEY` | **Fee payer** — co-signs channel `open`, submits claim/cleanup txs | Pays SOL for opens, settlement, and rent cleanup |
| `AuthorizerSigner` (optional) | **Receiver authorizer** — signs claim vouchers when servers delegate | Committed as the channel `authorized_signer` for delegating servers |

When `AuthorizerSigner` is set, `GET /supported` includes both `feePayer` and
`receiverAuthorizer`:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "upto",
      "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "extra": {
        "feePayer": "...",
        "receiverAuthorizer": "..."
      }
    }
  ]
}
```

Wire it in your facilitator:

```go
authorizer, err := svmsigners.NewReceiverAuthorizerSignerFromPrivateKey(
    os.Getenv("SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY"),
)

scheme := uptosvm.NewUptoSvmScheme(signer, &uptosvm.Config{
    ChannelStorage:            channelStorage,
    MaxChannelLifetimeSecs:    &maxChannelLifetimeSecs,
    AuthorizerSigner:          authorizer,
    ResolveCallerIdentity:     resolveCallerIdentity, // JWT / SIWX / mTLS subject
    // Optional for multi-replica facilitators; default is in-memory.
    // DelegatedAuthStore: sharedRedisDelegatedAuthStore,
})
```

> ⚠️ A facilitator that advertises `receiverAuthorizer` **must** authenticate
> that each claim settle comes from the same service whose deposit settle
> opened the channel (SIWX, JWT, mTLS, or an API credential correlated across
> both settles). The scheme records that identity at deposit and requires an
> exact match at claim. **Do not advertise `receiverAuthorizer` without real
> authentication.** The default identity binding store is in-memory; inject a
> shared `DelegatedAuthStore` for multi-replica facilitators.

## API endpoints

The standard x402 facilitator surface: `POST /verify`, `POST /settle`,
`GET /supported`. Only the `upto` scheme is registered.

## Full stack

```bash
# Terminal 1 — facilitator (this example)
go run .

# Terminal 2 — resource server
cd ../../servers/upto
SVM_PAYEE_ADDRESS=<base58> \
SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY=<base58> \
FACILITATOR_URL=http://localhost:4022 go run .

# Terminal 3 — client
cd ../../clients/http
RESOURCE_SERVER_URL=http://localhost:4021 ENDPOINT_PATH=/api/generate go run .
```
