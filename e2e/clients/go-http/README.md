# E2E Test Client: Go HTTP

This client demonstrates and tests the Go x402 HTTP client with both EVM and SVM payment support.

## What It Tests

### Core Functionality
- ✅ **V2 Protocol** - Modern x402 protocol with CAIP-2 networks
- ✅ **V1 Protocol** - Legacy x402 protocol with simple network names
- ✅ **Multi-chain Support** - Both EVM and SVM in a single client
- ✅ **HTTP RoundTripper Integration** - Transparent payment via Go's http.Client
- ✅ **Automatic Retry** - Handles 402 responses and retries with payment
- ✅ **Payment Response Extraction** - Decodes settlement info from headers

### Payment Mechanisms
- ✅ **EVM V2** - `eip155:*` wildcard scheme
- ✅ **EVM V1** - `base-sepolia` and `base` networks
- ✅ **SVM V2** - `solana:*` wildcard scheme
- ✅ **SVM V1** - `solana-devnet` and `solana` networks

## What It Demonstrates

### Usage Pattern

```go
import (
    x402 "github.com/x402-foundation/x402/go"
    x402http "github.com/x402-foundation/x402/go/http"
    "github.com/x402-foundation/x402/go/mechanisms/evm"
    evmv1 "github.com/x402-foundation/x402/go/mechanisms/evm/exact/v1"
    "github.com/x402-foundation/x402/go/mechanisms/svm"
    svmv1 "github.com/x402-foundation/x402/go/mechanisms/svm/exact/v1"
)

// Create x402 client with direct registration
x402Client := x402.Newx402Client()

// Register EVM support
x402Client.Register("eip155:*", evm.NewExactEvmClient(evmSigner))
x402Client.RegisterV1("base-sepolia", evmv1.NewExactEvmClientV1(evmSigner))

// Register SVM support  
x402Client.Register("solana:*", svm.NewExactSvmClient(svmSigner))
x402Client.RegisterV1("solana-devnet", svmv1.NewExactSvmClientV1(svmSigner))

// Create HTTP wrapper
httpClient := x402http.Newx402HTTPClient(x402Client)

// Wrap standard http.Client
client := x402http.WrapHTTPClientWithPayment(http.DefaultClient, httpClient)

// Make request - 402 responses handled automatically
resp, err := client.Get(url)
```

### Key Concepts Shown

1. **Builder Pattern** - Fluent API for registering multiple schemes
2. **Multi-Version Support** - V1 and V2 protocols coexist
3. **Multi-Chain Support** - EVM and SVM in one client
4. **HTTP Integration** - Wraps standard Go http.Client
5. **No Config Required** - SVM clients use network defaults
6. **Automatic Signing** - Real EIP-712 and Solana Ed25519 signatures

## Test Scenarios

This client is tested against:
- **Servers:** Express (TypeScript), Gin (Go)
- **Facilitators:** TypeScript, Go
- **Endpoints:** `/protected` (EVM), `/protected-svm` (SVM)
- **Networks:** Base Sepolia (EVM), Solana Devnet (SVM)

### Success Criteria
- ✅ Request succeeds with 200 status
- ✅ Payment response header present
- ✅ Transaction hash returned
- ✅ Payment marked as successful

## Running

```bash
# Via e2e test suite
cd e2e
pnpm test --client=go-http

# Direct execution (requires environment variables)
cd e2e/clients/go-http
export RESOURCE_SERVER_URL="http://localhost:4022"
export ENDPOINT_PATH="/protected"
export EVM_PRIVATE_KEY="0x..."
export SVM_PRIVATE_KEY="..."
./go-http
```

## Environment Variables

- `RESOURCE_SERVER_URL` - Server base URL
- `ENDPOINT_PATH` - Path to protected endpoint
- `EVM_PRIVATE_KEY` - Ethereum private key (hex with 0x prefix)
- `SVM_PRIVATE_KEY` - Solana private key (base58 encoded)

## Output Format

```json
{
  "success": true,
  "data": { "message": "Protected endpoint accessed" },
  "status_code": 200,
  "payment_response": {
    "success": true,
    "transaction": "0x...",
    "network": "eip155:84532",
    "payer": "0x..."
  }
}
```

## Implementation Details

### EVM Signer
- Derives address from private key
- Implements EIP-712 typed data signing
- Uses go-ethereum's crypto package
- Generates valid Ethereum signatures with recovery ID

### SVM Signer
- Uses ed25519 keypair
- Signs Solana transactions
- Partial signing (client signs, facilitator completes)

### RPC Resolution
- **Automatic** - SVM clients resolve RPC URLs from network config
- **No manual config needed** - Defaults to public Solana RPCs
- **Customizable** - Can override with `ClientConfig` if needed

## Dependencies

- `github.com/x402-foundation/x402/go` - Core x402 protocol
- `github.com/x402-foundation/x402/go/http` - HTTP integration
- `github.com/x402-foundation/x402/go/mechanisms/evm` - EVM mechanisms
- `github.com/x402-foundation/x402/go/mechanisms/svm` - SVM mechanisms
- `github.com/ethereum/go-ethereum` - Ethereum Go library
- `github.com/gagliardetto/solana-go` - Solana Go library
