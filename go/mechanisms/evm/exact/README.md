# Exact EVM Scheme (Go)

The **exact** scheme is the default x402 payment scheme for EVM networks. The client pays the exact advertised price — no more, no less. It supports two on-chain transfer methods: **EIP-3009** (`transferWithAuthorization`) and **Permit2** (Uniswap's signature-based approval).

## Import Paths

| Role | Import |
|------|--------|
| Client | `github.com/x402-foundation/x402/go/mechanisms/evm/exact/client` |
| Server | `github.com/x402-foundation/x402/go/mechanisms/evm/exact/server` |
| Facilitator | `github.com/x402-foundation/x402/go/mechanisms/evm/exact/facilitator` |
| Client (V1 legacy) | `github.com/x402-foundation/x402/go/mechanisms/evm/exact/v1/client` |
| Facilitator (V1 legacy) | `github.com/x402-foundation/x402/go/mechanisms/evm/exact/v1/facilitator` |

## Client Usage

Create an `ExactEvmScheme` and register it with an `x402Client` to automatically handle payments for EVM-network services that use the `exact` scheme.

```go
import (
    x402 "github.com/x402-foundation/x402/go"
    exactevm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/client"
    evmsigners "github.com/x402-foundation/x402/go/signers/evm"
)

evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("EVM_PRIVATE_KEY"))

x402Client := x402.Newx402Client().
    Register("eip155:*", exactevm.NewExactEvmScheme(evmSigner, nil))
```

## Server Usage

Register `ExactEvmScheme` with middleware to protect routes with fixed-price payments.

```go
import (
    x402http "github.com/x402-foundation/x402/go/http"
    ginmw "github.com/x402-foundation/x402/go/http/gin"
    exactevm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/server"
)

r.Use(ginmw.X402Payment(ginmw.Config{
    Routes: x402http.RoutesConfig{
        "GET /weather": {
            Accepts: x402http.PaymentOptions{
                {
                    Scheme:  "exact",
                    Price:   "$0.001",
                    Network: "eip155:84532",
                    PayTo:   "0xYourAddress",
                },
            },
        },
    },
    Facilitator: facilitatorClient,
    Schemes: []ginmw.SchemeConfig{
        {Network: x402.Network("eip155:84532"), Server: exactevm.NewExactEvmScheme()},
    },
}))
```

## Facilitator Usage

For custom facilitator implementations:

```go
import (
    exactevm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/facilitator"
)

scheme := exactevm.NewExactEvmScheme(config)
```

## Supported Networks

Works on any EIP-155 compatible network. Common networks:

| Network | CAIP-2 ID |
|---------|-----------|
| Base Mainnet | `eip155:8453` |
| Base Sepolia | `eip155:84532` |

## Transfer Methods

| Method | Description |
|--------|-------------|
| EIP-3009 | `transferWithAuthorization` — gasless, single-signature transfer (default) |
| Permit2 | Uniswap Permit2 — signature-based approval + transfer via proxy contract |

## Gas Sponsoring Extensions (Permit2 only)

When using the Permit2 transfer method, the exact scheme integrates with two gas sponsoring extensions that let the **facilitator** pay for the client's Permit2 approval transaction on-chain. This is transparent to both server and client — the client SDK automatically detects advertised extensions and signs the appropriate data.

> Gas sponsoring does **not** apply to the EIP-3009 path, which is already gasless by design.

### EIP-2612 Gas Sponsoring

The preferred path. If the payment token supports [EIP-2612](https://eips.ethereum.org/EIPS/eip-2612) (gasless `permit`), the client signs an off-chain EIP-2612 permit and the facilitator calls `settleWithPermit` — bundling the approval and settlement in a single transaction with no gas cost to the client.

**Server:** Declare the extension in your route config and ensure the token's `name` and `version` are included (the default for EIP-2612-compatible tokens):

```go
import (
    "github.com/x402-foundation/x402/go/extensions/eip2612gassponsor"
)

routes := x402http.RoutesConfig{
    "GET /weather": {
        Accepts: x402http.PaymentOptions{
            {
                Scheme:  "exact",
                Price:   "$0.001",
                Network: "eip155:84532",
                PayTo:   "0xYourAddress",
            },
        },
        Extensions: eip2612gassponsor.DeclareEip2612GasSponsoringExtension(),
    },
}
```

**Client:** No additional setup required. `ExactEvmScheme` automatically checks for the `eip2612GasSponsoring` extension and signs the permit when applicable.

**Facilitator:** Register the extension:

```go
import (
    "github.com/x402-foundation/x402/go/extensions/eip2612gassponsor"
)

facilitator.RegisterExtension(eip2612gassponsor.EIP2612GasSponsoring)
```

### ERC-20 Approval Gas Sponsoring

Fallback for tokens that **do not** support EIP-2612. The client signs a raw ERC-20 `approve(Permit2, MaxUint256)` transaction off-chain and includes it in the payment payload. The facilitator broadcasts this approval transaction on-chain before settling.

**Server:** Declare the extension and omit `name`/`version` from the token config to signal clients to skip EIP-2612:

```go
import (
    "github.com/x402-foundation/x402/go/extensions/erc20approvalgassponsor"
)

routes := x402http.RoutesConfig{
    "GET /weather": {
        Accepts: x402http.PaymentOptions{ /* ... */ },
        Extensions: erc20approvalgassponsor.DeclareExtension(),
    },
}
```

**Client:** The signer must support transaction signing (nonce resolution, fee estimation). `ExactEvmScheme` falls back to this path when EIP-2612 is not available.

**Facilitator:** Register with a signer that can broadcast transactions:

```go
import (
    "github.com/x402-foundation/x402/go/extensions/erc20approvalgassponsor"
)

erc20Ext := &erc20approvalgassponsor.Erc20ApprovalFacilitatorExtension{Signer: evmSigner}
facilitator.RegisterExtension(erc20Ext)
```

### Extension Priority

When **both** extensions are advertised, EIP-2612 takes priority. The client tries EIP-2612 first; if the token lacks `name`/`version` in `Extra` (meaning it doesn't support EIP-2612), it falls back to ERC-20 approval gas sponsoring.

## Examples

- [Gin server](https://github.com/x402-foundation/x402/tree/main/examples/go/servers/gin)
- [net/http server](https://github.com/x402-foundation/x402/tree/main/examples/go/servers/nethttp)
- [HTTP client](https://github.com/x402-foundation/x402/tree/main/examples/go/clients/http)
- [EIP-2612 gas sponsoring server](https://github.com/x402-foundation/x402/tree/main/examples/go/servers/advanced/eip2612-gas-sponsoring.go)

## See Also

- [Upto EVM Scheme](../upto/README.md) — usage-based billing with partial settlement
- [x402 Docs: Quickstart for Sellers](https://docs.x402.org/getting-started/quickstart-for-sellers)
- [x402 Docs: Quickstart for Buyers](https://docs.x402.org/getting-started/quickstart-for-buyers)
- [Exact EVM Scheme Specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md)
