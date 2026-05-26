# Upto EVM Scheme (Go)

The **upto** scheme enables usage-based billing on EVM networks. The client authorizes a **maximum** payment amount, but the server settles **only what was actually used**. This is ideal for variable-cost endpoints like LLM token generation, compute time, or bandwidth metering.

Uses **Permit2** exclusively (no EIP-3009 path). The on-chain proxy contract accepts a variable `amount` parameter at settlement time, so the facilitator can settle any amount up to the authorized maximum.

## Import Paths

| Role | Import |
|------|--------|
| Client | `github.com/x402-foundation/x402/go/mechanisms/evm/upto/client` |
| Server | `github.com/x402-foundation/x402/go/mechanisms/evm/upto/server` |
| Facilitator | `github.com/x402-foundation/x402/go/mechanisms/evm/upto/facilitator` |

## Client Usage

Register `UptoEvmScheme` with an `x402Client` to handle payments for services that use the `upto` scheme. From the buyer's perspective, usage is transparent — the SDK signs a max-authorization and the server charges only what was consumed.

```go
import (
    x402 "github.com/x402-foundation/x402/go"
    exactevm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/client"
    uptoevm "github.com/x402-foundation/x402/go/mechanisms/evm/upto/client"
    evmsigners "github.com/x402-foundation/x402/go/signers/evm"
)

evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("EVM_PRIVATE_KEY"))

x402Client := x402.Newx402Client().
    Register("eip155:*", exactevm.NewExactEvmScheme(evmSigner, nil)). // fixed-price services
    Register("eip155:*", uptoevm.NewUptoEvmScheme(evmSigner, nil))    // usage-based services
```

### Key Difference from Exact

The upto client requires `PaymentRequirements.Extra["facilitatorAddress"]` (provided automatically by the facilitator via `GetExtra()`). This address is embedded in the Permit2 witness so only the designated facilitator can settle the payment.

## Server Usage

Register `UptoEvmScheme` with middleware and use `SetSettlementOverrides` in your handler to specify the actual charge.

```go
import (
    x402 "github.com/x402-foundation/x402/go"
    x402http "github.com/x402-foundation/x402/go/http"
    ginmw "github.com/x402-foundation/x402/go/http/gin"
    uptoevm "github.com/x402-foundation/x402/go/mechanisms/evm/upto/server"
)

r.Use(ginmw.X402Payment(ginmw.Config{
    Routes: x402http.RoutesConfig{
        "GET /api/generate": {
            Accepts: x402http.PaymentOptions{
                {
                    Scheme:  "upto",
                    Price:   "$0.10",           // client authorizes up to 10 cents
                    Network: "eip155:84532",
                    PayTo:   "0xYourAddress",
                },
            },
            Description: "AI text generation - billed by token usage",
        },
    },
    Facilitator: facilitatorClient,
    Schemes: []ginmw.SchemeConfig{
        {Network: x402.Network("eip155:84532"), Server: uptoevm.NewUptoEvmScheme()},
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

### Settlement Override Formats

The `Amount` in `SettlementOverrides` supports three formats:

| Format | Example | Description |
|--------|---------|-------------|
| Raw atomic units | `"50000"` | Settles exactly 50,000 atomic units |
| Percentage | `"50%"` | Settles 50% of the authorized maximum |
| Dollar price | `"$0.05"` | Converts to atomic units (when route used `$` pricing) |

Setting `Amount` to `"0"` skips on-chain settlement entirely — the client is not charged.

## Facilitator Usage

For custom facilitator implementations:

```go
import (
    uptoevm "github.com/x402-foundation/x402/go/mechanisms/evm/upto/facilitator"
)

