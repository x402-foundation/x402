# x402 Signers

This directory contains **signer helper implementations** that simplify cryptographic signing for x402 payments.

## What are Signers?

**Signers** are components that handle cryptographic signing operations for blockchain transactions. In the x402 protocol, signers are used to:

- **Clients**: Sign payment payloads to authorize transfers
- **Facilitators**: Sign and submit transactions to the blockchain

## Key Concept: Mechanisms Define Signer Interfaces

**Each mechanism declares its own expected signer shape.** The signer interface is defined by the mechanism, not by the core x402 protocol.

### Why Mechanisms Own Signer Interfaces

Different payment schemes have different signing requirements:

- **EVM exact scheme** requires EIP-712 typed data signing
- **SVM exact scheme** requires Ed25519 transaction signing
- **Future schemes** may require different signing methods entirely

Because signing requirements are mechanism-specific, **each mechanism package exports its own signer interface**.

### Client vs Facilitator Signer Shapes

Signer interfaces differ between client and facilitator roles:

#### Client Signers

**Purpose**: Create payment signatures locally (offline signing)

- **No blockchain interaction** - Pure cryptographic operations
- **No RPC required** - Works entirely offline
- **Lightweight** - Just signing, no network calls

**Example interfaces defined by mechanisms:**
- `mechanisms/evm.ClientEvmSigner` - EIP-712 signing
- `mechanisms/svm.ClientSvmSigner` - Ed25519 transaction signing

#### Facilitator Signers

**Purpose**: Verify signatures and execute payments on-chain

- **Blockchain interaction required** - Reads state, submits transactions
- **RPC required** - Connects to blockchain nodes
- **Complex** - Handles gas, nonces, confirmations

**Example interfaces defined by mechanisms:**
- `mechanisms/evm.FacilitatorEvmSigner` - Verify EIP-712, submit EIP-3009 transactions
- `mechanisms/svm.FacilitatorSvmSigner` - Verify transactions, submit to Solana

The facilitator signer interface is **significantly more complex** than the client signer interface because it must interact with the blockchain.

## What This Package Provides

This package provides **helper implementations** of mechanism-defined signer interfaces, eliminating boilerplate code.

### Current Helpers

**Client Signers Only** (currently available):

- **`signers/evm`** - Implements `mechanisms/evm.ClientEvmSigner` interface
  - Helper: `NewClientSignerFromPrivateKey(hexKey)` - Creates EVM client signer
  - Eliminates: ~130 lines of EIP-712 signing code

- **`signers/svm`** - Implements `mechanisms/svm.ClientSvmSigner` interface
  - Helper: `NewClientSignerFromPrivateKey(base58Key)` - Creates SVM client signer
  - Eliminates: ~70 lines of Ed25519 signing code

### Future Helpers

**Facilitator Signers** (planned):

- **`signers/evm`** (future) - Will implement `mechanisms/evm.FacilitatorEvmSigner`
  - Helper: `NewFacilitatorSignerFromPrivateKey(hexKey, rpcURL)`
  - Will eliminate: ~300 lines of RPC integration and transaction submission code

- **`signers/svm`** (future) - Will implement `mechanisms/svm.FacilitatorSvmSigner`
  - Helper: `NewFacilitatorSignerFromPrivateKey(base58Key, rpcURL)`
  - Will eliminate: ~250 lines of Solana RPC and transaction code

## Mechanism-First Design

The architecture flows from mechanisms to signers:

```
1. Mechanism Defines Interface
   ↓
   mechanisms/evm exports:
   - ClientEvmSigner interface (what clients need)
   - FacilitatorEvmSigner interface (what facilitators need)

2. Helpers Implement Interface
   ↓
   signers/evm exports:
   - NewClientSignerFromPrivateKey() → implements ClientEvmSigner
   - (future) NewFacilitatorSignerFromPrivateKey() → implements FacilitatorEvmSigner

3. Applications Use Helpers
   ↓
   signer := evmsigners.NewClientSignerFromPrivateKey(key)
   client.Register("eip155:*", evm.NewExactEvmScheme(signer))
```

### Why This Matters

- **Extensibility**: New mechanisms can define their own signer requirements
- **Flexibility**: Client and facilitator signers can have completely different interfaces
- **Modularity**: Signers are independent of the core protocol
- **Openness**: Anyone can implement mechanism-defined interfaces

## Interface Ownership

| Component | Defines Interface | Implements Interface |
|-----------|-------------------|---------------------|
| **EVM Client Signer** | `mechanisms/evm` package | `signers/evm` package (helper) |
| **EVM Facilitator Signer** | `mechanisms/evm` package | Application (or future helper) |
| **SVM Client Signer** | `mechanisms/svm` package | `signers/svm` package (helper) |
| **SVM Facilitator Signer** | `mechanisms/svm` package | Application (or future helper) |

Applications can always implement mechanism interfaces directly if the helpers don't meet their needs.

## Directory Structure

```
signers/
├── README.md           - This file
│
├── evm/                - EVM signer helpers
│   ├── client.go       - Implements mechanisms/evm.ClientEvmSigner
│   ├── client_test.go  - Tests
│   └── README.md       - EVM-specific documentation
│
└── svm/                - SVM signer helpers
    ├── client.go       - Implements mechanisms/svm.ClientSvmSigner
    ├── client_test.go  - Tests
    └── README.md       - SVM-specific documentation
```

## Usage

### EVM Client Signer

```go
import evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"

signer, _ := evmsigners.NewClientSignerFromPrivateKey("0x...")
// Returns: mechanisms/evm.ClientEvmSigner implementation
```

### SVM Client Signer

```go
import svmsigners "github.com/x402-foundation/x402/go/v2/signers/svm"

signer, _ := svmsigners.NewClientSignerFromPrivateKey("5J...")
// Returns: mechanisms/svm.ClientSvmSigner implementation
```

## Helper Philosophy

The helpers in this package:

- ✅ **Implement** mechanism-defined interfaces
- ✅ **Simplify** common use cases (private key signing)
- ✅ **Reduce boilerplate** by 95-99%
- ✅ **Are optional** - You can implement interfaces directly
- ❌ **Do NOT** define the signer interfaces (mechanisms do that)
- ❌ **Are NOT** required - Applications can implement mechanism interfaces themselves

## For New Mechanisms

When creating a new mechanism (e.g., a new payment scheme or blockchain):

1. **Define your signer interfaces** in your mechanism package
2. **Document the interface** clearly
3. **Optionally** create helpers in the `signers/` directory
4. **Different shapes for different roles** - Client vs facilitator signers can be completely different

The signers package is here to help, but it doesn't constrain what mechanisms can require.

## Related Documentation

- **[EVM Signers](evm/README.md)** - EVM-specific signer helpers
- **[SVM Signers](svm/README.md)** - SVM-specific signer helpers
- **[Mechanisms](../mechanisms/README.md)** - Mechanism implementations that define signer interfaces
- **[CLIENT.md](../CLIENT.md)** - Using client signers
- **[FACILITATOR.md](../FACILITATOR.md)** - Facilitator signer requirements
