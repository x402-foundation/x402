# @x402/express Advanced Examples

Express.js server demonstrating advanced x402 patterns including dynamic pricing, payment routing, lifecycle hooks and API discoverability.

```typescript
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactKeetaScheme } from "@x402/keeta/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }))
  .register("eip155:84532", new ExactEvmScheme())
  .register("keeta:*", new ExactKeetaScheme())
  .register("stellar:*", new ExactStellarScheme())
  .onBeforeVerify(async ctx => console.log("Verifying payment..."))
  .onAfterSettle(async ctx => console.log("Settled:", ctx.result.transaction));

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "exact",
          price: ctx => (ctx.adapter.getQueryParam?.("tier") === "premium" ? "$0.01" : "$0.001"),
          network: "eip155:84532",
          payTo: evmAddress,
        },
      },
      "GET /weather-stellar": {
        accepts: {
          scheme: "exact",
          price: ctx => (ctx.adapter.getQueryParam?.("tier") === "premium" ? "$0.01" : "$0.001"),
          network: "stellar:*",
          payTo: stellarAddress,
        },
      },
      "GET /weather-keeta": {
        accepts: {
          scheme: "exact",
          price: ctx => (ctx.adapter.getQueryParam?.("tier") === "premium" ? "$0.01" : "$0.001"),
          network: "keeta:*",
          payTo: keetaAddress,
        },
      },
    },
    resourceServer,
  ),
);
```

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- Valid EVM for receiving payments
- URL of a facilitator supporting the desired payment network, see [facilitator list](https://www.x402.org/ecosystem?category=facilitators)

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variables:

- `FACILITATOR_URL` - Facilitator endpoint URL
- `APTOS_ADDRESS` - Aptos account address to receive payments (optional for `all-networks`)
- `CCD_ADDRESS` - Concordium account address to receive payments (optional for `all-networks`)
- `EVM_ADDRESS` - Ethereum address to receive payments
- `SVM_ADDRESS` - Solana address to receive payments (optional for `all-networks`)
- `STELLAR_ADDRESS` - Stellar public address (starts with `G`) to receive payments
- `HEDERA_ACCOUNT_ID` - Hedera account id to receive payments (optional for `all-networks`; format: `0.0.XXXXX`)
- `KEETA_ADDRESS` - Keeta address (starts with `keeta_`) to receive payments
- `XRPL_ADDRESS` - XRPL classic address (starts with `r`) to receive payments (optional for `all-networks`)
- `XRPL_NETWORK` - XRPL network CAIP-2 (optional, defaults to `xrpl:1` XRPL Testnet)
- `XRPL_AMOUNT` - XRPL price in drops (optional, defaults to `1000` = 0.001 XRP)

> **Hedera Testnet:** Get testnet HBAR from the [Hedera Faucet](https://portal.hedera.com/faucet).

2. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd servers/advanced
```

3. Run the server

```bash
pnpm dev
```

### Account Setup Instructions

#### Stellar Testnet

Stellar accounts need to be created and funded with both XLM and USDC. Instructions:

1. Go to [Stellar Laboratory](https://lab.stellar.org/account/create) ➡️ Generate keypair ➡️ Fund account with Friendbot, then copy the `Secret` and `Public` keys so you can use them.
2. Add USDC trustline (required to transact USDC): go to [Fund Account](https://lab.stellar.org/account/fund) ➡️ Paste your `Public Key` ➡️ Add USDC Trustline ➡️ paste your `Secret key` ➡️ Sign transaction ➡️ Add Trustline.
3. Get testnet USDC from [Circle Faucet](https://faucet.circle.com/) (select Stellar network).

#### Keeta Testnet

To create a Keeta Testnet wallet:

1. Go to [Keeta Testnet Wallet](https://wallet.test.keeta.com/) and follow the steps to create your wallet. Make sure to save your mnemonic (seed phrase) to keep access to your wallet. To get your Keeta address, click on "Receive" and copy the deposit address (starting with `keeta_`).
2. Use the [Keeta Testnet Faucet](https://faucet.test.keeta.com/) to send Testnet KTA to your wallet.
3. To get Testnet USDC on Keeta, go to the "Receive" page in the wallet, click on "Any token from Keeta Testnet", select "USDC from Base (Sepolia) Testnet" and copy the deposit address (starting with `0x`). Then go the [Circle Faucet](https://faucet.circle.com/), select Base network and enter your Base deposit address.

#### Aptos Testnet

For testing on Aptos testnet, you can obtain test tokens from these faucets:

- **Test APT**: https://aptos.dev/network/faucet or through an account on [geomi.dev](https://geomi.dev/manage/faucet)
- **Test USDC**: https://faucet.circle.com/

#### XRPL Testnet

The receiving account must exist on the ledger, i.e. hold the [base reserve](https://xrpl.org/docs/concepts/accounts/reserves) (currently 1 XRP):

1. Use the [XRPL Testnet faucet](https://xrpl.org/resources/dev-tools/xrp-faucets) to generate a funded account, and copy its classic address (starts with `r`) into `XRPL_ADDRESS`.
2. The `all-networks` example prices in XRP drops, so no further setup is needed. To receive issued-currency (IOU) payments instead, the receiving account must hold a [trust line](https://xrpl.org/docs/concepts/tokens/fungible-tokens) to the issuer.

## Available Examples

Each example demonstrates a specific advanced pattern:

| Example | Command | Description |
| --- | --- | --- |
| `all-networks` | `pnpm dev:all-networks` | All supported networks with optional chain configuration |
| `bazaar` | `pnpm dev:bazaar` | API discoverability via Bazaar |
| `hooks` | `pnpm dev:hooks` | Payment lifecycle hooks |
| `dynamic-price` | `pnpm dev:dynamic-price` | Context-based pricing |
| `dynamic-pay-to` | `pnpm dev:dynamic-pay-to` | Route payments to different recipients |
| `custom-money-definition` | `pnpm dev:custom-money-definition` | Accept alternative tokens |

## Testing the Server

You can test the server using one of the example clients:

### Using the Fetch Client

```bash
cd ../../clients/fetch
# Ensure .env is setup
pnpm dev
```

### Using the Axios Client

```bash
cd ../../clients/axios
# Ensure .env is setup
pnpm dev
```

## Example: Bazaar Discovery

Adding the discovery extension to make your API discoverable:

```typescript
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: "eip155:84532",
          payTo: evmAddress,
        },
        description: "Weather data",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { city: "San Francisco" },
            inputSchema: {
              properties: { city: { type: "string" } },
              required: ["city"],
            },
            output: {
              example: { city: "San Francisco", weather: "foggy", temperature: 60 },
            },
          }),
        },
      },
    },
    resourceServer,
  ),
);
```

**Use case:** Clients and AI agents can easily discover your service

## Example: Dynamic Pricing

Calculate prices at runtime based on request context:

```typescript
app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "exact",
          price: context => {
            const tier = context.adapter.getQueryParam?.("tier") ?? "standard";
            return tier === "premium" ? "$0.005" : "$0.001";
          },
          network: "eip155:84532",
          payTo: evmAddress,
        },
      },
    },
    resourceServer,
  ),
);
```

**Use case:** Implementing tiered pricing, user-based pricing, content-based pricing or any scenario where the price varies based on the request.

## Example: Dynamic PayTo

Route payments to different recipients based on request context:

```typescript
const addressLookup: Record<string, `0x${string}`> = {
  US: "0x...",
  UK: "0x...",
};

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: "eip155:84532",
          payTo: context => {
            const country = context.adapter.getQueryParam?.("country") ?? "US";
            return addressLookup[country];
          },
        },
      },
    },
    resourceServer,
  ),
);
```

**Use case:** Marketplace applications where payments should go to different sellers, content creators, or service providers based on the resource being accessed.

## Example: Lifecycle Hooks

Run custom logic before/after verification and settlement:

```typescript
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .onBeforeVerify(async context => {
    console.log("Before verify hook", context);
    // Abort verification by returning { abort: true, reason: string }
  })
  .onAfterSettle(async context => {
    await logPaymentToDatabase(context);
  })
  .onSettleFailure(async context => {
    // Return a result with recovered=true to recover from the failure
    // return { recovered: true, result: { success: true, transaction: "0x123..." } };
  });
