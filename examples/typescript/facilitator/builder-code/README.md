# Builder Code Facilitator Example

Express.js facilitator that verifies and settles payments and appends ERC-8021 wallet attribution (`w`) at settlement via `BuilderCodeFacilitatorExtension`.

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- Dedicated EVM facilitator private key with Base Sepolia ETH for transaction fees

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variables:

- `EVM_PRIVATE_KEY` - Base Sepolia facilitator private key
- `BUILDER_CODE` - Facilitator wallet builder code (e.g. `bc_example_facilitator`)
- `PORT` - Server port (optional, defaults to 4022)

**⚠️ Security Note:** The facilitator key is the signer used to settle payments on-chain. Keep it separate from your seller `payTo` wallet and buyer test wallets, and make sure it is funded only for facilitator gas/fees.

2. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd facilitator/builder-code
```

3. Run the server:

```bash
pnpm dev
```

## API Endpoints

### GET /supported

Returns payment schemes and networks this facilitator supports.

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:84532"
    }
  ],
  "extensions": [],
  "signers": {
    "eip155": ["0x..."]
  }
}
```

### POST /verify

Verifies a payment payload against requirements before settlement.

Request:

```json
{
  "paymentPayload": {
    "x402Version": 2,
    "resource": {
      "url": "http://localhost:4021/weather",
      "description": "Weather data",
      "mimeType": "application/json"
    },
    "accepted": {
      "scheme": "exact",
      "network": "eip155:84532",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "amount": "1000",
      "payTo": "0x...",
      "maxTimeoutSeconds": 300,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    },
    "payload": {
      "signature": "0x...",
      "authorization": {}
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:84532",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "amount": "1000",
    "payTo": "0x...",
    "maxTimeoutSeconds": 300,
    "extra": {
      "name": "USDC",
      "version": "2"
    }
  }
}
```

Response (success):

```json
{
  "isValid": true,
  "payer": "0x..."
}
```

Response (failure):

```json
{
  "isValid": false,
  "invalidReason": "invalid_signature"
}
```

### POST /settle

Settles a verified payment by broadcasting the transaction on-chain.

Request body is identical to `/verify`.

Response (success):

```json
{
  "success": true,
  "transaction": "0x...",
  "network": "eip155:84532",
  "payer": "0x..."
}
```

Response (failure):

```json
{
  "success": false,
  "errorReason": "insufficient_balance",
  "transaction": "",
  "network": "eip155:84532"
}
```

## Extending the Example

### Adding Networks

Register additional schemes for other networks:

```typescript
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";

const facilitator = new x402Facilitator();

facilitator.register("eip155:84532", new ExactEvmScheme(evmSigner));
```

### Lifecycle Hooks

Add custom logic before/after verify and settle operations:

```typescript
const facilitator = new x402Facilitator()
  .onBeforeVerify(async (context) => {
    // Log or validate before verification
  })
  .onAfterVerify(async (context) => {
    // Track verified payments
  })
  .onVerifyFailure(async (context) => {
    // Handle verification failures
  })
  .onBeforeSettle(async (context) => {
    // Validate before settlement
    // Return { abort: true, reason: "..." } to cancel
  })
  .onAfterSettle(async (context) => {
    // Track successful settlements
  })
  .onSettleFailure(async (context) => {
    // Handle settlement failures
  });
```

## Network Identifiers

Networks use [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) format:

- `eip155:84532` — Base Sepolia
- `eip155:8453` — Base Mainnet