scheme := uptoevm.NewUptoEvmScheme(config)
```

The upto facilitator's `GetExtra()` returns a `facilitatorAddress` that the client embeds in the signed Permit2 witness. Only this address can call `settle()` on the upto proxy contract.

## Supported Networks

Works on any EIP-155 compatible network that has the Permit2 and x402 upto proxy contracts deployed:

| Network | CAIP-2 ID |
|---------|-----------|
| Base Mainnet | `eip155:8453` |
| Base Sepolia | `eip155:84532` |

## How It Works

1. Server advertises `scheme: "upto"` with a max `price`
2. Client signs a Permit2 authorization for the max amount, with a witness containing the `facilitator` address
3. Server performs work, calculates actual cost
4. Server calls `SetSettlementOverrides` with the actual amount
5. Facilitator settles on-chain for the actual amount (≤ max)
6. If actual amount is `0`, no on-chain transaction occurs

## Gas Sponsoring Extensions

Since the upto scheme uses Permit2 exclusively, it fully supports both gas sponsoring extensions. These let the **facilitator** pay for the client's Permit2 approval transaction, removing all gas costs from the client. The client SDK detects advertised extensions automatically.

### EIP-2612 Gas Sponsoring

The preferred path. If the payment token supports [EIP-2612](https://eips.ethereum.org/EIPS/eip-2612), the client signs an off-chain permit and the facilitator bundles approval + settlement in a single `settleWithPermit` call — zero gas for the client.

**Server:** Declare the extension in your route config:

```go
import (
    "github.com/x402-foundation/x402/go/extensions/eip2612gassponsor"
)

routes := x402http.RoutesConfig{
    "GET /api/generate": {
        Accepts: x402http.PaymentOptions{
            {
                Scheme:  "upto",
                Price:   "$0.10",
                Network: "eip155:84532",
                PayTo:   "0xYourAddress",
            },
        },
        Extensions: eip2612gassponsor.DeclareEip2612GasSponsoringExtension(),
    },
}
```

**Client:** No additional setup. `UptoEvmScheme` automatically checks for the extension and signs the permit when applicable.

**Facilitator:** Register the extension:

```go
import (
    "github.com/x402-foundation/x402/go/extensions/eip2612gassponsor"
)

facilitator.RegisterExtension(eip2612gassponsor.EIP2612GasSponsoring)
```

### ERC-20 Approval Gas Sponsoring

Fallback for tokens that do not support EIP-2612. The client signs a raw `approve(Permit2, MaxUint256)` transaction off-chain; the facilitator broadcasts it before settling.

**Server:** Declare the extension (omit `name`/`version` from token config to signal non-EIP-2612 tokens):

```go
import (
    "github.com/x402-foundation/x402/go/extensions/erc20approvalgassponsor"
)

routes := x402http.RoutesConfig{
    "GET /api/generate": {
        Accepts: x402http.PaymentOptions{ /* ... */ },
        Extensions: erc20approvalgassponsor.DeclareExtension(),
    },
}
```

**Client:** The signer must support transaction signing (nonce resolution, fee estimation). `UptoEvmScheme` falls back to this when EIP-2612 is unavailable.

**Facilitator:** Register with a signer that can broadcast transactions:

```go
import (
    "github.com/x402-foundation/x402/go/extensions/erc20approvalgassponsor"
)

erc20Ext := &erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension{Signer: evmSigner}
facilitator.RegisterExtension(erc20Ext)
```

### Extension Priority

When both extensions are advertised, EIP-2612 takes priority. The client tries EIP-2612 first; if the token lacks `name`/`version` in `Extra`, it falls back to ERC-20 approval gas sponsoring.

## Examples

- [Gin upto server](https://github.com/x402-foundation/x402/tree/main/examples/go/servers/upto)

## See Also

- [Exact EVM Scheme](../exact/README.md) — fixed-price payments
- [x402 Docs: Payment Schemes](https://docs.x402.org/getting-started/quickstart-for-sellers#payment-schemes-exact-vs-upto)
- [x402 Docs: Quickstart for Sellers](https://docs.x402.org/getting-started/quickstart-for-sellers)
- [x402 Docs: Quickstart for Buyers](https://docs.x402.org/getting-started/quickstart-for-buyers)
