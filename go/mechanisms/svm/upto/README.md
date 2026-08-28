# Upto SVM Scheme (Go)

The **upto** scheme enables usage-based billing on Solana. The client authorizes a **maximum** payment amount, but the server settles **only what was actually used**. This is ideal for variable-cost endpoints like LLM token generation, compute time, or bandwidth metering.

Uses the [payment-channels](https://github.com/solana-foundation/payment-channels) program. The client escrows the ceiling in an onchain channel; the server later settles the actual amount with a signed cumulative voucher. The facilitator sponsors fees and rent as a zero-share channel payee and can always close abandoned channels to recover that rent.

## Import Paths

| Role | Import |
|------|--------|
| Client | `github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto/client` |
| Server | `github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto/server` |
| Facilitator | `github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto/facilitator` |

## Client Usage

Register `UptoSvmScheme` with an `x402Client` to handle payments for services that use the `upto` scheme. From the buyer's perspective, usage is transparent — the SDK signs a max-authorization (the channel `open`) and the server charges only what was consumed.

```go
import (
    x402 "github.com/x402-foundation/x402/go/v2"
    exactsvm "github.com/x402-foundation/x402/go/v2/mechanisms/svm/exact/client"
    uptosvm "github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto/client"
    svmsigners "github.com/x402-foundation/x402/go/v2/signers/svm"
)

svmSigner, err := svmsigners.NewClientSignerFromPrivateKey(os.Getenv("SVM_PRIVATE_KEY"))

x402Client := x402.Newx402Client().
    Register("solana:*", exactsvm.NewExactSvmScheme(svmSigner)).      // fixed-price services
    Register("solana:*", uptosvm.NewUptoSvmScheme(svmSigner, nil))    // usage-based services
```

### Key Difference from Exact

The upto client requires `PaymentRequirements.Extra["feePayer"]` (from the facilitator's `GetExtra()`) and `Extra["receiverAuthorizer"]` (from the server). The client signs only the channel `open`; the facilitator co-signs as fee and rent payer, then later submits the settlement carrying the server's voucher.

Pass a `*svm.ClientConfig` with `RPCURL` to control which endpoint the client uses when the challenge omits the `recentBlockhash` / `recentSlot` hints.

## Server Usage

Register `UptoSvmScheme` with middleware and use `SetSettlementOverrides` in your handler to specify the actual charge. The server must supply a hot `ReceiverAuthorizerSigner` that signs settlement vouchers; that key never signs a transaction and needs no SOL or token balance.

```go
import (
    x402 "github.com/x402-foundation/x402/go/v2"
    x402http "github.com/x402-foundation/x402/go/v2/http"
    ginmw "github.com/x402-foundation/x402/go/v2/http/gin"
    uptosvm "github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto/server"
    svmsigners "github.com/x402-foundation/x402/go/v2/signers/svm"
)

authorizer, err := svmsigners.NewReceiverAuthorizerSignerFromPrivateKey(
    os.Getenv("SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY"),
)

r.Use(ginmw.X402Payment(ginmw.Config{
    Routes: x402http.RoutesConfig{
        "GET /api/generate": {
            Accepts: x402http.PaymentOptions{
                {
                    Scheme:  "upto",
                    Price:   "$0.10", // client authorizes up to 10 cents
                    Network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
                    PayTo:   "YourSolanaAddress",
                },
            },
            Description: "AI text generation - billed by token usage",
        },
    },
    Facilitator: facilitatorClient,
    Schemes: []ginmw.SchemeConfig{
        {
            Network: x402.Network("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"),
            Server: uptosvm.NewUptoSvmScheme(&uptosvm.Config{
                ReceiverAuthorizerSigner: authorizer,
                RPCURL:                   os.Getenv("SVM_RPC_URL"), // optional: embeds recentBlockhash/recentSlot in the 402
            }),
        },
    },
}))

// In your handler, settle the actual usage:
r.GET("/api/generate", func(c *gin.Context) {
    actualUsage := computeActualCost() // your billing logic
    ginmw.SetSettlementOverrides(c, &x402.SettlementOverrides{
        Amount: fmt.Sprintf("%d", actualUsage),
    })
    c.JSON(http.StatusOK, gin.H{"result": "..."})
})
```

`Config.WithdrawDelay` overrides the channel grace period in seconds; it defaults to the larger of 900 and the route's `MaxTimeoutSeconds`.

### Settlement Override Formats

The `Amount` in `SettlementOverrides` supports three formats:

| Format | Example | Description |
|--------|---------|-------------|
| Raw atomic units | `"50000"` | Settles exactly 50,000 atomic units |
| Percentage | `"50%"` | Settles 50% of the authorized maximum |
| Dollar price | `"$0.05"` | Converts to atomic units (when the route used `$` pricing) |

Setting `Amount` to `"0"` settles a zero-charge close: the channel is sealed and the whole deposit is refunded to the client. Unlike EVM upto, this still lands a transaction, because the escrowed deposit and the channel rent have to be released onchain.

### Escrow Payment Flow

SVM upto uses the escrow payment flow, so each request settles twice:

1. **Before the handler** — a deposit settle broadcasts the client's `open`, escrowing the authorized maximum.
2. **After the handler** — a claim settle seals the channel at the metered amount and distributes it.

The middleware drives both phases. If the handler fails, panics, or the request is canceled, the scheme settles a zero-amount refund instead of the claim.

## Facilitator Usage

For custom facilitator implementations:

```go
import (
    uptosvm "github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto/facilitator"
)

maxChannelLifetimeSecs := 3600
scheme := uptosvm.NewUptoSvmScheme(svmSigner, &uptosvm.Config{
    RPCURL:                 os.Getenv("SVM_RPC_URL"),
    MaxChannelLifetimeSecs: &maxChannelLifetimeSecs,
})
facilitator.Register([]x402.Network{network}, scheme)

// Optional: reclaim PDA rent from abandoned, sealed, and distributed channels.
cleanup := scheme.NewRentCleanupManager(string(network))
cleanup.Start(ctx, uptosvm.StartConfig{
    Interval:          5 * time.Minute,
    DiscoveryInterval: 24 * time.Hour,
})
defer cleanup.Stop()
```

The upto facilitator's `GetExtra()` returns a `feePayer` address. That key is set as the channel `payee` (with a zero distribution share) and `rent_payer`: it co-signs `open`, sponsors fees and rent, and signs `settle_and_seal`. Any nonzero settlement still requires the server's `receiverAuthorizer` voucher.

### Channel Storage and Rent Cleanup

The scheme records every channel it sponsors in a `ChannelStorage` at settle time, and `RentCleanupManager` reads that store rather than scanning the chain. The default store is in-memory; inject a durable one so cleanup survives restarts and works across replicas:

```go
scheme := uptosvm.NewUptoSvmScheme(svmSigner, &uptosvm.Config{
    ChannelStorage: myDurableChannelStorage, // implements uptosvm.ChannelStorage
})
```

Each cleanup pass seals abandoned Open channels past `expiresAt` plus a grace period, distributes Sealed ones, and batch-reclaims rent from Distributed channels once they are 1,500 slots past their open slot. Sealing an abandoned channel freezes the settlement watermark and refunds the unsettled remainder to the client.

`DiscoveryInterval` additionally arms `Discover`, the spec §6 recovery sweep that finds Distributed channels this facilitator paid rent for that storage lost track of and adds them for a later cleanup pass to reclaim. A sweep is a `getProgramAccounts` scan per managed signer, so run it rarely — daily, not on the cleanup interval. Leave it zero to keep discovery off.

## Supported Networks

Works on Solana networks where the payment-channels program is deployed:

| Network | CAIP-2 ID |
|---------|-----------|
| Solana Mainnet Beta | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| Solana Devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` |

Canonical program id: `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`

## How It Works

1. Server advertises `scheme: "upto"` with a max `price`, plus `extra.receiverAuthorizer` and `extra.withdrawDelay`
2. Facilitator advertises `extra.feePayer`
3. Client derives the channel PDA and signs a payment-channel `open` that escrows the max amount
4. Facilitator deposits by co-signing and broadcasting `open` (escrow settle, before the handler)
5. Server performs work, calculates the actual cost, and signs a voucher for it
6. Facilitator claims with `settle_and_seal` + `distribute` for the actual amount (≤ max)
7. If the actual amount is `0`, the channel closes with a full refund to the client

## Examples

- [Gin upto server](https://github.com/x402-foundation/x402/tree/main/examples/go/servers/upto)
- [Upto facilitator with rent cleanup](https://github.com/x402-foundation/x402/tree/main/examples/go/facilitator/upto)

## See Also

- [Exact SVM Scheme](../README.md) — fixed-price SPL transfers
- [Upto EVM Scheme](../../evm/upto/README.md) — EVM counterpart (Permit2)
- [SVM `upto` Scheme Spec](../../../../specs/schemes/upto/scheme_upto_svm.md)
- [x402 Docs: Payment Schemes](https://docs.x402.org/getting-started/quickstart-for-sellers#payment-schemes-exact-vs-upto)
