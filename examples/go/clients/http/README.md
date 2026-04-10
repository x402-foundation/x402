# x402-http Example Client

Example client demonstrating how to use the x402 Go HTTP client to make requests to endpoints protected by the x402 payment protocol.

## Prerequisites

- Go 1.24 or higher
- A running x402 server (see [gin server example](../../servers/gin))
- Valid EVM and/or SVM private keys for making payments

## Setup

1. Install dependencies:
```bash
go mod download
```

2. Copy `.env-example` to `.env` and add your private keys:
```bash
cp .env-example .env
```

Required environment variables:
- `EVM_PRIVATE_KEY` - Ethereum private key for EVM payments
- `SVM_PRIVATE_KEY` - Solana private key for SVM payments (optional)
- `SERVER_URL` - Server endpoint (defaults to `http://localhost:4021/weather`)

**⚠️ Security Warning:** Never use mainnet keys in `.env` files! Use testnet keys only.

3. Run the client:
```bash
go run .
```

## Available Examples

### 1. Builder Pattern (`builder-pattern`)

Configure the client by chaining `.Register()` calls to map network patterns to scheme clients.

```bash
go run . builder-pattern
```

### 2. Mechanism Helper Registration (`mechanism-helper-registration`)

Use mechanism helpers with wildcard network registration for clean, simple configuration.

```bash
go run . mechanism-helper-registration
```

## Example Code

```go
import (
    x402 "github.com/x402-foundation/x402/go"
    x402http "github.com/x402-foundation/x402/go/http"
    evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/client"
    evmsigners "github.com/x402-foundation/x402/go/signers/evm"
)

// Create signer
signer, err := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("EVM_PRIVATE_KEY"))

// Configure client with builder pattern
client := x402.Newx402Client().
    Register("eip155:*", evm.NewExactEvmScheme(signer))

// Wrap HTTP client with payment handling
httpClient := x402http.WrapHTTPClientWithPayment(
    http.DefaultClient,
    x402http.Newx402HTTPClient(client),
)

// Make request to paid endpoint (payment is handled automatically)
resp, err := httpClient.Get("http://localhost:4021/weather")
body, _ := io.ReadAll(resp.Body)
fmt.Println(string(body))
```

## Example Output

```
Running example: builder-pattern

Making request to: http://localhost:4021/weather

✅ Response body:
  {
    "city": "San Francisco",
    "weather": "foggy",
    "temperature": 60,
    "timestamp": "2024-01-01T00:00:00Z"
  }

💰 Payment Details:
  Transaction: 0x1234567890abcdef...
  Network: eip155:84532
  Payer: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

## Network Registration

**Network identifiers** use [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) format:
- `eip155:84532` — Base Sepolia
- `eip155:8453` — Base Mainnet
- `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` — Solana Devnet
- `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` — Solana Mainnet

### Wildcard Registration

Register all networks of a type with a single signer:

```go
client.Register("eip155:*", evm.NewExactEvmScheme(evmSigner))
client.Register("solana:*", svm.NewExactSvmScheme(svmSigner))
```

### Specific Network Registration

Register specific networks with different signers:

```go
client.
    Register("eip155:*", evm.NewExactEvmScheme(defaultSigner)).    // Fallback for all EVM
    Register("eip155:1", evm.NewExactEvmScheme(mainnetSigner))     // Override for Ethereum Mainnet
```

More specific registrations take precedence over wildcards.

## Private Key Management

### Creating Signers

Use the signer helpers for easy key management:

```go
// EVM signer from hex private key (with or without 0x prefix)
evmSigner, err := evmsigners.NewClientSignerFromPrivateKey("0x1234...")

// SVM signer from base58 private key
svmSigner, err := svmsigners.NewClientSignerFromPrivateKey("5J7W...")

// From environment variable
evmSigner, err := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("EVM_PRIVATE_KEY"))
```

### Generating Test Keys

For testing, generate keys with these tools:

**Ethereum:**
```bash
# Using cast (foundry)
cast wallet new
```

**Solana:**
```bash
# Using solana CLI
solana-keygen new
```

## Testing Against Local Server

1. Start a local x402 server:
```bash
cd ../../servers/gin
go run main.go
```

2. Run the client in another terminal:
```bash
cd ../../clients/http
go run . builder-pattern
```

## Next Steps

See [Advanced Examples](../advanced/) for custom transport, retry logic and error handling.

## Related Resources

- [x402 Go Package Documentation](../../../../go/)
- [Signer Helpers Documentation](../../../../go/signers/)
- [Server Examples](../../servers/) — build servers that can receive these payments
