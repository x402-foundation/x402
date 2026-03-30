# x402 Go Facilitator Documentation

This guide covers how to build payment facilitator services in Go using the x402 package.

## Overview

A **facilitator** is a payment processing service that sits between clients and the blockchain. It:

1. **Verifies** payment signatures from clients
2. **Settles** payments by submitting transactions to the blockchain
3. **Returns** settlement confirmation to resource servers

Facilitators enable clients to create payments without direct blockchain interaction, simplifying client implementation and improving user experience.

## Architecture

```
Client → Resource Server → Facilitator → Network
   │           │                │            │
   │           │    POST /verify →          │
   │           │    ← IsValid   │            │
   │           │                │            │
   │           │    POST /settle →   Submit tx →
   │           │    ← Settlement ←  ← Confirmed
```

## Quick Start

### Installation

```bash
go get github.com/coinbase/x402/go
```

### Basic Facilitator Server

```go
package main

import (
    "github.com/gin-gonic/gin"
    x402 "github.com/coinbase/x402/go"
    evm "github.com/coinbase/x402/go/mechanisms/evm/exact/facilitator"
)

func main() {
    // 1. Create facilitator
    facilitator := x402.Newx402Facilitator()
    
    // 2. Register payment schemes
    // Note: Requires facilitator signer with RPC integration
    facilitator.Register("eip155:84532", evm.NewExactEvmScheme(evmSigner))
    
    // 3. Create HTTP server
    r := gin.Default()
    
    // 4. Expose facilitator endpoints
    r.GET("/supported", handleSupported(facilitator))
    r.POST("/verify", handleVerify(facilitator))
    r.POST("/settle", handleSettle(facilitator))
    
    r.Run(":4022")
}
```

## Core Concepts

### 1. Facilitator Core (x402.X402Facilitator)

The core facilitator manages verification and settlement.

**Key Methods:**

```go
facilitator := x402.Newx402Facilitator()

// Register payment mechanisms
facilitator.Register(network, schemeFacilitator)

// Query supported networks/schemes
supported, _ := facilitator.Supported(ctx)

// Verify payment signature
verifyResult, _ := facilitator.Verify(ctx, payloadBytes, requirementsBytes)

// Settle payment on-chain
settleResult, _ := facilitator.Settle(ctx, payloadBytes, requirementsBytes)
```

### 2. Facilitator Signers

Facilitator signers interact with the blockchain to verify and settle payments.

**Requirements:**
- Verify EIP-712 signatures (EVM) or transaction signatures (SVM)
- Submit transactions to blockchain
- Read blockchain state (nonces, balances)
- Wait for transaction confirmation

**Note:** Facilitator signer helpers are not yet available. For now, see the reference implementation in [`e2e/facilitators/go/main.go`](../../e2e/facilitators/go/main.go).

### 3. HTTP Endpoints

Facilitators expose three standard endpoints:

#### GET /supported

Returns supported networks and schemes.

**Response:**
```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:84532"
    }
  ]
}
```

#### POST /verify

Verifies a payment signature.

**Request:**
```json
{
  "paymentPayload": {...},
  "paymentRequirements": {...}
}
```

**Response:**
```json
{
  "isValid": true,
  "invalidReason": ""
}
```

#### POST /settle

Settles a payment on-chain.

**Request:**
```json
{
  "paymentPayload": {...},
  "paymentRequirements": {...}
}
```

**Response:**
```json
{
  "success": true,
  "transaction": "0x1234...",
  "network": "eip155:84532",
  "payer": "0xabcd..."
}
```

## Lifecycle Hooks

Hooks allow you to run custom logic during verification and settlement.

### Verify Hooks

```go
facilitator.OnBeforeVerify(func(ctx FacilitatorVerifyContext) (*BeforeHookResult, error) {
    // Called before verification starts
    log.Printf("Verifying payment for %s", ctx.Requirements.GetNetwork())
    
    // Can abort verification:
    // return &BeforeHookResult{Abort: true, Reason: "..."}, nil
    
    return nil, nil
})

facilitator.OnAfterVerify(func(ctx FacilitatorVerifyResultContext) error {
    // Called after successful verification
    log.Printf("Payment verified: valid=%v", ctx.Result.IsValid)
    return nil
})

facilitator.OnVerifyFailure(func(ctx FacilitatorVerifyFailureContext) (*VerifyFailureHookResult, error) {
    // Called when verification fails
    log.Printf("Verification failed: %v", ctx.Error)
    
    // Can recover by providing result:
    // return &VerifyFailureHookResult{Recovered: true, Result: ...}, nil
    
    return nil, nil
})
```

