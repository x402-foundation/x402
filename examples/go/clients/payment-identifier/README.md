# Payment Identifier Client Example

This example demonstrates how to use the `payment-identifier` extension on the client side for idempotent payment requests.

## What is the Payment Identifier Extension?

The payment-identifier extension allows clients to include a unique idempotency key with their payment. This enables:

- **Safe retries** - Retry failed requests without duplicate charges
- **Exactly-once semantics** - Ensure operations are processed only once
- **Payment tracking** - Track the same payment across multiple attempts

## How It Works

1. **Generate a payment ID** using `GeneratePaymentID()`
2. **Register a hook** to add the ID to extensions before payment creation
3. **Make requests** - the ID is automatically included
4. **Retry safely** - same ID means no duplicate processing

## Prerequisites

- Go 1.21 or higher
- EVM private key (testnet recommended)
- Running payment-identifier server (see [server example](../../servers/payment-identifier/))

## Setup

1. Copy `.env-example` to `.env`:

```bash
cp .env-example .env
```

2. Fill in the environment variables:

- `EVM_PRIVATE_KEY` - Your Ethereum private key
- `SERVER_URL` - URL of the server (default: http://localhost:4021/order)

3. Install dependencies and run:

```bash
go mod download
go run main.go
```

## Usage

### Generating a Payment ID

```go
import "github.com/x402-foundation/x402/go/extensions/paymentidentifier"

// Generate with default prefix "pay_"
id := paymentidentifier.GeneratePaymentID("")
// Result: "pay_7d5d747be160e280504c099d984bcfe0"

// Generate with custom prefix
id := paymentidentifier.GeneratePaymentID("order_")
// Result: "order_7d5d747be160e280504c099d984bcfe0"
```

### Adding Payment ID via Hook

```go
client := x402.Newx402Client().
    Register("eip155:*", evm.NewExactEvmScheme(signer))

paymentID := paymentidentifier.GeneratePaymentID("")

client.OnBeforePaymentCreation(func(ctx x402.PaymentCreationContext) (*x402.BeforePaymentCreationHookResult, error) {
    if ctx.Extensions == nil {
        return nil, nil
    }

    // Only add if server declared the extension
    if ctx.Extensions[paymentidentifier.PAYMENT_IDENTIFIER] == nil {
        return nil, nil
    }

    // Append our payment ID
    err := paymentidentifier.AppendPaymentIdentifierToExtensions(ctx.Extensions, paymentID)
    if err != nil {
        return nil, err
    }

    return nil, nil
})
```

### Validating a Payment ID

```go
// Check if an ID is valid (16-128 chars, alphanumeric + hyphens/underscores)
valid := paymentidentifier.IsValidPaymentID(id)

// Check if server requires payment identifier
required, err := paymentidentifier.ExtractPaymentIdentifierFromPaymentRequired(paymentRequiredBytes)
```

## Example Output

```
Generated Payment ID: pay_7d5d747be160e280504c099d984bcfe0

First Request (with payment ID)
Making request to: http://localhost:4021/order

[BeforePaymentCreation] Checking for payment-identifier extension...
  Payment identifier required: true
  Added payment ID: pay_7d5d747be160e280504c099d984bcfe0

Response (1.234s): {"orderId":"order_123","status":"created","paymentId":"pay_7d5d747be160e280504c099d984bcfe0"}

Second Request (SAME payment ID)
Making request to: http://localhost:4021/order
Expected: Server returns cached response without payment processing

Response (0.045s): {"orderId":"order_123","status":"already_processed","paymentId":"pay_7d5d747be160e280504c099d984bcfe0"}

Summary
  Payment ID: pay_7d5d747be160e280504c099d984bcfe0
  First request:  1.234s
  Second request: 0.045s
```

## Related Examples

- [Server Payment Identifier](../../servers/payment-identifier/) - How to handle payment IDs on the server
- [HTTP Client](../http/) - Basic client setup
- [Advanced Client](../advanced/) - More client patterns
