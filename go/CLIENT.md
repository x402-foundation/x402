# x402 Go Client Documentation

This guide covers how to build payment-enabled clients in Go using the x402 package.

## Overview

An **x402 client** is an application that makes HTTP requests to payment-protected resources. The client automatically:

1. Detects when a resource requires payment (402 response)
2. Creates a payment payload using registered mechanisms
3. Retries the request with payment headers
4. Receives the protected resource

## Quick Start

### Installation

```bash
go get github.com/coinbase/x402/go
```

### Basic HTTP Client

```go
package main

import (
    "net/http"
    
    x402 "github.com/coinbase/x402/go"
    x402http "github.com/coinbase/x402/go/http"
    evm "github.com/coinbase/x402/go/mechanisms/evm/exact/client"
    evmsigners "github.com/coinbase/x402/go/signers/evm"
)

func main() {
    // 1. Create signer from private key
    signer, _ := evmsigners.NewClientSignerFromPrivateKey("0x...")
    
    // 2. Create x402 client and register schemes
    client := x402.Newx402Client().
        Register("eip155:*", evm.NewExactEvmScheme(signer, nil))
    
    // 3. Wrap HTTP client
    httpClient := x402http.WrapHTTPClientWithPayment(
        http.DefaultClient,
        x402http.Newx402HTTPClient(client),
    )
    
    // 4. Make requests - payments handled automatically
    resp, _ := httpClient.Get("https://api.example.com/data")
    defer resp.Body.Close()
}
```

## Core Concepts

### 1. Signers

**Signers** create cryptographic signatures for payment payloads.

#### EVM Signer

```go
import evmsigners "github.com/coinbase/x402/go/signers/evm"

signer, err := evmsigners.NewClientSignerFromPrivateKey("0x1234...")
if err != nil {
    log.Fatal(err)
}

fmt.Println("Address:", signer.Address())
```

#### SVM Signer

```go
import svmsigners "github.com/coinbase/x402/go/signers/svm"

signer, err := svmsigners.NewClientSignerFromPrivateKey("5J7W...")
if err != nil {
    log.Fatal(err)
}

fmt.Println("Address:", signer.Address())
```

### 2. Client Core (x402.X402Client)

The core client manages payment scheme registration and payload creation.

**Key Methods:**

```go
client := x402.Newx402Client()

// Register payment schemes for networks
client.Register(network, schemeClient)

// Create payment payload (called automatically by HTTP wrapper)
payload, err := client.CreatePaymentPayload(ctx, requirements, resource, extensions)
```

### 3. Mechanism Registration

Register mechanisms to enable payment creation for different networks.

#### Wildcard Registration (Recommended)

```go
// All EVM networks
client.Register("eip155:*", evm.NewExactEvmScheme(evmSigner, nil))

// All Solana networks
client.Register("solana:*", svm.NewExactSvmScheme(svmSigner))
```

#### Specific Network Registration

```go
// Ethereum Mainnet
client.Register("eip155:1", evm.NewExactEvmScheme(mainnetSigner, nil))

// Base Mainnet
client.Register("eip155:8453", evm.NewExactEvmScheme(baseSigner, nil))

// Base Sepolia
client.Register("eip155:84532", evm.NewExactEvmScheme(testnetSigner, nil))
```

#### Registration Precedence

More specific registrations override wildcards:

```go
client.
    Register("eip155:*", evm.NewExactEvmScheme(defaultSigner, nil)).     // Fallback
    Register("eip155:1", evm.NewExactEvmScheme(mainnetSigner, nil))      // Override for mainnet
```

#### Optional Extension RPC Config (Explicit-Only)

`NewExactEvmScheme` supports optional RPC config used only for extension
enrichment when signer read/fee capabilities are unavailable.

No chain-default RPC fallback is applied by the SDK.

