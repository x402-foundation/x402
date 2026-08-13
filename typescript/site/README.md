# x402 Facilitator

A standalone [Next.js](https://nextjs.org) service that runs the x402 testnet facilitator. It exposes the facilitator API used to verify and settle x402 payments across EVM, SVM, AVM, Aptos, Stellar, Hedera, Keeta, and XRPL.

## Endpoints

All routes live under `app/facilitator/`:

- `GET /facilitator/supported` — list the supported payment kinds (schemes/networks) the facilitator has registered.
- `POST /facilitator/verify` — verify an x402 payment. Body: `{ paymentPayload, paymentRequirements }`.
- `POST /facilitator/settle` — settle a verified x402 payment. Body: `{ paymentPayload, paymentRequirements }`.

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm

### Installation

From the `typescript/` workspace root:

```bash
pnpm install
```

### Configuration

Configure environment variables in `.env`. EVM and SVM keys are required; other networks are registered only when their variables are present (XRPL, which needs no key, is enabled by an explicit `FACILITATOR_XRPL_ENABLED=true` flag).

```bash
# Required
FACILITATOR_EVM_PRIVATE_KEY=your_evm_private_key
FACILITATOR_SVM_PRIVATE_KEY=your_solana_private_key

# Optional networks
FACILITATOR_AVM_PRIVATE_KEY=your_algorand_private_key
FACILITATOR_APTOS_PRIVATE_KEY=your_aptos_private_key

# Optional: Stellar (comma-separated signer keys; optional fee-bump signer)
FACILITATOR_STELLAR_PRIVATE_KEY=key1,key2
FACILITATOR_STELLAR_FEEBUMP_PRIVATE_KEY=your_stellar_feebump_key

# Optional: Hedera (FACILITATOR_HEDERA_PRIVATE_KEY must be an ECDSA (secp256k1) key)
FACILITATOR_HEDERA_ACCOUNT_ID=0.0.xxxx
FACILITATOR_HEDERA_PRIVATE_KEY=your_hedera_ecdsa_private_key

# Optional: Keeta
FACILITATOR_KEETA_MNEMONIC=...
# Number of signers to derive from the mnemonic for concurrent settlement (each must be funded).
# FACILITATOR_KEETA_SIGNER_AMOUNT=2

# Optional: XRPL (registers xrpl:1 testnet). No key or funds are needed: the
# payer signs the transaction and pays its fee, and the facilitator only
# verifies and submits the signed blob.
# FACILITATOR_XRPL_ENABLED=true
# Optional override for the default public testnet WebSocket endpoint.
# FACILITATOR_XRPL_TESTNET_WS_URL=wss://s.altnet.rippletest.net:51233

# Optional: builder attribution
FACILITATOR_BUILDER_CODE=your_builder_code
```

### Running the Development Server

```bash
pnpm dev
```

The facilitator API is served at [http://localhost:3000/facilitator](http://localhost:3000/facilitator).

## Project Structure

- `app/facilitator/index.ts` — facilitator setup and network/scheme registration
- `app/facilitator/verify/`, `settle/`, `supported/` — route handlers

## Learn More

- [x402 Protocol Documentation](https://github.com/x402-foundation/x402) — learn about the x402 payment protocol
- [Next.js Documentation](https://nextjs.org/docs) — learn about Next.js features and API

## Contributing

We welcome contributions! Please see our [Contributing Guidelines](https://github.com/x402-foundation/x402/blob/main/CONTRIBUTING.md) for details.

