# @x402/upfront Example Server

Express.js server demonstrating the `upfront` payment flow on the `exact` scheme: the facilitator settles on-chain **before** the route handler runs.

Use this when the resource needs on-chain finality before execution — for example, long-running handlers on Solana, where the default `authorization` flow requires the handler to finish before the signed transaction's blockhash expires (~60–90 seconds).

```typescript
app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: "eip155:84532",
          payTo: evmAddress,
          extra: { paymentFlow: "upfront" },
        },
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);
```

## Trust model

Under `upfront`, the payer commits funds before your handler runs. If the handler fails after settlement, the client has already paid; the middleware still echoes the settlement receipt in `PAYMENT-RESPONSE`.

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
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

2. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd servers/upfront
```

3. Run the server:

```bash
pnpm dev
```

On a paid request you should see settlement logged before the handler:

```
[upfront] settled (before-handler) tx=0x...
[upfront] handler running (settlement already completed)
```

## Testing the Server

You can test the server using one of the example clients:

### Using the Fetch Client

```bash
cd ../clients/fetch
# Ensure .env is setup
pnpm dev
```

### Using the Axios Client

```bash
cd ../clients/axios
# Ensure .env is setup
pnpm dev
```

The 402 response includes `extra.paymentFlow: "upfront"`.

## Example Endpoint

The server includes a single example endpoint at `/weather` that requires a payment of 0.001 USDC on Base Sepolia or Solana Devnet to access. Settlement happens before the handler returns the weather report.