```go
// Per-network explicit registration
client.
    Register("eip155:137", evm.NewExactEvmScheme(polygonSigner, &evm.ExactEvmSchemeConfig{
        RPCURL: "https://polygon.example",
    })).
    Register("eip155:8453", evm.NewExactEvmScheme(baseSigner, &evm.ExactEvmSchemeConfig{
        RPCURL: "https://base.example",
    }))

// Wildcard registration with chain-id map
client.Register("eip155:*", evm.NewExactEvmScheme(defaultSigner, &evm.ExactEvmSchemeConfig{
    RPCByChainID: map[int64]evm.ExactEvmChainConfig{
        137:  {RPCURL: "https://polygon.example"},
        8453: {RPCURL: "https://base.example"},
    },
}))
```

### 4. HTTP Integration

The HTTP layer adds automatic payment handling to standard HTTP clients.

```go
// Create HTTP-aware x402 client
httpClient := x402http.Newx402HTTPClient(client)

// Wrap any http.Client
wrappedClient := x402http.WrapHTTPClientWithPayment(http.DefaultClient, httpClient)

// Make requests
resp, err := wrappedClient.Get(url)
```

**What the wrapper does:**

1. Intercepts all HTTP requests
2. Detects 402 Payment Required responses
3. Extracts payment requirements from headers/body
4. Creates payment using registered mechanisms
5. Retries request with payment signature
6. Returns final response to caller

## Lifecycle Hooks

Hooks allow you to run custom logic during payment creation.

### Available Hooks

```go
client.OnBeforePaymentCreation(func(ctx x402.PaymentCreationContext) (*x402.BeforePaymentCreationResult, error) {
    // Called before payment creation
    // Can abort by returning: &BeforePaymentCreationResult{Abort: true, Reason: "..."}
    fmt.Printf("Creating payment for %s\n", ctx.Requirements.Network)
    return nil, nil
})

client.OnAfterPaymentCreation(func(ctx x402.PaymentCreationResultContext) error {
    // Called after successful payment creation
    // Use for logging, metrics, etc.
    fmt.Printf("Payment created: %d bytes\n", len(ctx.PayloadBytes))
    return nil
})

client.OnPaymentCreationFailure(func(ctx x402.PaymentCreationFailureContext) (*x402.PaymentCreationFailureResult, error) {
    // Called when payment creation fails
    // Can recover by returning: &PaymentCreationFailureResult{Recovered: true, Payload: ...}
    fmt.Printf("Payment failed: %v\n", ctx.Error)
    return nil, nil
})
```

### Hook Use Cases

**Logging:**
```go
client.OnAfterPaymentCreation(func(ctx PaymentCreationResultContext) error {
    log.Printf("Payment created for %s: %s", ctx.Requirements.Network, ctx.Requirements.Scheme)
    return nil
})
```

**Metrics:**
```go
client.OnAfterPaymentCreation(func(ctx PaymentCreationResultContext) error {
    metrics.IncrementCounter("payments.created", map[string]string{
        "network": string(ctx.Requirements.Network),
        "scheme": ctx.Requirements.Scheme,
    })
    return nil
})
```

**Aborting Payments:**
```go
client.OnBeforePaymentCreation(func(ctx PaymentCreationContext) (*BeforePaymentCreationResult, error) {
    // Don't pay for resources over a certain price
    if exceedsLimit(ctx.Requirements.Amount) {
        return &BeforePaymentCreationResult{
            Abort: true,
            Reason: "Price exceeds user limit",
        }, nil
    }
    return nil, nil
})
```

## Advanced Patterns

### Multi-Network Client

Support multiple blockchains with different signers:

```go
evmSigner, _ := evmsigners.NewClientSignerFromPrivateKey(evmKey)
svmSigner, _ := svmsigners.NewClientSignerFromPrivateKey(svmKey)

client := x402.Newx402Client().
    Register("eip155:*", evm.NewExactEvmScheme(evmSigner)).
    Register("solana:*", svm.NewExactEvmScheme(svmSigner))
```

### Custom HTTP Transport

Add retry logic, timeouts, or other custom behavior:

```go
// Custom transport with retry logic
customTransport := &RetryTransport{
    Transport: http.DefaultTransport,
    MaxRetries: 3,
}

// Wrap with payment handling
httpClient := x402http.WrapHTTPClientWithPayment(
    &http.Client{Transport: customTransport},
    x402http.Newx402HTTPClient(client),
)
```

### Concurrent Requests

