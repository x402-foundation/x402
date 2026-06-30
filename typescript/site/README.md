# x402 Demo Site

This is a [Next.js](https://nextjs.org) project that demonstrates the x402 payment protocol in action and showcases ecosystem builders. The demo site includes a modern UI and a facilitator backend that handles payment verification and settlement.

## Overview

x402 is an open protocol for internet-native payments built around the HTTP 402 status code. This demo site showcases how to implement x402 in a real-world application, demonstrating:

- Payment-gated content access
- Real-time payment verification
- Payment settlement
- Integration with EVM, SVM, and AVM blockchains

## Features

- **Payment Middleware**: Protect routes with a simple middleware configuration
- **Facilitator Backend**: Handle payment verification and settlement
- **Live Demo**: Try out the payment flow with a protected route

## Getting Started

### Prerequisites

- Node.js 20+
- A wallet with testnet USDC (for testing)

### Installation

1. Install dependencies:

  ```bash
  pnpm install
  ```

2. Configure your environment variables in `.env`:

  ```bash
  FACILITATOR_URL=your_facilitator_url
  RESOURCE_EVM_ADDRESS=your_evm_wallet_address
  RESOURCE_SVM_ADDRESS=your_solana_wallet_address
  RESOURCE_AVM_ADDRESS=your_algorand_wallet_address
  FACILITATOR_EVM_PRIVATE_KEY=your_evm_private_key
  FACILITATOR_SVM_PRIVATE_KEY=your_solana_private_key
  FACILITATOR_AVM_PRIVATE_KEY=your_algorand_private_key
  ```

  Optionally enable Hedera (registers `hedera:testnet` only when both are set):

  ```bash
  # FACILITATOR_HEDERA_PRIVATE_KEY must be an ECDSA (secp256k1) key
  FACILITATOR_HEDERA_ACCOUNT_ID=0.0.xxxx
  FACILITATOR_HEDERA_PRIVATE_KEY=your_hedera_ecdsa_private_key
  ```

  Optionally enable Keeta:

  ```bash
  FACILITATOR_KEETA_MNEMONIC=...
  # Optionally, specify an amount of signers to create for the facilitator
  # to process multiple settlement requests concurrently.
  # The accounts will be derived from the mnemonic set above and must be
  # funded manually.
  # FACILITATOR_KEETA_SIGNER_AMOUNT=2
  ```

### Running the Development Server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Project Structure

- `/app` - Next.js application code
  - `/facilitator` - Payment facilitator API routes
  - `/protected` - Example protected route
- `/middleware.ts` - x402 payment middleware configuration
- `/ecosystem` - Directory of ecosystem builders 

## How It Works

1. When a user tries to access a protected route, the middleware checks for a valid payment
2. If no payment is found, the server responds with HTTP 402
3. The client can then make a payment and retry the request
4. The facilitator backend verifies the payment and allows access

## Project discovery

Ecosystem page submissions are closed. To list or discover x402 services, use these community-maintained directories:

- [x402scan.com](https://x402scan.com)
- [Agentic.Market](https://agentic.market)
- [Pay.sh](https://pay.sh)
- [app.ampersend.ai/discover](https://app.ampersend.ai/discover)

Curated developer tools (third-party SDKs, extensions, and facilitators) are listed in the [Developer Tools docs](https://docs.x402.org/dev-tools/overview).

## Learn More

To learn more about the technologies used in this project:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API
- [x402 Protocol Documentation](https://github.com/x402-foundation/x402) - learn about the x402 payment protocol
- [EVM Documentation](https://ethereum.org/en/developers/docs/) - learn about Ethereum Virtual Machine

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Contributing

We welcome contributions! Please see our [Contributing Guidelines](https://github.com/x402-foundation/x402/blob/main/CONTRIBUTING.md) for details.

## License

This project is licensed under the MIT License - see the [LICENSE](https://github.com/x402-foundation/x402/blob/main/LICENSE) file for details.
