# @x402/self-facilitation Example Server

Express.js server demonstrating the same paywalled route shape as the `express` example, but using an in-process facilitator created with the SDK (`x402Facilitator`) instead of calling an external facilitator URL.

This is the best fit when you want the x402 payment flow but do not want to depend on an external facilitator service for verification and settlement.

## What is different from `servers/express`

- `servers/express` uses `HTTPFacilitatorClient` and `FACILITATOR_URL`
- `servers/self-facilitation` creates an SDK facilitator in the same process and passes it as a `FacilitatorClient`
- The route/payment middleware setup stays essentially the same

## When should I use self-facilitation?

Use this pattern when you want:

- full operational control over verification and settlement,
- no dependency on a third-party facilitator URL,
- a production path for a network you already operate directly,
- or a predictable environment for testing merchant-owned settlement logic.

Use `servers/express` with `HTTPFacilitatorClient` when you want the fastest integration against an external facilitator provider.

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- EVM private key with gas on the target network for settlement

## Networks in this example

This example supports the following EVM networks through environment configuration:

- `eip155:84532` - Base Sepolia
- `eip155:8453` - Base Mainnet
- `eip155:137` - Polygon Mainnet
- `eip155:80002` - Polygon Amoy

The default is `eip155:84532`.

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

Then fill required environment variables:

- `EVM_PRIVATE_KEY` - Ethereum private key used by the embedded facilitator
- `EVM_NETWORK` - Target network CAIP-2 id. Defaults to `eip155:84532`
- `EVM_RPC_URL` - Optional explicit RPC URL. Recommended for production deployments

If you are targeting mainnet, set both `EVM_NETWORK` and `EVM_RPC_URL` explicitly instead of relying on defaults.

2. Install and build all packages from the TypeScript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd servers/self-facilitation
```

3. Run the server:

```bash
pnpm dev
```

The server will log the selected network on startup.

## Production-oriented EVM notes

For Base and Polygon, this example uses dollar-string pricing (`"$0.001"`), which relies on the SDK's default-asset configuration for those networks.

For other EVM networks or non-default tokens:

- prefer explicit token configuration over implicit defaults,
- confirm whether the token path uses EIP-3009 or Permit2,
- and use a custom money parser or a direct token amount if you are not relying on an upstream default asset.

See `examples/typescript/servers/advanced/custom-money-definition.ts` for a starting point when you need non-default asset behavior.

## Testing the server

You can test with the existing client examples:

```bash
cd ../clients/fetch
pnpm dev
```

or

```bash
cd ../clients/axios
pnpm dev
```

Both clients follow the usual two-step x402 flow:
1. First request gets `402 Payment Required`
2. Client signs and retries with `PAYMENT` headers
3. Server verifies/settles via the embedded facilitator and returns `200`
