# Casper Client Signer

Client-side EIP-712 signing for Casper-based x402 payments.

## Usage

```go
import (
    "os"

    x402CasperClient "github.com/x402-foundation/x402/go/v2/mechanisms/casper/exact/client"
    caspersigners "github.com/x402-foundation/x402/go/v2/signers/casper"
)

// Create signer from a hex-encoded secret in an environment variable
signer, err := caspersigners.NewClientSignerFromSecret(os.Getenv("CASPER_PRIVATE_KEY"), "ed25519")
if err != nil {
    log.Fatal(err)
}

// Use with ExactCasperScheme
casperScheme := x402CasperClient.NewExactCasperScheme(signer)
```

## API

### NewClientSignerFromKeyFile

```go
func NewClientSignerFromKeyFile(path, algo string) (*ClientSigner, error)
```

Loads a Casper private key from a PEM file on disk.

**Args:**
- `path`: Filesystem path to a PEM-encoded Casper secret key
- `algo`: Key algorithm — `"ed25519"` or `"secp256k1"` (empty string defaults to `"ed25519"`)

**Returns:**
- `*ClientSigner` ready to use with `casper/exact/client.NewExactCasperScheme`
- Error if the file cannot be read, the PEM cannot be parsed, or the algorithm is unsupported

**Examples:**

```go
// Ed25519 key from file
signer, _ := caspersigners.NewClientSignerFromKeyFile(
    "/etc/casper/secret_key.pem",
    "ed25519",
)

// secp256k1 key from file
signer, _ := caspersigners.NewClientSignerFromKeyFile(
    "/etc/casper/secret_key.pem",
    "secp256k1",
)

// algo defaults to ed25519 when empty
signer, _ := caspersigners.NewClientSignerFromKeyFile(
    os.Getenv("CASPER_KEY_PATH"), "",
)
```

### NewClientSignerFromSecret

```go
func NewClientSignerFromSecret(privateKeyHex string, algo string) (*ClientSigner, error)
```

Loads a Casper private key from a hex-encoded secret string. Useful when the key is read from an environment variable, secret manager, or configuration file rather than a PEM on disk.

**Args:**
- `privateKeyHex`: Hex-encoded Casper private key
- `algo`: Key algorithm — `"ed25519"` or `"secp256k1"` (empty string defaults to `"ed25519"`)

**Returns:**
- `*ClientSigner` ready to use with `casper/exact/client.NewExactCasperScheme`
- Error if the hex is malformed or the algorithm is unsupported

**Examples:**

```go
// From environment variable
signer, _ := caspersigners.NewClientSignerFromSecret(
    os.Getenv("CASPER_PRIVATE_KEY"), "ed25519",
)

// From vault / secret manager
signer, _ := caspersigners.NewClientSignerFromSecret(
    getSecretFromVault("casper-key"), "secp256k1",
)
```

## Interface Implementation

The helper implements `casper.ClientCasperSigner`:

```go
type ClientCasperSigner interface {
    AccountAddress() string
    PublicKey() string
    SignEIP712(digest [32]byte) ([65]byte, error)
}
```

### Methods

**`AccountAddress() string`**
- Returns the payer's Casper account hash as a 66-char hex string with a `"00"` prefix (e.g. `"00aabb..."`)
- This is the format required by the `ClientCasperSigner` interface and validated by `casper.IsValidAddress`
- Derived from the public key's account hash

**`PublicKey() string`**
- Returns the full public key hex with an algorithm prefix byte (`"01"` for ed25519, `"02"` for secp256k1) followed by 64 hex chars
- Format: `[algo_prefix][public_key_bytes]`

**`SignEIP712(digest [32]byte) ([65]byte, error)`**
- Signs a 32-byte EIP-712 digest
- Returns a 65-byte signature in the `[algo_byte][64_raw_sig_bytes]` format
- Compatible with `keypair.PublicKey.VerifySignature` used by the Casper facilitator
- Used by `ExactCasperScheme.CreatePaymentPayload` to authorize `TransferWithAuthorization` messages

## Supported Networks

Works with all Casper networks supported by the x402 mechanism:

**V2 Networks (CAIP-2 format):**
- `casper:casper` - Casper Mainnet
- `casper:casper-test` - Casper Testnet
- `casper:*` - Wildcard for all Casper networks

## Supported Algorithms

Casper supports two key algorithms:

**Ed25519** (default)
- Algorithm prefix: `"01"`
- Most common on Casper
- Recommended default

**secp256k1**
- Algorithm prefix: `"02"`
- Same curve family as Ethereum
- Use when interoperating with secp256k1 tooling

Both algorithms work with the same `ClientSigner` API — only the `algo` argument to the constructors changes.

## Signing Process

### How It Works

1. **Load Key:** Parse PEM or hex into a `keypair.PrivateKey` (ed25519 or secp256k1)
2. **Derive Public Key:** Compute the public key from the private key
3. **Sign:** When `SignEIP712` is called, sign the 32-byte digest using the algorithm's signing primitive
4. **Package:** Wrap the raw signature in a 65-byte array with the algorithm prefix byte so the facilitator can verify it

### EIP-712 Flow

`ExactCasperScheme.CreatePaymentPayload` builds an EIP-712 `TransferWithAuthorization` message, hashes it into a 32-byte digest, then calls `SignEIP712` to produce a signature. The signature, public key, and authorization struct are bundled into the V2 payment payload:

```go
// Client signs the EIP-712 digest
sig, _ := signer.SignEIP712(digest) // 65-byte signature

payload := casper.ExactCasperPayload{
    Signature: hex.EncodeToString(sig[:]),
    PublicKey: signer.PublicKey(),
    Authorization: casper.ExactCasperAuthorization{
        From:        signer.AccountAddress(),
        To:          requirements.PayTo,
        Value:       requirements.Amount,
        ValidAfter:  ...,
        ValidBefore: ...,
        Nonce:       ...,
    },
}
```

## Facilitator Signer

For server-side flows that verify signatures and submit transactions, the same package provides a `FacilitatorSigner` that implements `casper.FacilitatorCasperSigner`. It manages a registry of keys (one per network) and RPC URLs:

```go
signer := caspersigners.NewFacilitatorSigner(
    caspersigners.FacilitatorSignerConfig{
        Keys: map[string]keypair.PrivateKey{
            "casper:casper":      mainnetKey,
            "casper:casper-test": testnetKey,
        },
        RpcURLs: map[string]string{
            "casper:casper":      "https://node.cspr.cloud",
            "casper:casper-test": "https://node.testnet.cspr.cloud",
        },
        SpeculativeRpcURLs: map[string]string{
            "casper:casper":      "https://speculative.cspr.cloud",
            "casper:casper-test": "https://speculative.testnet.cspr.cloud",
        },
    },
)
```

The `FacilitatorSigner` provides network config resolution, signature verification, transaction signing, RPC submission via `PutTransaction`, and polling for execution via `WaitForTransaction`.

`SpeculativeRpcURLs` is optional. When no speculative endpoint is configured for a network, the exact facilitator uses its regular RPC URL to check the active token contract's `transfer_with_authorization` entry point, the payer's CEP-18 balance, the CEP-3009 nonce state, and the authorization's strict time bounds. These reads use one block's state root and timestamp. RPC failures reject verification. Settlement repeats verification before submitting the transaction; state can still change between that check and execution.

`WaitForTransaction` polls every `TransactionPollInterval` (default 4s) and gives up after `TransactionWaitTimeout` (default 60s; keep it below `casper.SettlementTTL`). A failed execution returns `*casper.TransactionExecutionError`, which the exact facilitator reports as terminal. A timeout leaves the outcome unknown, so the facilitator returns `settlement_pending` with the transaction hash and records it in its `PendingSettlementStore`. The resource server's automatic retry then waits on that same transaction instead of broadcasting a new one. Concurrent settles of the same authorization (token, payer, nonce) are rejected with `duplicate_settlement`. For multi-replica facilitators, inject a shared store with `SetPendingSettlementStore` and share one `casper.SettlementCache` via `ExactCasperSchemeConfig.SettlementCache`. The defaults are in-memory and per process.

## Security

### Private Key Format

Accepts two input formats:

- **PEM file** (`NewClientSignerFromKeyFile`) — the standard Casper key format produced by the official Casper CLI (`casper-client keygen`)
- **Hex string** (`NewClientSignerFromSecret`) — for keys loaded from environment variables, secret managers, or configuration

Both support ed25519 and secp256k1 keys.

### Signing Process

Uses the official `casper-go-sdk` primitives:
- `github.com/make-software/casper-go-sdk/v2/types/keypair` for key loading and signing
- Follows Casper's standard signature format (algorithm prefix byte + 64-byte raw signature)
- Compatible with all Casper wallets and verification tools

## Testing

Run tests:

```bash
go test github.com/x402-foundation/x402/go/v2/signers/casper -v
```

Use in your own tests:

```go
import (
    "testing"
    caspersigners "github.com/x402-foundation/x402/go/v2/signers/casper"
    "github.com/make-software/casper-go-sdk/v2/types/keypair"
)

func TestPayment(t *testing.T) {
    // Generate a fresh ed25519 key for the test
    key, _ := keypair.GeneratePrivateKey(keypair.ED25519)

    // Wrap it directly in the signer
    signer := &caspersigners.ClientSigner{Key: key} // for unit tests only

    // Test payment flow...
}
```

For convenience, the package's own tests generate keys in-memory using `keypair.GeneratePrivateKey`.

## Dependencies

- `github.com/make-software/casper-go-sdk/v2/types/keypair` - Casper SDK keypair primitives
- `github.com/x402-foundation/x402/go/v2/mechanisms/casper` - x402 Casper types and interfaces

## Generating Test Keys

To generate a Casper private key for testing:

```bash
# Using the official Casper CLI
casper-client keygen /tmp/casper-keys

# Files written:
#   /tmp/casper-keys/secret_key.pem   <- load with NewClientSignerFromKeyFile
#   /tmp/casper-keys/public_key.pem
#   /tmp/casper-keys/public_key_hex
```

The `secret_key.pem` file is what you pass to `NewClientSignerFromKeyFile` with `"ed25519"`.

## Related

- [../evm/README.md](../evm/README.md) - EVM client signer
- [../svm/README.md](../svm/README.md) - SVM client signer
- [../../mechanisms/casper/README.md](../../mechanisms/casper/README.md) - Casper mechanism documentation
- [../README.md](../README.md) - Signers package overview
