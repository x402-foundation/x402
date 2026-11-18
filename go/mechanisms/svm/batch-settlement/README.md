# Batch-Settlement SVM Scheme

The **batch-settlement** scheme enables high-throughput payments on Solana. The client deposits once into a payment-channels escrow, then pays for many requests without an onchain transaction per call. The resource server verifies each authorization offchain, serves immediately, and redeems accumulated vouchers later through the facilitator.

Two voucher modes share the same channel lifecycle:

| Mode | Who signs vouchers | Per-request wire payload | Typical use |
|------|-------------------|--------------------------|-------------|
| **Client-signed** (default) | Client (`payerAuthorizer`) | Cumulative Ed25519 voucher | Fixed price per request; client retains full voucher authority |
| **Server-signed** | Resource `operator` | Expiring payer proof + request id; operator signs the metered cumulative charge after serving | Usage-based billing without a client signature on every request |

In server mode the channel's onchain `authorized_signer` is the operator, who could claim the full unspent deposit. Clients enter that mode only for operator keys listed in `ServerSignedChannelsPolicy`, with escrow capped by `MaxDeposit` (default `$1` for default assets). An untrusted server-signed accept is refused; when the same route also offers client-signed, the scheme falls back automatically.

Uses the same payment-channels program as SVM `upto`. `upto` is a one-request channel that closes after one metered charge; **batch-settlement** keeps the channel open, advances a cumulative watermark across requests, and batches redemption.

## Import Paths

| Role | Import |
|------|--------|
| Client | `github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/client` |
| Server | `github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/server` |
| Facilitator | `github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/facilitator` |

## Client Usage

Register `BatchSvmScheme` with an `x402Client`. The SDK opens or tops up the channel on first use, tracks cumulative spend locally, and attaches the correct payload (`voucher` or `authorization`) per mode.

```go
signer, err := batchclient.NewPrivateKeySigner(os.Getenv("SVM_PRIVATE_KEY"))
if err != nil {
    return err
}
multiplier := 5
batch, err := batchclient.NewBatchSvmScheme(signer, &batchclient.BatchSvmClientConfig{
    DepositPolicy: &batchclient.DepositPolicy{DepositMultiplier: &multiplier},
    RPCURL:        os.Getenv("SVM_RPC_URL"),
})
if err != nil {
    return err
}

payer := x402.Newx402Client()
payer.Register("solana:*", exactClient) // fixed-price services
payer.Register("solana:*", batch)
```

`NewPrivateKeySigner` takes a base58 secret key. It signs both the deposit transaction and the Ed25519 voucher or payer authorization.

### Deposit sizing

When a channel needs funding or top-up, the client targets:

1. `extra.minDeposit` when the server announced a valid hint (`>=` per-request `amount`)
2. otherwise `amount × depositMultiplier` (default 5, minimum 3)

`x402Client` spend controls still cap each request's `PaymentRequirements.Amount`. The same resolved cap scales the escrow ceiling when a spend cap is set.

### Client-signed channels

No extra client configuration is required. Each paid request carries a cumulative voucher signed by the payer (or a dedicated voucher key equal to `payerAuthorizer`). The per-request charge equals `PaymentRequirements.Amount`.

### Server-signed channels (trusted operator)

Opt in explicitly. List operators you trust out of band and cap escrow per channel:

```go
batch, err := batchclient.NewBatchSvmScheme(signer, &batchclient.BatchSvmClientConfig{
    ServerSignedChannelsPolicy: &batchclient.BatchServerSignedChannelsPolicy{
        AllowedOperators: []string{"OperatorBase58Pubkey"},
        MaxDeposit:       "$1", // USD cap for default assets; use AllowedAssets for other mints
    },
})
payer.Register("solana:*", batch)
payer.RegisterPolicy(batch.PaymentPolicy())
```

`DisableMaxDeposit: true` lifts the USD cap for default assets. `AllowedAssets` entries take an atomic `MaxDeposit`, not a dollar amount.

If a 402 advertises `extra.voucherSigner: "server"` for an operator not in `AllowedOperators`, payment creation fails with `UntrustedOperatorError`. The scheme implements `x402.PaymentCreationFailureHandler` and retries the same resource's `extra.voucherSigner: "client"` accept when the caller attached the full challenge with `x402.WithPaymentRequired`. The HTTP and MCP clients do that.

### Cooperative refund

Return unused escrow without waiting for `withdrawDelay` when the server and facilitator cooperate. The close is for the whole unused balance; there is no partial amount.

```go
settled, err := batch.Refund(ctx, "https://api.example.com/protected-route", nil)
```

Pass `BatchRefundOptions.Requirements` to skip the unpaid probe, or `HTTPClient` to supply the transport. A missing receiver binding is retried once with a payer-signed `request_close`.

### Persistence

Channel allocations default to in-memory. Implement `BatchClientChannelStorage` so a restart reuses the same channel and can replay a pending payment. `Salt` defaults to 0, which reopens the same channel PDA. Set `DiscoverChannels` to a non-nil false pointer to skip the onchain scan.

## Server Usage

Register `BatchSvmScheme` with an `x402ResourceServer`. The server owns the offchain voucher watermark: verify reserves capacity, the handler runs, and settle commits the charge and stores the latest voucher for redemption.

