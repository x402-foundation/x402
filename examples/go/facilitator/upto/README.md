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
