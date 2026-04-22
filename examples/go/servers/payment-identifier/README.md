# Payment Identifier Server Example

This example demonstrates how to use the `payment-identifier` extension to enable idempotency for payment requests.

## What is the Payment Identifier Extension?

The payment-identifier extension allows clients to provide a unique idempotency key with their payment. Resource servers can use this to:

- **Prevent duplicate charges** when clients retry failed requests
- **Ensure exactly-once processing** for payment-protected operations
- **Track payments** across multiple request attempts

## How It Works

1. **Server declares the extension** in the route configuration
2. **Client includes a payment ID** in the request
3. **Server extracts and validates** the payment ID
4. **Server checks for duplicates** before processing

## Prerequisites

- Go 1.21 or higher
- EVM address for receiving payments
- Facilitator URL

## Setup

1. Copy `.env-example` to `.env`:

```bash
cp .env-example .env
```

2. Fill in the environment variables:

- `EVM_PAYEE_ADDRESS` - Your Ethereum address to receive payments
- `FACILITATOR_URL` - URL of the facilitator service

3. Install dependencies and run:

```bash
go mod download
go run main.go
```

## Usage

### Declaring the Extension

```go
import "github.com/x402-foundation/x402/go/extensions/paymentidentifier"

// Require payment identifier (clients MUST provide one)
paymentIdExtension := paymentidentifier.DeclarePaymentIdentifierExtension(true)

// Or make it optional (clients MAY provide one)
paymentIdExtension := paymentidentifier.DeclarePaymentIdentifierExtension(false)

routes := x402http.RoutesConfig{
    "POST /order": {
        Accepts: x402http.PaymentOptions{...},
        Extensions: map[string]interface{}{
            paymentidentifier.PAYMENT_IDENTIFIER: paymentIdExtension,
        },
    },
}
```

### Extracting the Payment ID

```go
// In your handler
payload := c.MustGet("x402_payload").(x402.PaymentPayload)

paymentID, err := paymentidentifier.ExtractPaymentIdentifier(payload, true)
if err != nil {
    // Handle invalid payment ID
}

// Check for duplicate
if existingOrder, found := processedPayments[paymentID]; found {
    // Return cached response
}
```

## API

### POST /order

Creates an order with payment. Requires a payment identifier.

**Response (first request):**
```json
{
  "orderId": "order_1234567890",
  "status": "created",
  "paymentId": "pay_7d5d747be160e280504c099d984bcfe0",
  "message": "Order created successfully"
}
```

**Response (duplicate request with same payment ID):**
```json
{
  "orderId": "order_1234567890",
  "status": "already_processed",
  "paymentId": "pay_7d5d747be160e280504c099d984bcfe0",
  "message": "This payment was already processed"
}
```

## Production Considerations

- Replace the in-memory `processedPayments` map with Redis or a database
- Set appropriate TTL for payment ID records
- Consider distributed locking for high-concurrency scenarios

## Related Examples

- [Client Payment Identifier](../../clients/payment-identifier/) - How to add payment IDs on the client side
- [Gin Server](../gin/) - Basic server setup
- [Advanced Server](../advanced/) - More server patterns