```

Available hooks:

- `onBeforeVerify` — Run before verification (can abort)
- `onAfterVerify` — Run after successful verification
- `onVerifyFailure` — Run when verification fails (can recover)
- `onBeforeSettle` — Run before settlement (can abort)
- `onAfterSettle` — Run after successful settlement
- `onSettleFailure` — Run when settlement fails (can recover)

**Use case:**

- Log payment events to a database or monitoring system
- Perform custom validation before processing payments
- Implement retry or recovery logic for failed payments
- Trigger side effects (notifications, database updates) after successful payments

## Example: Custom Tokens

Accept payments in custom tokens. Register a money parser on the scheme to support alternative tokens for specific networks.

```typescript
import { ExactEvmScheme } from "@x402/evm/exact/server";

const resourceServer = new x402ResourceServer(facilitatorClient).register(
  "eip155:84532",
  new ExactEvmScheme().registerMoneyParser(async (amount, network) => {
    // Use Wrapped XDAI on Gnosis Chain
    if (network === "eip155:100") {
      return {
        amount: BigInt(Math.round(amount * 1e18)).toString(),
        asset: "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d",
        extra: { token: "Wrapped XDAI" },
      };
    }
    return null; // Fall through to default parser
  }),
);

// Use in payment requirements
"GET /weather": {
  accepts: {
    scheme: "exact",
    price: "$0.001",
    network: "eip155:100",
    payTo: evmAddress,
  },
},
```

**Use case:** When you want to accept payments in tokens other than USDC, or use different tokens based on conditions (e.g., DAI for large amounts, custom tokens for specific networks).

## Response Format

### Payment Required (402)

```
HTTP/1.1 402 Payment Required
Content-Type: application/json; charset=utf-8
PAYMENT-REQUIRED: <base64-encoded JSON>

{}
```

The `PAYMENT-REQUIRED` header contains base64-encoded JSON with the payment requirements. Note: `amount` is in atomic units (e.g., 1000 = 0.001 USDC, since USDC has 6 decimals).

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://localhost:4021/weather",
    "description": "Weather data",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "1000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x...",
      "maxTimeoutSeconds": 300,
      "extra": {
        "name": "USDC",
        "version": "2",
        "resourceUrl": "http://localhost:4021/weather"
      }
    }
  ]
}
```

### Successful Response

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
PAYMENT-RESPONSE: <base64-encoded JSON>

{"report":{"weather":"sunny","temperature":70}}
```

The `PAYMENT-RESPONSE` header contains base64-encoded JSON with the settlement details:

```json
{
  "success": true,
  "transaction": "0x...",
  "network": "eip155:84532",
  "payer": "0x...",
  "requirements": {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "1000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x...",
    "maxTimeoutSeconds": 300,
    "extra": {
      "name": "USDC",
      "version": "2",
      "resourceUrl": "http://localhost:4021/weather"
    }
  }
}
```
