# x402 Upfront Example Server (Python)

FastAPI server demonstrating the `upfront` payment flow on the `exact` scheme: the facilitator settles on-chain **before** the route handler runs.

Use this when the resource needs on-chain finality before execution — for example, long-running handlers on Solana, where the default `authorization` flow requires the handler to finish before the signed transaction's blockhash expires (~60–90 seconds).

```python
routes = {
    "GET /weather": RouteConfig(
        accepts=PaymentOption(
            scheme="exact",
            price="$0.001",
            network="eip155:84532",
            pay_to=evm_address,
            extra={"paymentFlow": "upfront"},
        ),
        description="Weather data",
        mime_type="application/json",
    ),
}
```

## Trust model

Under `upfront`, the payer commits funds before your handler runs. If the handler fails after settlement, the client has already paid; the middleware still echoes the settlement receipt in `PAYMENT-RESPONSE`.

## Prerequisites

- Python 3.10+
- uv (install via [docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/))
- Valid EVM and SVM addresses for receiving payments
- URL of a facilitator supporting the desired payment network, see [facilitator list](https://www.x402.org/ecosystem?category=facilitators)

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variables:

- `FACILITATOR_URL` — facilitator endpoint URL
- `EVM_ADDRESS` — Ethereum address to receive payments
- `SVM_ADDRESS` — Solana address to receive payments

2. Install dependencies:

```bash
uv sync
```

3. Run the server:

```bash
uv run python main.py
```

On a paid request you should see settlement logged before the handler:

```
[upfront] settled (before-handler) tx=0x...
[upfront] handler running (settlement already completed)
```

## Testing the Server

You can test the server using one of the example clients:

### Using the httpx Client

```bash
cd ../../clients/httpx
# Ensure .env is setup
uv run python main.py
```

### Using the requests Client

```bash
cd ../../clients/requests
# Ensure .env is setup
uv run python main.py
```

The 402 response includes `extra.paymentFlow: "upfront"`.

## Example Endpoint

The server includes a single example endpoint at `/weather` that requires a payment of 0.001 USDC on Base Sepolia or Solana Devnet to access. Settlement happens before the handler returns the weather report.
