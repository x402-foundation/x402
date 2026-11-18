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

- Go 1.26.10+
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

By default this example registers `UptoSvmScheme` with a **fee payer only** — no
`AuthorizerSigner`, so `/supported` advertises `extra.feePayer` but not
`extra.receiverAuthorizer`. [`servers/upto/`](../../servers/upto/) without a
local `SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` delegates to whatever
`receiverAuthorizer` the facilitator advertises and fails fast at startup if
none is offered.

Advertise delegation only when you can **authenticate resource-server settle
requests out of band** (SIWX, JWT, mTLS, API credentials correlated across
deposit and claim, and so on). You must pass an `AuthorizerSigner` and
implement `ResolveCallerIdentity` so each delegated deposit/claim settle
resolves to a stable caller identity; the scheme records that identity on the
channel storage row at deposit and rejects claim settles that do not match.
**Do not advertise `receiverAuthorizer` without that authentication.** This
example does not configure delegation — wire it in your own facilitator as
sketched below.

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
authorizer, err := svmsigners.NewReceiverAuthorizerSignerFromPrivateKey(/* dedicated Ed25519 key */)

scheme := uptosvm.NewUptoSvmScheme(signer, &uptosvm.Config{
    ChannelStorage:         channelStorage,
    MaxChannelLifetimeSecs: &maxChannelLifetimeSecs,
    AuthorizerSigner:       authorizer,
    ResolveCallerIdentity:  resolveCallerIdentity, // out-of-band auth — your implementation
})

// Authenticate the resource server, then call Verify/Settle with that identity
// available to ResolveCallerIdentity (deposit and claim must see the same value).
```

Delegated caller identity is stored on the same `ChannelStorage` row as the
channel (default in-memory). Use durable, shared `ChannelStorage` when more
than one facilitator replica can settle the same channel.

## API endpoints

The standard x402 facilitator surface: `POST /verify`, `POST /settle`,
`GET /supported`. Only the `upto` scheme is registered.

## Full stack

```bash
# Terminal 1 — facilitator (this example)
go run .

# Terminal 2 — resource server (self-managed authorizer key, or omit key to delegate)
cd ../../servers/upto
SVM_PAYEE_ADDRESS=<base58> \
FACILITATOR_URL=http://localhost:4022 go run .

# Terminal 3 — client
cd ../../clients/http
RESOURCE_SERVER_URL=http://localhost:4021 ENDPOINT_PATH=/api/generate go run .
```
