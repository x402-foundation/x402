# x402 Facilitator Example

This example demonstrates how to build a simple x402 facilitator that verifies and settles payments on behalf of clients.

## What is a Facilitator?

A **facilitator** is a service that acts as a payment processor in the x402 protocol:

1. **Verifies** payment signatures from clients
2. **Settles** payments by submitting transactions to the blockchain
3. **Returns** confirmation to clients

Facilitators allow clients to create payments without needing to interact with the blockchain directly, making it easier to build payment-enabled applications.

## What This Example Shows

- **Basic Facilitator Setup**: Creating and configuring a facilitator
- **Payment Verification**: Verifying client payment signatures with idiomatic error handling
- **On-chain Settlement**: Submitting transactions to the blockchain (EVM + SVM)
- **Facilitator Signer Implementation**: See `signer.go` for EVM and SVM signer examples
- **Lifecycle Hooks**: Logging verification and settlement operations
- **HTTP Endpoints**: Exposing /verify, /settle, and /supported APIs

## Files in This Example

- **`main.go`** - Main facilitator server with hooks and endpoints
- **`signer.go`** - Facilitator signer implementations for EVM and SVM
- **`README.md`** - This file

## Architecture

```
Client → Resource Server → Facilitator → Blockchain
   │           │                │            │
   │           │                │            │
   │    1. Request resource     │            │
   │    2. Return 402 Payment Required       │
   │                            │            │
   │    3. Create payment       │            │
   │    4. Request w/ payment   │            │
   │           │                │            │
   │           │    5. Verify   →            │
   │           │    ← Valid     │            │
   │           │                │            │
   │    6. Return resource      │            │
   │           │                │            │
   │           │    7. Settle   →    8. Submit tx →
   │           │    ← Success   ←    ← Confirmed
```

## Signer Implementation

The `signer.go` file contains reference implementations for EVM and SVM facilitator signers that handle:
- EIP-712 signature verification
- Transaction submission and confirmation
- Balance checking
- RPC client management

For production deployments with additional features (Bazaar discovery, multiple networks), see `e2e/facilitators/go/main.go`.

## Prerequisites

- Go 1.24 or higher
- EVM private key with Base Sepolia ETH for transaction fees
- SVM private key with Solana Devnet SOL for transaction fees (optional)

## Setup

1. Create a `.env` file:

```bash
EVM_PRIVATE_KEY=<your-evm-private-key>
SVM_PRIVATE_KEY=<your-svm-private-key>
```

**⚠️ Security Note:** The facilitator private key needs ETH/SOL for gas fees. Use a dedicated facilitator account for settlement, and keep it separate from your seller `payTo` wallet and buyer test wallets.

2. Install dependencies and run:

```bash
go mod download
go run .
```

## Error Handling

The facilitator SDK uses **idiomatic Go error handling** with custom error types:

**Success Pattern:**
```go
result, err := facilitator.Verify(ctx, payload, requirements)
if err != nil {
    return err  // Any failure (business logic or system)
}
// result.IsValid is guaranteed to be true
```

**Structured Error Information:**
```go
result, err := facilitator.Verify(ctx, payload, requirements)
if err != nil {
    // Extract structured error details if needed
    if ve, ok := err.(*x402.VerifyError); ok {
        log.Printf("Verification failed: reason=%s, payer=%s, network=%s",
                   ve.Reason, ve.Payer, ve.Network)
    }
    return err
}
```

**Error Types:**
- `*VerifyError` - Verification failures with `Reason`, `Payer`, `Network`, `Err`
- `*SettleError` - Settlement failures with `Reason`, `Payer`, `Network`, `Transaction`, `Err`

This replaces the old pattern of checking both `err != nil` and `response.IsValid == false`.

## API Endpoints

### GET /supported

Returns supported networks and schemes.

**Response:**
```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:84532"
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
    }
  ]
}
```

### POST /verify

Verifies a payment signature.

**Request:**
```json
{
  "paymentPayload": {
    "x402Version": 2,
    "resource": {
      "url": "http://localhost:4021/weather",
      "description": "Weather data",
      "mimeType": "application/json"
    },
    "accepted": {
      "scheme": "exact",
      "network": "eip155:84532",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "amount": "1000",
      "payTo": "0x...",
      "maxTimeoutSeconds": 300,
      "extra": { "name": "USDC", "version": "2" }
    },
    "payload": {
      "signature": "0x...",
      "authorization": { "from": "0x...", "to": "0x...", "value": "1000", "..." : "..." }
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:84532",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "amount": "1000",
    "payTo": "0x...",
    "maxTimeoutSeconds": 300,
    "extra": {
      "name": "USDC",
      "version": "2"
    }
  }
}
```

Response (success):

```json
{
  "isValid": true,
  "payer": "0x..."
}
```

Response (failure):

```json
{
  "isValid": false,
  "invalidReason": "invalid_signature"
}
```

### POST /settle

Settles a verified payment by broadcasting the transaction on-chain.

Request body is identical to `/verify`.

Response (success):

```json
{
  "success": true,
  "transaction": "0x...",
  "network": "eip155:84532",
  "payer": "0x..."
}
```

Response (failure):

```json
{
  "success": false,
  "errorReason": "insufficient_balance",
  "transaction": "",
  "network": "eip155:84532"
}
```

## Extending the Example

### Adding Networks

Register additional schemes for other networks:

```go
import (
    x402 "github.com/x402-foundation/x402/go"
    evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/facilitator"
    svm "github.com/x402-foundation/x402/go/mechanisms/svm/exact/facilitator"
)

facilitator := x402.Newx402Facilitator()

// Register EVM scheme with smart wallet deployment enabled
evmConfig := &evm.ExactEvmSchemeConfig{
    DeployERC4337WithEIP6492: true,
}
facilitator.Register([]x402.Network{"eip155:84532"}, evm.NewExactEvmScheme(evmSigner, evmConfig))

// Register SVM scheme
facilitator.Register([]x402.Network{"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"}, svm.NewExactSvmScheme(svmSigner))
```

### Lifecycle Hooks

Add custom logic before/after verify and settle operations:

```go
facilitator := x402.Newx402Facilitator()

facilitator.OnBeforeVerify(func(ctx x402.FacilitatorVerifyContext) (*x402.FacilitatorBeforeHookResult, error) {
    // Log or validate before verification
    return nil, nil
})

facilitator.OnAfterVerify(func(ctx x402.FacilitatorVerifyResultContext) error {
    // Track verified payments
    return nil
})

facilitator.OnVerifyFailure(func(ctx x402.FacilitatorVerifyFailureContext) (*x402.FacilitatorVerifyFailureHookResult, error) {
    // Handle verification failures
    return nil, nil
})

facilitator.OnBeforeSettle(func(ctx x402.FacilitatorSettleContext) (*x402.FacilitatorBeforeHookResult, error) {
    // Validate before settlement
    // Return &x402.FacilitatorBeforeHookResult{Abort: true, Reason: "..."} to cancel
    return nil, nil
})

facilitator.OnAfterSettle(func(ctx x402.FacilitatorSettleResultContext) error {
    // Track successful settlements
    return nil
})

facilitator.OnSettleFailure(func(ctx x402.FacilitatorSettleFailureContext) (*x402.FacilitatorSettleFailureHookResult, error) {
    // Handle settlement failures
    return nil, nil
})
```

## Network Identifiers

Networks use [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) format:

- `eip155:84532` — Base Sepolia
- `eip155:8453` — Base Mainnet
- `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` — Solana Devnet
- `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` — Solana Mainnet
