# Batch-Settlement EVM Scheme (`go/mechanisms/evm/batched`)

The **batch-settlement** scheme enables high-throughput, low-cost EVM payments via **stateless unidirectional payment channels**. Clients deposit funds into an on-chain escrow once, then sign off-chain **cumulative vouchers** per request. Servers verify vouchers with a fast signature check and claim them on-chain in batches at their discretion.

A single claim transaction can cover many channels at once, and claimed funds are swept to the receiver in a separate `settle` step. The scheme also supports **dynamic pricing**: the client authorizes a max per-request and the server charges only what was actually used.

See the [scheme specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md) for full protocol details.

## Import Paths

| Role        | Import                                                                       |
|-------------|------------------------------------------------------------------------------|
| Client      | `github.com/x402-foundation/x402/go/mechanisms/evm/batched/client`           |
| Server      | `github.com/x402-foundation/x402/go/mechanisms/evm/batched/server`           |
| Facilitator | `github.com/x402-foundation/x402/go/mechanisms/evm/batched/facilitator`      |

## Client Usage

Register `BatchedEvmScheme` with an `x402Client`. The client handles deposit, voucher signing, channel-state recovery, and corrective 402 resync transparently.

```go
import (
    x402 "github.com/x402-foundation/x402/go"
    "github.com/x402-foundation/x402/go/mechanisms/evm/batched/client"
    evmsigners "github.com/x402-foundation/x402/go/signers/evm"
)

signer, _ := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("EVM_PRIVATE_KEY"))

scheme := client.NewBatchedEvmScheme(signer, &client.BatchedEvmSchemeConfig{
    MaxDeposit:        "1000000",
    DepositMultiplier: 5,
})

c := x402.Newx402Client()
c.Register("eip155:*", scheme)
```

### Deposit Policy

Controls how much the client deposits when the channel needs funding:

| Field               | Description |
|---------------------|-------------|
| `DepositMultiplier` | Per-request `amount × multiplier` is deposited (default 10) |
| `MaxDeposit`        | Hard cap on a single deposit (atomic units) |
| `AutoTopUp`         | Re-deposit automatically when balance is insufficient (default `true`; pass `*bool` to disable) |

### Voucher Signer Delegation

By default, vouchers are signed by the same key as the payer. For better performance — especially when the payer is a **smart wallet** (EIP-1271) — delegate voucher signing to a dedicated EOA. The scheme commits this address as the channel's `payerAuthorizer`, so the facilitator can verify vouchers via fast ECDSA recovery instead of an on-chain `isValidSignature` RPC.

```go
voucherSigner, _ := evmsigners.NewClientSignerFromPrivateKey(voucherKey)
scheme := client.NewBatchedEvmScheme(signer, &client.BatchedEvmSchemeConfig{
    VoucherSigner: voucherSigner,
})
```

### Cooperative Refund

Request the server to refund the unclaimed balance on the next request:

```go
scheme.RequestRefund(channelId)
```

The server claims any outstanding vouchers and then executes `refundWithSignature` to return `balance - totalClaimed` to the payer.

### Persistence

By default, channel state is stored in memory. For long-lived clients, use `FileClientSessionStorage`:

```go
import "github.com/x402-foundation/x402/go/mechanisms/evm/batched"

scheme := client.NewBatchedEvmScheme(signer, &client.BatchedEvmSchemeConfig{
    Storage: client.NewFileClientSessionStorage(batched.FileSessionStorageOptions{
        Directory: "./channels",
    }),
})
```

If state is lost, the client recovers from on-chain `channels(channelId)` plus corrective 402s — see the spec's *Recovery After State Loss* section.

## Server Usage

Register the scheme with an `x402ResourceServer` and pair it with a `ChannelManager` to handle batched claims, settlements, and refunds.

```go
import (
    x402 "github.com/x402-foundation/x402/go"
    "github.com/x402-foundation/x402/go/mechanisms/evm/batched"
    "github.com/x402-foundation/x402/go/mechanisms/evm/batched/server"
)

scheme := server.NewBatchedEvmScheme(receiverAddress, &server.BatchedEvmSchemeConfig{
    ReceiverAuthorizerSigner: receiverAuthorizerSigner, // optional: self-managed authorizer (recommended)
    WithdrawDelay:            900,                       // 15 min – 30 days
    Storage: server.NewFileSessionStorage(batched.FileSessionStorageOptions{
        Directory: "./sessions",
    }),
})

srv := x402.Newx402ResourceServer().Register("eip155:84532", scheme)

manager := scheme.CreateChannelManager(facilitatorClient, "eip155:84532")
manager.Start(server.AutoSettlementConfig{
    ClaimIntervalSecs:   60,
    ClaimOnWithdrawal:   true,  // race the client's withdraw delay
    SettleIntervalSecs:  300,
    RefundOnIdleSecs:    3600,
})

// On shutdown, drain pending claims:
defer manager.Stop(ctx, true /* flush */)
```

### Receiver Authorizer

The `receiverAuthorizer` signs `ClaimBatch` and `Refund` EIP-712 messages and is committed into the channel's identity at deposit time:

- **Self-managed** (recommended): pass a `ReceiverAuthorizerSigner` (an EOA you control). Channels survive facilitator changes — any facilitator can relay your signed claims and refunds.
- **Facilitator-delegated**: omit `ReceiverAuthorizerSigner`. The scheme picks up `extra.receiverAuthorizer` advertised by the facilitator's `/supported`. Switching facilitators requires opening **new channels**, so existing channels should be drained first via `ClaimAll()` and `RefundAll()`.

### Pricing

Set the route `price` to the per-request maximum. To bill less than the max, use the standard x402 settlement-override mechanism for your HTTP framework — see the framework adapter's documentation.

## Facilitator Usage

```go
import (
    x402 "github.com/x402-foundation/x402/go"
    "github.com/x402-foundation/x402/go/mechanisms/evm/batched/facilitator"
)

f := x402.Newx402Facilitator()
f.Register(
    []x402.Network{"eip155:84532"},
    facilitator.NewBatchedEvmScheme(evmSigner, authorizerSigner),
)
```

The `authorizerSigner` produces the EIP-712 signatures advertised in `/supported.kinds[].extra.receiverAuthorizer`. Servers may delegate to it (see above) or supply their own. The `evmSigner` (the wallet account) submits transactions for `deposit`, `claimWithSignature`, `settle`, and `refundWithSignature` — anyone can submit a valid claim/refund tx, but only the configured signer here will be used by this facilitator.

## Supported Networks

| Network      | CAIP-2 ID       |
|--------------|-----------------|
| Base Mainnet | `eip155:8453`   |
| Base Sepolia | `eip155:84532`  |

Requires the x402 batch-settlement contract deployed on the target network.

## Asset Transfer Methods

Deposits use one of two on-chain transfer methods, controlled by `extra.assetTransferMethod`:

| Method     | Description |
|------------|-------------|
| `eip3009`  | `receiveWithAuthorization` — for tokens that support EIP-3009 (e.g. USDC). Default. |
| `permit2`  | Universal fallback for any ERC-20 via Uniswap Permit2. |

Deposits are sponsored by the facilitator (gasless for the client).

## Examples

- [Client example](../../../../../examples/go/clients/batch-settlement)
- [Server example](../../../../../examples/go/servers/batch-settlement)
- [Facilitator example](../../../../../examples/go/facilitator/batch-settlement)

## See Also

- [Batch-Settlement EVM Scheme Specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md)