### Receiver authorizer

Every channel is bound at `open` to `extra.receiverAuthorizer` via an onchain Memo. That key signs cooperative `CloseAuthorization` messages for refunds and for sealing channels the payer is closing.

- **Self-managed**: pass `ReceiverAuthorizer` in `Config`. Advertised as `extra.receiverAuthorizer`; must match the binding Memo the client includes at open.
- **Facilitator-delegated**: omit `ReceiverAuthorizer`. Copy `extra.receiverAuthorizer` from the facilitator's supported advertisement. Cooperative closes authenticate the caller identity at the facilitator instead of a local `CloseAuthorization`.

```go
delay := 86400
resource.Register(svm.SolanaDevnetCAIP2, batchserver.NewBatchSvmScheme(&batchserver.Config{
    ReceiverAuthorizer: authorizer,
    WithdrawDelay:       &delay,
    Store:               batchserver.NewMemoryChannelStore(),
}))
```

### Client-signed routes

Omit `Operator`. Routes advertise batch-settlement without `extra.voucherSigner` (client mode). Charge is fixed to the route price.

### Server-signed routes (metered)

Configure an `Operator` signer. Once set, batch routes default to server mode and advertise `extra.operator` and `extra.voucherSigner: "server"`. Pin a route back to client mode with `extra.voucherSigner: "client"` so untrusted clients can still pay the ceiling with their own vouchers.

```go
resource.Register(svm.SolanaDevnetCAIP2, batchserver.NewBatchSvmScheme(&batchserver.Config{
    ReceiverAuthorizer: authorizer,
    Operator:            operator,
    Store:               batchserver.NewMemoryChannelStore(),
}))
```

Settlement overrides use the same amount formats as upto: raw atomic units (`"50000"`), a percentage of the ceiling (`"50%"`), or a dollar price (`"$0.05"`) when the route was priced in dollars.

### Redemption worker

Vouchers are worthless until claimed onchain. Start `BatchChannelManager` outside the request path to claim batches and distribute payouts:

```go
manager, err := scheme.CreateChannelManager(facilitatorClient, requirements, batchserver.BatchChannelManagerConfig{
    RPCURL: os.Getenv("SVM_RPC_URL"),
})
```

`requirements` must include `extra.feePayer` from the facilitator's supported kind. Claim promptly: if the facilitator or payer forces a close before the latest voucher is claimed, unclaimed value returns to the payer.

## Facilitator Usage

```go
scheme := batchfacilitator.NewBatchSvmScheme(context.Background(), svmSigner, &batchfacilitator.Config{
    ChannelStorage: storage, // paymentchannels.PaymentChannelStorage; nil defaults to in-memory
    // Optional delegated closes. ReceiverAuthorizer is an address this
    // facilitator does not sign with. A channel bound to that address
    // authenticates seal and cooperative refund by caller identity.
    // The identity from ResolveCallerIdentity is stored on the channel row.
    // DelegatedReceiverAuth: &batchfacilitator.DelegatedReceiverAuth{...},
})
facilitator.Register([]x402.Network{svm.SolanaDevnetCAIP2}, scheme)

cleanup := scheme.CreateRentCleanupManager(svm.SolanaDevnetCAIP2)
```

`ChannelStorage` defaults to an in-memory store. The same channel row holds the lifecycle index, the receiver-authorizer binding, and the delegated caller identity. Opens, top-ups, claims, and distributions record that row before broadcast and do not send if the write fails. A failed open reverts a row that call created; activity writes are kept. `ReceiverBindingHistoryReader` is an optional fallback for a row with no binding, used only when set here. A binding read from history is written back when the row is absent. `DelegatedReceiverAuth` requires `ResolveCallerIdentity`; that identity is stored on the channel row.

`GetExtra` advertises `feePayer` and, when idle cleanup is enabled, `maxIdleSecs`. It advertises `receiverAuthorizer` only when `DelegatedReceiverAuth` is set. `withdrawDelay` comes from the server. Production deployments should use a durable pending-settlement store and shared channel storage when running multiple replicas.

## Supported Networks

Works on Solana networks where the payment-channels program is deployed:

| Network | CAIP-2 ID |
|---------|-----------|
| Solana Mainnet Beta | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| Solana Devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` |

Canonical program id: `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`

## How It Works

1. Server advertises `scheme: "batch-settlement"` with per-request price, plus `extra.receiverAuthorizer`, `extra.withdrawDelay`, and (in server mode) `extra.operator` / `extra.voucherSigner: "server"`
2. Facilitator advertises `extra.feePayer` and optional `extra.maxIdleSecs`
3. Client signs `open` (or top-up) with the receiver-binding Memo; facilitator broadcasts the deposit before the handler
4. Each request: client mode sends a cumulative voucher; server mode sends a payer authorization and the operator signs the metered cumulative voucher after serving
5. Server verifies offchain, serves, and accumulates the latest voucher locally
6. `BatchChannelManager` submits claim and distribute through the facilitator
7. Cooperative refund or payer `request_close` returns unused escrow; rent cleanup reclaims abandoned channel PDAs
