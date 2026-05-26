# Solana V1 Mechanism for x402

This package provides V1 support for the Solana payment mechanism. It enables backwards compatibility for existing clients and facilitators using the x402 protocol version 1.

## Purpose

The V1 implementation exists solely for backwards compatibility. **New implementations should use the V2 mechanism** in the parent directory.

## Key Differences from V2

### Network Identifiers
- V1 uses simple names: `"solana"`, `"solana-devnet"`, `"solana-testnet"`
- V2 uses CAIP-2 format: `"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"`

### Payment Requirements
- V1 uses `MaxAmountRequired` field
- V2 uses `Amount` field

### Protocol Version
- V1 only supports x402 version 1
- V2 only supports x402 version 2

## What's Included

- ✅ **Client**: For creating V1 payment payloads
- ✅ **Facilitator**: For verifying and settling V1 payments
- ❌ **Service**: Not included (new servers should use V2)

## Usage

### V1 Client

```go
import (
    x402 "github.com/x402-foundation/x402/go"
    "github.com/x402-foundation/x402/go/mechanisms/solana/v1"
)

client := x402.NewX402Client()
signer := &MySolanaSigner{...}

// Register for V1 networks
v1.RegisterClient(client, signer, "solana", "solana-devnet")
```

### V1 Facilitator

```go
import (
    x402 "github.com/x402-foundation/x402/go"
    "github.com/x402-foundation/x402/go/mechanisms/solana/v1"
)

facilitator := x402.NewX402Facilitator()
signer := &MyFacilitatorSigner{...}

// Register for V1 networks
v1.RegisterFacilitator(facilitator, signer, "solana", "solana-devnet")
```

## Migration to V2

If you're currently using V1, consider migrating to V2:

**Before (V1)**:
```go
import "github.com/x402-foundation/x402/go/mechanisms/solana/v1"

v1.RegisterClient(client, signer, "solana")
```

**After (V2)**:
```go
import "github.com/x402-foundation/x402/go/mechanisms/solana"

solana.RegisterClient(client, signer, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
```

## V1 Networks

- **Mainnet**: `solana`
- **Devnet**: `solana-devnet`
- **Testnet**: `solana-testnet`

These are automatically mapped to CAIP-2 identifiers internally.

## Implementation Details

The V1 implementation reuses most of the V2 logic but adapts it for:
- V1 network naming conventions
- V1 payload structure (includes scheme in payload.Accepted)
- V1 amount field (`MaxAmountRequired` instead of `Amount`)

The transaction structure, verification logic, and settlement process are identical to V2.

## See Also

- [V2 Implementation](../README.md) - Recommended for new implementations
- [x402 Protocol Specification](../../../../specs/)

