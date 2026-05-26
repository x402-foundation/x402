# Advanced x402 Client Examples

Advanced patterns for x402 Go clients demonstrating payment lifecycle hooks, network preferences, and production-ready transports.

## Prerequisites

- Go 1.21 or higher
- An Ethereum private key (testnet recommended)
- A running x402 server (see [server examples](../../servers/))
- Familiarity with the [basic HTTP client](../http/)

## Setup

1. Install dependencies:

```bash
go mod download
```

2. Create a `.env` file:

```bash
# Required
EVM_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Optional
SERVER_URL=http://localhost:4021/weather
```

## Available Examples

Each example demonstrates a specific advanced pattern:

| Example | Command | Description |
|---------|---------|-------------|
| `all-networks` | `go run . all-networks` | All supported networks with optional chain configuration |
| `custom-transport` | `go run . custom-transport` | Custom HTTP transport with retry logic |
| `error-recovery` | `go run . error-recovery` | Error classification and recovery |
| `multi-network-priority` | `go run . multi-network-priority` | Network-specific signer registration |
| `hooks` | `go run . hooks` | Payment lifecycle hooks |

## Testing the Examples

Start a server first:

```bash
cd ../../servers/gin
go run main.go
```

Then run the examples:

```bash
cd ../../clients/advanced
go run . hooks
```

## Example: Payment Lifecycle Hooks

Register custom logic at different payment stages for observability and control:

```go
import (
    x402 "github.com/x402-foundation/x402/go"
    x402http "github.com/x402-foundation/x402/go/http"
    evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/client"
    evmsigners "github.com/x402-foundation/x402/go/signers/evm"
)

signer, _ := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("EVM_PRIVATE_KEY"))

client := x402.Newx402Client().
    Register("eip155:*", evm.NewExactEvmScheme(signer))

// OnBeforePaymentCreation: validation before payment
client.OnBeforePaymentCreation(func(ctx x402.PaymentCreationContext) (*x402.BeforePaymentCreationHookResult, error) {
    fmt.Printf("Creating payment for: %s\n", ctx.SelectedRequirements.GetNetwork())
    // Abort payment by returning: &x402.BeforePaymentCreationHookResult{Abort: true, Reason: "Not allowed"}
    return nil, nil
})

// OnAfterPaymentCreation: logging after successful payment
client.OnAfterPaymentCreation(func(ctx x402.PaymentCreatedContext) error {
    fmt.Printf("Payment created: version %d\n", ctx.Version)
    return nil
})

// OnPaymentCreationFailure: error recovery
client.OnPaymentCreationFailure(func(ctx x402.PaymentCreationFailureContext) (*x402.PaymentCreationFailureHookResult, error) {
    fmt.Printf("Payment failed: %v\n", ctx.Error)
    // Recover by returning: &x402.PaymentCreationFailureHookResult{Recovered: true, Payload: altPayload}
    return nil, nil
})

httpClient := x402http.Newx402HTTPClient(client)
wrappedClient := x402http.WrapHTTPClientWithPayment(http.DefaultClient, httpClient)

resp, _ := wrappedClient.Get("http://localhost:4021/weather")
```

Available hooks:

- `OnBeforePaymentCreation` — Run before payment creation (can abort)
- `OnAfterPaymentCreation` — Run after successful payment creation
- `OnPaymentCreationFailure` — Run when payment creation fails (can recover)

**Use case:** Log payment events, custom validation, retry/recovery logic, metrics collection.

## Example: Multi-Network Priority

Configure network-specific signers with wildcard fallback:

```go
client := x402.Newx402Client().
    // Specific networks (highest priority)
    Register("eip155:1", evm.NewExactEvmScheme(mainnetSigner)).
    Register("eip155:8453", evm.NewExactEvmScheme(baseSigner)).
    Register("eip155:84532", evm.NewExactEvmScheme(testnetSigner)).
    // Wildcard fallback (lowest priority)
    Register("eip155:*", evm.NewExactEvmScheme(defaultSigner))
```

More specific registrations always override wildcards.

**Use case:** Different signers per network, mainnet/testnet separation, multi-chain applications.

## Example: Custom Transport

Build a custom HTTP transport with retry logic and timing:

```go
// RetryTransport wraps a transport with exponential backoff
type RetryTransport struct {
    Transport  http.RoundTripper
    MaxRetries int
    RetryDelay time.Duration
}

// Stack transports: Base -> Timing -> Retry -> x402 Payment
baseTransport := &http.Transport{
    MaxIdleConns:        100,
    MaxIdleConnsPerHost: 10,
    IdleConnTimeout:     90 * time.Second,
}

timingTransport := &TimingTransport{Transport: baseTransport}
retryTransport := &RetryTransport{Transport: timingTransport, MaxRetries: 3, RetryDelay: 100 * time.Millisecond}

wrappedClient := x402http.WrapHTTPClientWithPayment(
    &http.Client{Transport: retryTransport, Timeout: 30 * time.Second},
    httpClient,
)
```

**Use case:** Automatic retry on transient failures, request metrics, connection pooling.

## Hook Best Practices

1. **Keep hooks fast** — Avoid blocking operations
2. **Handle errors gracefully** — Don't panic in hooks
3. **Log appropriately** — Use structured logging
4. **Avoid side effects in before hooks** — Only use for validation

## Next Steps

- **[Basic HTTP Client](../http/)** — Start here if you haven't already
- **[Custom Client](../custom/)** — Learn the internals
- **[Server Examples](../../servers/)** — Build complementary servers