### Settle Hooks

```go
facilitator.OnBeforeSettle(func(ctx FacilitatorSettleContext) (*BeforeHookResult, error) {
    // Called before settlement starts
    log.Printf("Settling payment for %s", ctx.Requirements.GetNetwork())
    return nil, nil
})

facilitator.OnAfterSettle(func(ctx FacilitatorSettleResultContext) error {
    // Called after successful settlement
    log.Printf("Transaction submitted: %s", ctx.Result.Transaction)
    
    // Record in database, emit metrics, send notifications
    db.RecordTransaction(ctx.Result.Transaction, ctx.Result.Payer)
    
    return nil
})

facilitator.OnSettleFailure(func(ctx FacilitatorSettleFailureContext) (*SettleFailureHookResult, error) {
    // Called when settlement fails
    log.Printf("Settlement failed: %v", ctx.Error)
    
    // Could implement retry with higher gas:
    // if isGasError(ctx.Error) {
    //     result := retryWithHigherGas(ctx)
    //     return &SettleFailureHookResult{Recovered: true, Result: result}, nil
    // }
    
    return nil, nil
})
```

### Hook Use Cases

**Database Logging:**
```go
facilitator.OnAfterSettle(func(ctx FacilitatorSettleResultContext) error {
    return db.InsertTransaction(Transaction{
        Hash:      ctx.Result.Transaction,
        Payer:     ctx.Result.Payer,
        Network:   ctx.Result.Network,
        Timestamp: time.Now(),
    })
})
```

**Metrics Collection:**
```go
facilitator.OnAfterVerify(func(ctx FacilitatorVerifyResultContext) error {
    tags := map[string]string{
        "network": string(ctx.Requirements.GetNetwork()),
        "valid":   fmt.Sprintf("%v", ctx.Result.IsValid),
    }
    metrics.IncrementCounter("facilitator.verifications", tags)
    return nil
})
```

**Rate Limiting:**
```go
facilitator.OnBeforeSettle(func(ctx FacilitatorSettleContext) (*BeforeHookResult, error) {
    payer := ctx.Payload.GetPayer()
    if rateLimiter.IsExceeded(payer) {
        return &BeforeHookResult{
            Abort: true,
            Reason: "Rate limit exceeded",
        }, nil
    }
    return nil, nil
})
```

**Fraud Detection:**
```go
facilitator.OnBeforeVerify(func(ctx FacilitatorVerifyContext) (*BeforeHookResult, error) {
    if fraudDetector.IsSuspicious(ctx.Payload.GetPayer()) {
        return &BeforeHookResult{
            Abort: true,
            Reason: "Suspicious activity detected",
        }, nil
    }
    return nil, nil
})
```

## API Reference

### x402.X402Facilitator

**Constructor:**
```go
func Newx402Facilitator() *X402Facilitator
```

**Registration:**
```go
func (f *X402Facilitator) Register(network Network, facilitator SchemeNetworkFacilitator) *X402Facilitator
```

**Verify Hooks:**
```go
func (f *X402Facilitator) OnBeforeVerify(hook FacilitatorBeforeVerifyHook) *X402Facilitator
func (f *X402Facilitator) OnAfterVerify(hook FacilitatorAfterVerifyHook) *X402Facilitator
func (f *X402Facilitator) OnVerifyFailure(hook FacilitatorOnVerifyFailureHook) *X402Facilitator
```

**Settle Hooks:**
```go
func (f *X402Facilitator) OnBeforeSettle(hook FacilitatorBeforeSettleHook) *X402Facilitator
func (f *X402Facilitator) OnAfterSettle(hook FacilitatorAfterSettleHook) *X402Facilitator
func (f *X402Facilitator) OnSettleFailure(hook FacilitatorOnSettleFailureHook) *X402Facilitator
```

