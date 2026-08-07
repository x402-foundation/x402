# x402 Advanced Facilitator Examples

Express.js facilitator service demonstrating advanced x402 patterns including all-networks support, bazaar discovery, Permit2 gas-sponsoring extensions (`gas_extensions`), and lifecycle hooks.

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- EVM private key with Base Sepolia ETH for transaction fees
- SVM private key with Solana Devnet SOL for transaction fees
- Stellar private key with testnet XLM for transaction fees (fund via [Stellar Laboratory](https://lab.stellar.org/account/create) ➡️ Generate keypair ➡️ Fund account with Friendbot)
- Hedera account id + private key for Hedera testnet fees (optional)
- Keeta mnemonic (seed phrase) and wallet with Testnet KTA for transaction fees (create wallet on [Keeta Testnet Wallet](https://wallet.test.keeta.com/) and fund via [Keeta Testnet Faucet](https://faucet.test.keeta.com/))
- No XRPL account or key: the XRPL facilitator is keyless (the payer signs and pays transaction fees); set `XRPL_NETWORK` to enable it (optional)

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variables:

- `APTOS_PRIVATE_KEY` - Aptos Ed25519 private key for fee payer (optional; `all-networks`)
- `APTOS_RPC_URL` - Aptos RPC URL (optional; `all-networks`)
- `CCD_FACILITATOR_PRIVATE_KEY` - Concordium Ed25519 private key for sponsor signing (optional; `all-networks`)
- `CCD_FACILITATOR_ADDRESS` - Concordium sponsor account address (optional; `all-networks`)
- `CCD_NETWORK` - Concordium network CAIP-2 (optional; defaults to `ccd:4221332d34e1694168c2a0c0b3fd0f27`)
- `EVM_PRIVATE_KEY` - Ethereum private key
- `SVM_PRIVATE_KEY` - Solana private key
- `STELLAR_PRIVATE_KEY` - Stellar secret key (starts with `S`)
- `HEDERA_ACCOUNT_ID` - Hedera account id for fee payer (optional)
- `HEDERA_PRIVATE_KEY` - Hedera **ECDSA** private key (0x-prefixed or DER-encoded) for fee payer (optional)
- `KEETA_MNEMONIC` - Keeta mnemonic
- `XRPL_NETWORK` - XRPL network CAIP-2 (e.g., `xrpl:1` for XRPL Testnet); set to enable the keyless XRPL scheme (optional; `all-networks`)
- `XRPL_WS_URL` - Custom XRPL WebSocket endpoint (optional, defaults to the public endpoint for `XRPL_NETWORK`)
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
pnpm dev:gas-extensions # exact + upto with EIP-2612 and ERC-20 approval gas sponsoring
```

#### Aptos Testnet

For testing on Aptos testnet, you can obtain test tokens from these faucets:

- **Test APT**: https://aptos.dev/network/faucet or through an account on [geomi.dev](https://geomi.dev/manage/faucet)
- **Test USDC**: https://faucet.circle.com/

## Available Examples

Each example demonstrates a specific advanced pattern:

| Example          | Command                   | Description                                                               |
| ---------------- | ------------------------- | ------------------------------------------------------------------------- |
| `all-networks`   | `pnpm dev:all-networks`   | All supported networks with optional chain configuration                  |
| `bazaar`         | `pnpm dev:bazaar`         | Bazaar discovery extension for cataloging x402 resources                  |
| `gas_extensions` | `pnpm dev:gas-extensions` | Base Sepolia `exact` + `upto` with both Permit2 gas-sponsoring extensions |

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
      "network": "keeta:1413829460"
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
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "xrpl:1",
      "extra": {
        "areFeesSponsored": false
      }
    }
  ],
  "extensions": [],
  "signers": {
    "eip155": ["0x..."],
    "keeta": ["keeta_..."],
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

- `aptos:2` — Aptos Testnet
- `aptos:1` — Aptos Mainnet
- `eip155:84532` — Base Sepolia
- `eip155:8453` — Base Mainnet
- `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` — Solana Devnet
- `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` — Solana Mainnet
- `stellar:testnet` — Stellar Testnet
- `stellar:pubnet` — Stellar Mainnet
- `hedera:testnet` — Hedera Testnet
- `hedera:mainnet` — Hedera Mainnet
- `keeta:1413829460` — Keeta Testnet
- `keeta:21378` — Keeta Mainnet
- `xrpl:1` — XRPL Testnet
- `xrpl:0` — XRPL Mainnet
