# Upfront Example Server (Go)

Gin server demonstrating the `upfront` payment flow on the `exact` scheme: the facilitator settles onchain **before** the route handler runs.

Use this when the resource needs on-chain finality before execution — for example, long-running handlers on Solana, where the default `authorization` flow requires the handler to finish before the signed transaction's blockhash expires (~60–90 seconds).

```go
accepts = append(accepts, x402http.PaymentOption{
	Scheme:  "exact",
	Price:   "$0.001",
	Network: evmNetwork,
	PayTo:   evmAddress,
	Extra: map[string]interface{}{
		"paymentFlow": "upfront",
	},
})
```

## Trust model

Under `upfront`, the payer commits funds before your handler runs. If the handler fails after settlement, the client has already paid; the middleware still echoes the settlement receipt in `PAYMENT-RESPONSE`.

## Prerequisites

- Go 1.24+
- Valid EVM and/or SVM addresses for receiving payments
- URL of a facilitator supporting the desired payment network — see the [facilitator list](https://www.x402.org/ecosystem?category=facilitators)

## Setup

1. Copy `.env-example` to `.env`:

```bash
cp .env-example .env
```

and fill required environment variables:

- `FACILITATOR_URL` — facilitator endpoint URL
- `EVM_PAYEE_ADDRESS` — Ethereum address to receive payments (optional if SVM is set)
- `SVM_PAYEE_ADDRESS` — Solana address to receive payments (optional if EVM is set)

2. Run the server:

```bash
go run .
```

On a paid request you should see settlement logged before the handler:

```
[upfront] settled (before-handler) tx=0x...
[upfront] handler running (settlement already completed)
```

The example uses `OnAfterSettle` on the resource server so settlement is logged at the correct phase. Gin's `SettlementHandler` runs after the handler and would show the wrong order for `upfront`.

## Testing the Server

You can test the server using one of the example clients:

### Using the HTTP Client

```bash
cd ../../clients/http
# Ensure .env is setup
go run .
```

The 402 response includes `extra.paymentFlow: "upfront"`.

## Example Endpoint

The server includes a single example endpoint at `/weather` that requires a payment of 0.001 USDC on Base Sepolia or Solana Devnet to access. Settlement happens before the handler returns the weather report.

Pair with [`facilitator/basic/`](../../facilitator/basic/) for local development.