Make multiple paid requests in parallel:

```go
urls := []string{
    "https://api.example.com/data1",
    "https://api.example.com/data2",
    "https://api.example.com/data3",
}

var wg sync.WaitGroup
for _, url := range urls {
    wg.Add(1)
    go func(u string) {
        defer wg.Done()
        resp, _ := httpClient.Get(u)
        defer resp.Body.Close()
        // Process response
    }(url)
}
wg.Wait()
```

## API Reference

### x402.X402Client

**Constructor:**
```go
func Newx402Client() *X402Client
```

**Registration Methods:**
```go
func (c *X402Client) Register(network Network, scheme SchemeNetworkClient) *X402Client
```

**Hook Methods:**
```go
func (c *X402Client) OnBeforePaymentCreation(hook BeforePaymentCreationHook) *X402Client
func (c *X402Client) OnAfterPaymentCreation(hook AfterPaymentCreationHook) *X402Client
func (c *X402Client) OnPaymentCreationFailure(hook PaymentCreationFailureHook) *X402Client
```

**Payment Methods:**
```go
func (c *X402Client) CreatePaymentPayload(ctx context.Context, requirements PaymentRequirements, resource *ResourceInfo, extensions map[string]interface{}) (PaymentPayload, error)

func (c *X402Client) SelectPaymentRequirements(accepts []PaymentRequirements) (PaymentRequirements, error)
```

### x402http.HTTPClient

**Constructor:**
```go
func Newx402HTTPClient(client *X402Client) *x402HTTPClient
```

**Wrapper:**
```go
func WrapHTTPClientWithPayment(client *http.Client, x402Client *x402HTTPClient) *http.Client
```

**Convenience Methods:**
```go
func (c *x402HTTPClient) GetWithPayment(ctx context.Context, url string) (*http.Response, error)
func (c *x402HTTPClient) PostWithPayment(ctx context.Context, url string, body io.Reader) (*http.Response, error)
func (c *x402HTTPClient) DoWithPayment(ctx context.Context, req *http.Request) (*http.Response, error)
```

## Error Handling

### Common Errors

**No Registered Mechanism:**
```go
// Error: "no client registered for network eip155:1 and scheme exact"
// Solution: Register the mechanism
client.Register("eip155:1", evm.NewExactEvmScheme(signer))
```

**Invalid Signer:**
```go
// Error: "invalid private key"
// Solution: Check private key format (0x-prefixed hex for EVM, base58 for SVM)
signer, err := evmsigners.NewClientSignerFromPrivateKey(key)
if err != nil {
    log.Fatalf("Invalid key: %v", err)
}
```

**Payment Retry Limit:**
```go
// Error: "payment retry limit exceeded"
// Cause: Server rejected payment twice
// Check: Server logs for rejection reason
```

### Error Recovery

Use hooks to implement custom error recovery:

```go
client.OnPaymentCreationFailure(func(ctx PaymentCreationFailureContext) (*PaymentCreationFailureResult, error) {
    // Log error
    log.Printf("Payment failed: %v", ctx.Error)
    
    // Could implement fallback logic here
    // e.g., try different network, notify user, etc.
    
    return nil, nil // Let it fail
})
```

## Best Practices

### 1. Use Signer Helpers

❌ **Don't** implement signers manually  
✅ **Do** use the signer helpers:

```go
signer, _ := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("PRIVATE_KEY"))
```

### 2. Register Wildcards

❌ **Don't** register every network individually (unless needed)  
✅ **Do** use wildcards for simplicity:

```go
client.Register("eip155:*", evm.NewExactEvmScheme(signer))
```

### 3. Reuse HTTP Clients

❌ **Don't** create new clients for every request  
✅ **Do** reuse wrapped clients:

```go
// Create once
httpClient := x402http.WrapHTTPClientWithPayment(http.DefaultClient, x402http.Newx402HTTPClient(client))

// Reuse many times
resp1, _ := httpClient.Get(url1)
resp2, _ := httpClient.Get(url2)
```

### 4. Handle Contexts Properly

❌ **Don't** use background context for everything  
✅ **Do** propagate contexts with timeouts:

