# EVM Client Signer

Client-side EIP-712 signing for Ethereum-based x402 payments.

## Usage

```go
import (
    evmclient "github.com/x402-foundation/x402/go/mechanisms/evm/exact/client"
    evmsigners "github.com/x402-foundation/x402/go/signers/evm"
)

// Create signer from private key
signer, err := evmsigners.NewClientSignerFromPrivateKey("0x1234...")
if err != nil {
    log.Fatal(err)
}

// Use with ExactEvmScheme
evmScheme := evmclient.NewExactEvmScheme(signer)
```

## API

### NewClientSignerFromPrivateKey

```go
func NewClientSignerFromPrivateKey(privateKeyHex string) (evm.ClientEvmSigner, error)
```

Creates a client signer from a hex-encoded private key.

**Args:**
- `privateKeyHex`: Hex-encoded private key (with or without "0x" prefix)

**Returns:**
- `evm.ClientEvmSigner` implementation
- Error if key is invalid

**Examples:**

```go
// With 0x prefix
signer, _ := evmsigners.NewClientSignerFromPrivateKey("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")

// Without 0x prefix (both work)
signer, _ := evmsigners.NewClientSignerFromPrivateKey("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")

// From environment variable
signer, _ := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("PRIVATE_KEY"))
```

## Interface Implementation

The helper implements `evm.ClientEvmSigner`:

```go
type ClientEvmSigner interface {
    Address() string
    SignTypedData(ctx context.Context, domain TypedDataDomain, types map[string][]TypedDataField, 
                  primaryType string, message map[string]interface{}) ([]byte, error)
}
```

### Methods

**`Address() string`**
- Returns the Ethereum address (checksummed with 0x prefix)
- Example: `"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"`

**`SignTypedData(...) ([]byte, error)`**
- Signs EIP-712 typed data (used for EIP-3009 authorization)
- Returns 65-byte signature (r, s, v format)
- v value is 27 or 28 (Ethereum standard)

## Supported Networks

Works with all EVM-compatible networks:

**V2 Networks (CAIP-2 format):**
- `eip155:1` - Ethereum Mainnet
- `eip155:8453` - Base Mainnet
- `eip155:84532` - Base Sepolia
- `eip155:*` - Wildcard for all EVM chains

**V1 Networks (legacy):**
- `base`, `base-sepolia`, `base-mainnet`
- `polygon`, `avalanche`, `sei`, etc.

## What It Eliminates

Without this helper, users must manually implement:

1. Private key parsing (10 lines)
2. Address derivation (3 lines)
3. EIP-712 type conversion (15 lines)
4. Domain construction (10 lines)
5. Struct hashing (10 lines)
6. Digest creation (5 lines)
7. ECDSA signing (5 lines)
8. v value adjustment (2 lines)
9. Error handling (20 lines)
10. Helper functions (40 lines)

**Total: 130 lines → 1 line (99% reduction!)**

## Security

### Private Key Format

Accepts standard Ethereum private key formats:
- 64 hex characters (32 bytes)
- Optional "0x" prefix

### Signing Process

Uses industry-standard libraries:
- `github.com/ethereum/go-ethereum` for EIP-712 implementation
- Follows EIP-712 specification exactly
- Compatible with all Ethereum wallets and tools

### Best Practices

```go
// ✅ Good: Load from secure source
signer, _ := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("PRIVATE_KEY"))

// ✅ Good: Load from vault/secret manager
signer, _ := evmsigners.NewClientSignerFromPrivateKey(getSecretFromVault("evm-key"))

// ❌ Bad: Hardcoded in source
signer, _ := evmsigners.NewClientSignerFromPrivateKey("0x1234...")
```

## Testing

Run tests:

```bash
go test github.com/x402-foundation/x402/go/signers/evm -v
```

Use in your own tests:

```go
import (
    "testing"
    evmsigners "github.com/x402-foundation/x402/go/signers/evm"
)

func TestPayment(t *testing.T) {
    // Use test private key
    testKey := "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    signer, _ := evmsigners.NewClientSignerFromPrivateKey(testKey)
    
    // Test payment flow...
}
```

## Dependencies

- `github.com/ethereum/go-ethereum` - Core Ethereum library
- `github.com/x402-foundation/x402/go/mechanisms/evm` - x402 EVM types

## Related

- [../svm/README.md](../svm/README.md) - SVM client signer
- [../../mechanisms/evm/README.md](../../mechanisms/evm/README.md) - EVM mechanism documentation
- [../README.md](../README.md) - Signers package overview

