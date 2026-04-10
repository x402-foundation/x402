# EUR Settlement Example

Express.js server showing how to accept x402 payments and receive EUR via SEPA Instant instead of USDC. The server code is identical to the [standard Express example](../express/) — the only change is the `FACILITATOR_URL` in `.env`.

```typescript
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: { scheme: "exact", price: "$0.001", network: "eip155:84532", payTo: evmAddress },
        description: "European weather data",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }))
      .register("eip155:84532", new ExactEvmScheme()),
  ),
);

app.get("/weather", (_, res) => res.json({ city: "Berlin", weather: "partly cloudy" }));
```

Buyers pay USDC as usual. The facilitator settles to the seller's bank account in EUR via SEPA Instant. No changes to client code or SDK.

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- EVM address for receiving payments
- A EUR-capable facilitator URL (see below)

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and set the required variables:

- `EVM_ADDRESS` — your Ethereum address
- `FACILITATOR_URL` — endpoint of a facilitator that supports EUR settlement

2. Install and build from the typescript examples root:
```bash
cd ../../
pnpm install && pnpm build
cd servers/eur-settlement
```

3. Run the server:
```bash
pnpm dev
```

## Facilitator

The difference between standard USDC settlement and EUR settlement is one environment variable:

```bash
# Standard (USDC stays as USDC):
FACILITATOR_URL=https://x402.org/facilitator

# EUR settlement (USDC converted to EUR, sent via SEPA Instant):
FACILITATOR_URL=https://x402.asterpay.io/v2/x402
```

[AsterPay](https://asterpay.io) is used here as an example of a EUR-capable facilitator. Any facilitator that implements the same x402 HTTP interface and supports EUR conversion will work.

## How it works

The `price` field (e.g. `"$0.001"`) is the on-chain USDC amount the buyer pays — same as any other x402 server. The facilitator handles the USDC-to-EUR conversion and initiates a SEPA Instant transfer to the seller's linked bank account.

From the buyer's perspective, nothing changes. From the seller's perspective, EUR arrives in their bank account instead of USDC in their wallet.

## Testing

You can test using any of the example clients:

```bash
cd ../clients/fetch
# Ensure .env is set up
pnpm dev
```

Both endpoints require payment:
- `GET /weather` — 0.001 USDC
- `GET /market-data` — 0.01 USDC

## Example Endpoints

### `/weather`
```json
{
  "report": {
    "city": "Berlin",
    "weather": "partly cloudy",
    "temperature": 18,
    "unit": "celsius"
  }
}
```

### `/market-data`
```json
{
  "market": "EU",
  "indices": {
    "EURO STOXX 50": { "value": 5142.3, "change": "+0.8%" },
    "DAX": { "value": 18654.7, "change": "+1.1%" },
    "CAC40": { "value": 7832.1, "change": "+0.5%" }
  }
}
```

## Network

This example uses Base Sepolia (`eip155:84532`). For testnet USDC, see the [x402 quickstart](https://docs.x402.org/getting-started/quickstart-for-sellers).
