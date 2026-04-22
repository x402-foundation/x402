# Custom x402 Client Implementation

Example client demonstrating how to implement x402 payment handling manually using only the core packages, without convenience wrappers like `x402http.WrapHTTPClientWithPayment`.

## Prerequisites

- Go 1.24 or higher
- Valid EVM private key for making payments
- A running x402 server (see [server examples](../../servers/))

## Setup

1. Copy `.env-example` to `.env`:

```bash
cp .env-example .env
```

and fill required environment variables:

- `EVM_PRIVATE_KEY` - Ethereum private key for EVM payments
- `SERVER_URL` - Server endpoint (defaults to `http://localhost:4021/weather`)

2. Install dependencies:

```bash
go mod download
```

3. Run the example:

```bash
go run .
```

## Testing the Example

Start a server first:

```bash
cd ../../servers/gin
go run main.go
```

Then run the custom client:

```bash
cd ../../clients/custom
go run .
```

## HTTP Headers (v2 Protocol)

| Header              | Direction       | Description                            |
| ------------------- | --------------- | -------------------------------------- |
| `PAYMENT-REQUIRED`  | Server → Client | 402 response with payment requirements |
| `PAYMENT-SIGNATURE` | Client → Server | Retry request with payment payload     |
| `PAYMENT-RESPONSE`  | Server → Client | 200 response with settlement details   |

## Payment Flow

1. **Initial Request** — Make HTTP request to protected endpoint
2. **402 Response** — Server responds with requirements in `PAYMENT-REQUIRED` header
3. **Parse Requirements** — Decode requirements using version detection
4. **Create Payment** — Use `x402Client.CreatePaymentPayload()` to generate payload
5. **Encode Payment** — Base64 encode the payload for the header value
6. **Retry with Payment** — Make new request with `PAYMENT-SIGNATURE` header
7. **Success** — Receive 200 with settlement in `PAYMENT-RESPONSE` header

## Key Implementation Details

### 1. Setting Up the Client

```go
import (
    x402 "github.com/x402-foundation/x402/go"
    evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/client"
    evmsigners "github.com/x402-foundation/x402/go/signers/evm"
)

evmSigner, _ := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("EVM_PRIVATE_KEY"))

client := x402.Newx402Client().
    Register("eip155:*", evm.NewExactEvmScheme(evmSigner))
```

### 2. Detecting Payment Required

```go
resp, _ := http.DefaultClient.Do(req)

if resp.StatusCode == http.StatusPaymentRequired {
    // Extract PAYMENT-REQUIRED header
    headerValue := resp.Header.Get("PAYMENT-REQUIRED")
    decoded, _ := base64.StdEncoding.DecodeString(headerValue)
    
    var paymentRequired types.PaymentRequired
    json.Unmarshal(decoded, &paymentRequired)
    // paymentRequired.Accepts contains the payment options
}
```

### 3. Creating Payment Payload

```go
// Select first payment requirement
requirements := paymentRequired.Accepts[0]

// Create payment payload using the x402 client
payload, _ := x402Client.CreatePaymentPayload(ctx, requirements, 
    paymentRequired.Resource, paymentRequired.Extensions)

payloadBytes, _ := json.Marshal(payload)
encodedPayment := base64.StdEncoding.EncodeToString(payloadBytes)
```

### 4. Retrying with Payment

```go
retryReq, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
retryReq.Header.Set("PAYMENT-SIGNATURE", encodedPayment)

retryResp, _ := http.DefaultClient.Do(retryReq)
```

### 5. Extracting Settlement

```go
settlementHeader := resp.Header.Get("PAYMENT-RESPONSE")
decoded, _ := base64.StdEncoding.DecodeString(settlementHeader)

var settlement x402.SettleResponse
json.Unmarshal(decoded, &settlement)
// settlement.Transaction, settlement.Network, settlement.Payer
```

## Wrapper vs Custom Comparison

| Aspect            | With Wrapper (x402http) | Custom Implementation |
| ----------------- | ----------------------- | --------------------- |
| Code Complexity   | ~10 lines               | ~250 lines            |
| Automatic Retry   | ✅ Yes                  | ❌ Manual             |
| Error Handling    | ✅ Built-in             | ❌ You implement      |
| Header Management | ✅ Automatic            | ❌ Manual             |
| Flexibility       | Limited                 | ✅ Complete control   |

## When to Use Custom Implementation

- Need complete control over every step of the payment flow
- Integrating with non-standard HTTP libraries (Resty, Fiber, etc.)
- Implementing custom retry/error logic
- Learning how x402 works under the hood
- Building adapters for unsupported frameworks

## Protocol Versions

The example handles both v1 and v2 protocols:

**V2 Protocol (recommended):**
- Payment requirements in `PAYMENT-REQUIRED` header
- Payment signature in `PAYMENT-SIGNATURE` header

**V1 Protocol (legacy):**
- Payment requirements in response body with `x402Version: 1`
- Payment signature in `X-PAYMENT` header

## Next Steps

- **[Basic HTTP Client](../http/)** — See the simple wrapper approach
- **[Server Examples](../../servers/)** — Build servers that accept payments

## Related Resources

- [x402 Go Package Documentation](../../../../go/)
- [HTTP Client Package](../../../../go/http/)
- [Payment Types](../../../../go/types/)
