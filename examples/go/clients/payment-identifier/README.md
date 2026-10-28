# Payment Identifier Client Example

This example attaches a payment identifier to one logical purchase. The x402 HTTP client creates a fresh payment credential for that request. This client does not cache or replay `PAYMENT-SIGNATURE`, and it does not establish exactly-once effects.

## What this client does

- Generates a new payment identifier for each payload when the server declares `payment-identifier`
- Registers that behavior with `RegisterExtension` and `EnrichPaymentPayload`
- Issues one purchase. The SDK sends its unpaid probe and one payment retry with a fresh credential
- Leaves method, URL, query, body, and caller headers to that SDK payment retry

`PaymentCreationContext` contains `Ctx`, `Version`, and `SelectedRequirements`. It has no `Extensions` field. `OnBeforePaymentCreation` cannot inject the identifier.

The scheme method is `CreatePaymentPayload(ctx, requirements, payloadCtx)`. `payloadCtx` is a `PaymentPayloadContext`: the server extension map and the resolved spend cap. This example disables spend controls, so the cap is empty. `EnrichPaymentPayload` appends the identifier after the scheme returns.

A second purchase is a different request. Give it a new identifier and let the SDK create a new credential. Reusing one identifier with a new credential conflicts with credential-bound server state. TypeScript and Python examples can replay one captured header for one immutable URL and one selected set of accepted terms. This Go example does not.

## Prerequisites

- Go 1.24 (the module declares `go 1.24.0` and toolchain `go1.24.1`)
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

`go test ./...` builds this module against the local SDK (`replace` => `../../../../go`). It uses a local HTTP fixture and does not sign a transaction or contact a facilitator.

## Usage

### Generating a Payment ID

```go
import "github.com/x402-foundation/x402/go/v2/extensions/paymentidentifier"

// Generate with default prefix "pay_"
id := paymentidentifier.GeneratePaymentID("")
// Result: "pay_7d5d747be160e280504c099d984bcfe0"

// Generate with custom prefix
id := paymentidentifier.GeneratePaymentID("order_")
// Result: "order_7d5d747be160e280504c099d984bcfe0"
```

### Adding the identifier

Append the id from a client extension. An empty id tells `AppendPaymentIdentifierToExtensions` to mint one. The helper does nothing when the server did not declare a valid `payment-identifier` extension.

```go
import (
    "context"

    x402 "github.com/x402-foundation/x402/go/v2"
    "github.com/x402-foundation/x402/go/v2/extensions/paymentidentifier"
    exactevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/client"
)

type paymentIdentifierExtension struct{}

func (paymentIdentifierExtension) Key() string {
    return paymentidentifier.PAYMENT_IDENTIFIER
}

func (paymentIdentifierExtension) EnrichPaymentPayload(
    _ context.Context,
    payload x402.PaymentPayload,
    required x402.PaymentRequired,
) (x402.PaymentPayload, error) {
    extensions := map[string]interface{}{}
    for key, value := range payload.Extensions {
        extensions[key] = value
    }
    if _, ok := extensions[paymentidentifier.PAYMENT_IDENTIFIER]; !ok && required.Extensions != nil {
        if declared, ok := required.Extensions[paymentidentifier.PAYMENT_IDENTIFIER]; ok {
            extensions[paymentidentifier.PAYMENT_IDENTIFIER] = declared
        }
    }
    if err := paymentidentifier.AppendPaymentIdentifierToExtensions(extensions, ""); err != nil {
        return payload, err
    }
    payload.Extensions = extensions
    return payload, nil
}

client := x402.Newx402Client().
    Register("eip155:*", exactevm.NewExactEvmScheme(signer, nil)).
    RegisterExtension(paymentIdentifierExtension{})
```

`examples/go/clients/payment-identifier/main.go` is the runnable form. `WrapHTTPClientWithPayment` uses the `http.Client` transport you pass. This example does not wrap that transport with a credential cache.

### Validating a Payment ID

```go
// Check if an ID is valid (16-128 chars, alphanumeric + hyphens/underscores)
valid := paymentidentifier.IsValidPaymentID(id)

// Check if server requires payment identifier
required, err := paymentidentifier.ExtractPaymentIdentifierFromPaymentRequired(paymentRequiredBytes)
```

## Example Output

```
One logical purchase
Making request to: http://localhost:4021/order
The SDK creates a fresh payment credential for this request.
A new payment identifier is added only if the server advertises the extension.
The SDK sends one unpaid probe and one payment retry. It does not cache that credential.
Response (1.234s): {"orderId":"order_123","status":"created"}
Payment ID: pay_7d5d747be160e280504c099d984bcfe0
```

## Related Examples

- [Server Payment Identifier](../../servers/payment-identifier/) - How to handle payment IDs on the server
- [HTTP Client](../http/) - Basic client setup
- [Advanced Client](../advanced/) - More client patterns
