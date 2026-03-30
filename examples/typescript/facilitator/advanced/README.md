# x402 Advanced Facilitator Examples

Express.js facilitator service demonstrating advanced x402 patterns including all-networks support, bazaar discovery, and lifecycle hooks.

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- EVM private key with Base Sepolia ETH for transaction fees
- SVM private key with Solana Devnet SOL for transaction fees
- Stellar private key with testnet XLM for transaction fees (fund via [Stellar Laboratory](https://lab.stellar.org/account/create) ➡️ Generate keypair ➡️ Fund account with Friendbot)

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variables:

- `EVM_PRIVATE_KEY` - Ethereum private key
- `SVM_PRIVATE_KEY` - Solana private key
- `STELLAR_PRIVATE_KEY` - Stellar secret key (starts with `S`)
- `PORT` - Server port (optional, defaults to 4022)

2. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd facilitator/advanced
```

3. Run an example:

```bash
pnpm dev:all-networks   # All supported networks
pnpm dev:bazaar         # Bazaar discovery extension
```

## Available Examples

Each example demonstrates a specific advanced pattern:

| Example        | Command                 | Description                                              |
| -------------- | ----------------------- | -------------------------------------------------------- |
| `all-networks` | `pnpm dev:all-networks` | All supported networks with optional chain configuration |
| `bazaar`       | `pnpm dev:bazaar`       | Bazaar discovery extension for cataloging x402 resources |

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
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "extra": {
        "feePayer": "..."
      }
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "stellar:testnet",
      "extra": {
        "areFeesSponsored": true
      }
    }
  ],
  "extensions": [],
  "signers": {
    "eip155": ["0x..."],
    "solana": ["..."],
    "stellar": ["G..."]
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
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";

const facilitator = new x402Facilitator();

registerExactEvmScheme(facilitator, {
  signer: evmSigner,
  networks: "eip155:84532",
});

registerExactSvmScheme(facilitator, {
  signer: svmSigner,
  networks: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
});
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
- `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` — Solana Devnet
- `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` — Solana Mainnet
- `stellar:testnet` — Stellar Testnet
- `stellar:pubnet` — Stellar Mainnet