```go
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()

req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
resp, _ := httpClient.Do(req)
```

### 5. Secure Private Keys

❌ **Don't** hardcode private keys  
✅ **Do** load from environment or secure vaults:

```go
privateKey := os.Getenv("EVM_PRIVATE_KEY")
signer, _ := evmsigners.NewClientSignerFromPrivateKey(privateKey)
```

## Examples

Complete examples are available in [`examples/go/clients/`](../../examples/go/clients/):

- **[Basic HTTP Client](../../examples/go/clients/http/)** - Simple integration
- **[Custom Client](../../examples/go/clients/custom/)** - Manual implementation
- **[Advanced Patterns](../../examples/go/clients/advanced/)** - Production patterns

## Troubleshooting

### Payment Not Created

**Problem:** Client makes request but doesn't create payment on 402  
**Check:**
- Is mechanism registered? `client.Register("eip155:*", ...)`
- Does network match? Ensure server's network has a registered mechanism
- Are there errors? Add hooks to log payment creation attempts

### Wrong Network Selected

**Problem:** Client uses wrong network for payment  
**Solution:** The server determines the network. Client must have that network registered:

```go
// If server requires eip155:84532, client needs:
client.Register("eip155:84532", evm.NewExactEvmScheme(signer))
// OR
client.Register("eip155:*", evm.NewExactEvmScheme(signer))
```

### Signature Verification Fails

**Problem:** Server/facilitator rejects payment signature  
**Check:**
- Correct private key format
- Signer address matches payment requirements
- Clock synchronization (for time-based signatures)

## Performance Considerations

### Connection Pooling

```go
transport := &http.Transport{
    MaxIdleConns:        100,
    MaxIdleConnsPerHost: 10,
    IdleConnTimeout:     90 * time.Second,
}

httpClient := x402http.WrapHTTPClientWithPayment(
    &http.Client{Transport: transport},
    x402http.Newx402HTTPClient(client),
)
```

### Concurrent Requests

The wrapped HTTP client is safe for concurrent use:

```go
// Single client, multiple goroutines
for _, url := range urls {
    go func(u string) {
        resp, _ := httpClient.Get(u) // Safe!
        defer resp.Body.Close()
    }(url)
}
```

### Payment Caching

Payment payloads are created fresh for each 402 response. They are not cached because:
- Each payment should be unique (nonce, timestamp)
- Prevents replay attacks
- Ensures fresh blockchain state

## Testing

### Unit Tests

```go
import (
    "testing"
    x402 "github.com/coinbase/x402/go"
    evm "github.com/coinbase/x402/go/mechanisms/evm/exact/client"
)

func TestClientRegistration(t *testing.T) {
    signer, _ := evmsigners.NewClientSignerFromPrivateKey(testKey)
    
    client := x402.Newx402Client().
        Register("eip155:*", evm.NewExactEvmScheme(signer))
    
    // Test client behavior
}
```

### Integration Tests

See [`test/integration/`](test/integration/) for examples of testing against real servers.

## Migration from V1

If you're migrating from x402 v1:

### Client Changes

**V1:**
```go
client.RegisterV1("base-sepolia", evmv1.NewExactEvmSchemeV1(signer))
```

**V2:**
```go
client.Register("eip155:84532", evm.NewExactEvmScheme(signer))
```

### Network Identifiers

**V1:** `"base-sepolia"`, `"ethereum"`, `"solana-devnet"`  
**V2:** `"eip155:84532"`, `"eip155:1"`, `"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"`

### Backward Compatibility

V2 clients can support both protocols:

```go
client.
    Register("eip155:*", evm.NewExactEvmScheme(signer)).      // V2
    RegisterV1("base-sepolia", evmv1.NewExactEvmSchemeV1(signer)) // V1 fallback
```

## Related Documentation

- **[Main README](README.md)** - Package overview
- **[SERVER.md](SERVER.md)** - Building servers
- **[FACILITATOR.md](FACILITATOR.md)** - Building facilitators
- **[Signers](signers/README.md)** - Signer helpers
- **[Mechanisms](mechanisms/)** - Payment scheme implementations
- **[Examples](../../examples/go/clients/)** - Working client examples