**Payment Methods:**
```go
func (f *X402Facilitator) Supported(ctx context.Context) (SupportedResponse, error)
func (f *X402Facilitator) Verify(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (VerifyResponse, error)
func (f *X402Facilitator) Settle(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (SettleResponse, error)
```

## Facilitator Signers

Facilitator signers require blockchain interaction for verification and settlement.

### Required Interface (EVM)

```go
type FacilitatorEvmSigner interface {
    // Get facilitator's Ethereum address
    GetAddress() string
    
    // Get chain ID for the network
    GetChainID() (*big.Int, error)
    
    // Verify EIP-712 signature
    VerifyTypedData(address string, domain TypedDataDomain, types map[string][]TypedDataField, 
                    primaryType string, message map[string]interface{}, signature []byte) (bool, error)
    
    // Send EIP-3009 transaction
    SendReceiveWithAuthorizationTransaction(authorization ReceiveWithAuthorization) (string, error)
    
    // Wait for transaction confirmation
    WaitForTransactionConfirmation(txHash string, maxWaitTime time.Duration) error
}
```

### Implementation Notes

Facilitator signers need to:

1. **Connect to RPC**: Maintain blockchain connection (`ethclient`, Solana RPC)
2. **Manage Nonces**: Track transaction nonces for reliability
3. **Estimate Gas**: Calculate appropriate gas prices
4. **Submit Transactions**: Send signed transactions to blockchain
5. **Wait for Confirmation**: Poll for transaction finality
6. **Handle Errors**: Retry on nonce errors, gas estimation failures

**Reference Implementation:** See [`e2e/facilitators/go/main.go`](../../e2e/facilitators/go/main.go) for a complete facilitator signer implementation (~300 lines).

**Coming Soon:** Facilitator signer helpers will reduce this to ~10 lines.

## Production Considerations

### Gas Management

- Monitor facilitator wallet balance
- Implement gas price strategies (EIP-1559)
- Set up alerts for low balance
- Use separate wallets per network

### Transaction Monitoring

- Log all submitted transactions
- Monitor for failed transactions
- Implement retry logic with higher gas
- Track transaction confirmation times

### Security

- Secure private key storage (use HSM, KMS)
- Implement rate limiting per payer
- Add fraud detection hooks
- Monitor for unusual patterns
- Set transaction value limits

#### Duplicate Settlement (Solana / SVM)

A race condition exists on Solana where the same payment transaction can be submitted to the `/settle` endpoint multiple times before the first submission is confirmed on-chain. Because Solana's RPC returns "success" for duplicate transaction submissions (the network deduplicates at the consensus level), the facilitator could return `success` to each caller. A malicious client can exploit this to obtain access to multiple resources while only paying once.

The SVM mechanism packages include a built-in `SettlementCache` that mitigates this. When registering SVM facilitator schemes, pass a shared cache instance to both V1 and V2 schemes:

```go
import svm "github.com/coinbase/x402/go/mechanisms/svm"

cache := svm.NewSettlementCache()
v2Scheme := facilitator.NewExactSvmScheme(signer, cache)
v1Scheme := v1facilitator.NewExactSvmSchemeV1(signer, cache)
```

The cache rejects concurrent settlement attempts for the same transaction payload with a `duplicate_settlement` error. Entries are evicted after 120 seconds (approximately twice the Solana blockhash lifetime).

See the [Exact SVM Scheme Specification](../specs/schemes/exact/scheme_exact_svm.md#duplicate-settlement-mitigation-recommended) for full details.

### High Availability

- Run multiple facilitator instances
- Use load balancer with health checks
- Implement transaction queue for resilience
- Set up monitoring and alerts

### Performance

- Use connection pooling for RPC
- Cache blockchain state when possible
- Batch verification requests if possible
- Optimize gas estimation

## Testing

### Unit Tests

```go
func TestFacilitatorVerify(t *testing.T) {
    facilitator := x402.Newx402Facilitator()
    facilitator.Register(network, mockScheme)
    
    result, err := facilitator.Verify(ctx, payloadBytes, requirementsBytes)
    
    if err != nil {
        t.Errorf("Verify failed: %v", err)
    }
    if !result.IsValid {
        t.Errorf("Expected valid payment")
    }
}
```

### Integration Tests

Test against real blockchain networks (testnet):

```go
// Create real signer with RPC connection
signer := newRealFacilitatorSigner(privateKey, rpcURL)

facilitator := x402.Newx402Facilitator()
facilitator.Register(network, evm.NewExactEvmScheme(signer))

// Test real verification and settlement
result, _ := facilitator.Settle(ctx, payloadBytes, requirementsBytes)

// Verify transaction on blockchain
receipt, _ := rpcClient.TransactionReceipt(ctx, result.Transaction)
```

## Monitoring

### Key Metrics

Track these metrics for production facilitators:

```go
facilitator.OnAfterVerify(func(ctx FacilitatorVerifyResultContext) error {
    metrics.IncrementCounter("facilitator.verifications", map[string]string{
        "network": string(ctx.Requirements.GetNetwork()),
        "valid":   fmt.Sprintf("%v", ctx.Result.IsValid),
    })
    return nil
})

facilitator.OnAfterSettle(func(ctx FacilitatorSettleResultContext) error {
    metrics.IncrementCounter("facilitator.settlements", map[string]string{
        "network": ctx.Result.Network,
        "success": fmt.Sprintf("%v", ctx.Result.Success),
    })
    metrics.RecordHistogram("facilitator.settlement_time", time.Since(startTime))
    return nil
})
```

**Recommended Metrics:**
- `facilitator.verifications` - Total verifications (by network, valid/invalid)
- `facilitator.settlements` - Total settlements (by network, success/failure)
- `facilitator.verification_time` - Verification duration
- `facilitator.settlement_time` - Settlement duration (including blockchain confirmation)
- `facilitator.gas_used` - Gas consumed per transaction
- `facilitator.wallet_balance` - Current wallet balance per network

### Alerting

Set up alerts for:
- Low wallet balance (< 0.1 ETH)
- High verification failure rate (> 5%)
- High settlement failure rate (> 2%)
- Slow transaction confirmation (> 60s)
- Unusual traffic patterns

## Error Handling

### Verification Errors

```go
result, err := facilitator.Verify(ctx, payloadBytes, requirementsBytes)
if err != nil {
    // System error (network, parsing, etc.)
    return http.StatusInternalServerError, err
}

if !result.IsValid {
    // Payment is invalid (bad signature, wrong amount, etc.)
    return http.StatusOK, result // Return invalid result to caller
}
```

### Settlement Errors

```go
result, err := facilitator.Settle(ctx, payloadBytes, requirementsBytes)
if err != nil {
    // Settlement failed (network error, gas estimation, etc.)
    log.Printf("Settlement failed: %v", err)
    
    // Could implement retry logic here
    return http.StatusInternalServerError, err
}

if !result.Success {
    // Transaction failed on-chain
    log.Printf("Transaction failed: %s", result.ErrorReason)
    return http.StatusOK, result
}
```

### Error Recovery

Use hooks to implement intelligent error recovery:

```go
facilitator.OnSettleFailure(func(ctx FacilitatorSettleFailureContext) (*SettleFailureHookResult, error) {
    // Classify error
    if isGasTooLow(ctx.Error) {
        // Retry with higher gas
        result := retryWithHigherGas(ctx)
        if result != nil {
            return &SettleFailureHookResult{
                Recovered: true,
                Result: *result,
            }, nil
        }
    }
    
    if isNonceError(ctx.Error) {
        // Reset nonce and retry
        resetNonce()
        // Let retry mechanism handle it
    }
    
    return nil, nil // No recovery
})
```

## Implementation Patterns

### HTTP Server Handler

```go
func handleVerify(facilitator *x402.X402Facilitator) gin.HandlerFunc {
    return func(c *gin.Context) {
        ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
        defer cancel()
        
        var req struct {
            PaymentPayload      json.RawMessage `json:"paymentPayload"`
            PaymentRequirements json.RawMessage `json:"paymentRequirements"`
        }
        
        if err := c.BindJSON(&req); err != nil {
            c.JSON(400, gin.H{"error": "Invalid request"})
            return
        }
        
        result, err := facilitator.Verify(ctx, req.PaymentPayload, req.PaymentRequirements)
        if err != nil {
            c.JSON(500, gin.H{"error": err.Error()})
            return
        }
        
        c.JSON(200, result)
    }
}
```

### Settlement with Timeout

```go
func handleSettle(facilitator *x402.X402Facilitator) gin.HandlerFunc {
    return func(c *gin.Context) {
        // Use longer timeout for blockchain operations
        ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
        defer cancel()
        
        var req struct {
            PaymentPayload      json.RawMessage `json:"paymentPayload"`
            PaymentRequirements json.RawMessage `json:"paymentRequirements"`
        }
        
        if err := c.BindJSON(&req); err != nil {
            c.JSON(400, gin.H{"error": "Invalid request"})
            return
        }
        
        result, err := facilitator.Settle(ctx, req.PaymentPayload, req.PaymentRequirements)
        if err != nil {
            c.JSON(500, gin.H{"error": err.Error()})
            return
        }
        
        c.JSON(200, result)
    }
}
```

## Best Practices

### 1. Separate Wallets Per Network

```go
evmMainnetSigner := newSigner(mainnetKey, mainnetRPC)
evmTestnetSigner := newSigner(testnetKey, testnetRPC)

facilitator.
    Register("eip155:1", evm.NewExactEvmScheme(evmMainnetSigner)).
    Register("eip155:84532", evm.NewExactEvmScheme(evmTestnetSigner))
```

### 2. Monitor Wallet Balances

```go
facilitator.OnAfterSettle(func(ctx FacilitatorSettleResultContext) error {
    balance := getWalletBalance(ctx.Result.Network)
    if balance < minimumBalance {
        alerts.Send("Low facilitator balance", map[string]interface{}{
            "network": ctx.Result.Network,
            "balance": balance,
        })
    }
    return nil
})
```

### 3. Implement Rate Limiting

```go
rateLimiter := newRateLimiter(100, time.Minute) // 100 per minute

facilitator.OnBeforeSettle(func(ctx FacilitatorSettleContext) (*BeforeHookResult, error) {
    payer := ctx.Payload.GetPayer()
    if !rateLimiter.Allow(payer) {
        return &BeforeHookResult{
            Abort: true,
            Reason: "Rate limit exceeded",
        }, nil
    }
    return nil, nil
})
```

### 4. Set Appropriate Timeouts

```go
// Verification: Quick (signature check)
ctx, cancel := context.WithTimeout(ctx, 10*time.Second)

// Settlement: Longer (blockchain interaction)
ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
```

### 5. Log All Operations

```go
facilitator.
    OnBeforeVerify(logOperation("verify")).
    OnAfterVerify(logSuccess("verify")).
    OnBeforeSettle(logOperation("settle")).
    OnAfterSettle(logSuccess("settle"))
```

## Deployment

### Environment Variables

```bash
# Required
EVM_PRIVATE_KEY=0x...          # Facilitator wallet private key
RPC_URL=https://base.org       # Blockchain RPC endpoint
PORT=4022                       # Server port

# Optional
SOLANA_PRIVATE_KEY=5J...       # For SVM support
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
MAX_GAS_PRICE=100              # Maximum gas price in gwei
```

### Docker Deployment

```dockerfile
FROM golang:1.21-alpine

WORKDIR /app
COPY . .

RUN go build -o facilitator

EXPOSE 4022
CMD ["./facilitator"]
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: x402-facilitator
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: facilitator
        image: your-facilitator:latest
        ports:
        - containerPort: 4022
        env:
        - name: EVM_PRIVATE_KEY
          valueFrom:
            secretKeyRef:
              name: facilitator-secrets
              key: evm-private-key
```

## Examples

Complete facilitator examples:

- **[Basic Facilitator](../../examples/go/facilitator/)** - API structure with hooks
- **[E2E Facilitator](../../e2e/facilitators/go/)** - Complete implementation

## Related Documentation

- **[Main README](README.md)** - Package overview
- **[CLIENT.md](CLIENT.md)** - Building clients
- **[SERVER.md](SERVER.md)** - Building servers
- **[Mechanisms](mechanisms/)** - Payment scheme implementations
- **[Examples](../../examples/go/facilitator/)** - Working facilitator examples

