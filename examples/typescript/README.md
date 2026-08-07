# X402 TypeScript Examples

This directory contains a collection of TypeScript examples demonstrating how to use the X402 protocol in various contexts. These examples are designed to work with the X402 npm packages and share a workspace with the main X402 packages.

## Setup

Before running any examples, you need to install dependencies and build the packages:

```bash
# From the examples/typescript directory
pnpm install
pnpm build
```

## Example Structure

To see a full payment flow end to end, run a server from [`servers/`](./servers/) and point a client from [`clients/`](./clients/) at it.

### Clients

Clients that pay for x402-protected endpoints. See [`clients/`](./clients/).

| Directory | Description |
| --- | --- |
| [`fetch/`](./clients/fetch/) | `@x402/fetch` wrapper around the native Fetch API |
| [`axios/`](./clients/axios/) | `@x402/axios` payment interceptor |
| [`advanced/`](./clients/advanced/) | Builder-pattern registration, payment lifecycle hooks, network preferences |
| [`custom/`](./clients/custom/) | Manual payment handling without `@x402/fetch` or `@x402/axios` |
| [`auth-capture/`](./clients/auth-capture/) | Pays an auth-capture endpoint by signing an ERC-3009 `ReceiveWithAuthorization` |
| [`batch-settlement/`](./clients/batch-settlement/) | Pays a sequence of requests over one payment channel using cumulative vouchers |
| [`builder-code/`](./clients/builder-code/) | Verifies ERC-8021 builder-code attribution on the settlement transaction |
| [`erc7702/`](./clients/erc7702/) | Paying from an ERC-7702 delegated EOA |
| [`offer-receipt/`](./clients/offer-receipt/) | Extracts and verifies signed offers and receipts |
| [`payment-identifier/`](./clients/payment-identifier/) | Idempotent retries via the `payment-identifier` extension |
| [`sign-in-with-x/`](./clients/sign-in-with-x/) | Both SIWX flows: auth-only access and paid-once access |
| [`mcp/`](./clients/mcp/) | MCP client that pays for tool calls |
| [`mcp-chatbot/`](./clients/mcp-chatbot/) | Chatbot combining an LLM, MCP tool discovery, and x402 payments |

### Servers

Servers that put a paywall in front of a resource. See [`servers/`](./servers/).

| Directory | Description |
| --- | --- |
| [`express/`](./servers/express/) | `@x402/express` middleware |
| [`hono/`](./servers/hono/) | `@x402/hono` middleware |
| [`fastify/`](./servers/fastify/) | `@x402/fastify` middleware |
| [`advanced/`](./servers/advanced/) | Dynamic pricing, payment routing, lifecycle hooks, discoverability |
| [`custom/`](./servers/custom/) | Manual payment handling without an x402 middleware package |
| [`self-facilitation/`](./servers/self-facilitation/) | In-process `x402Facilitator` instead of an external facilitator URL |
| [`upto/`](./servers/upto/) | `upto` scheme: authorize a ceiling, settle only actual usage |
| [`batch-settlement/`](./servers/batch-settlement/) | Off-chain vouchers claimed and settled in batches by a `ChannelManager` |
| [`bazaar/`](./servers/bazaar/) | Makes a paid API discoverable via the Bazaar extension |
| [`builder-code/`](./servers/builder-code/) | ERC-8021 builder-code attribution on paid endpoints |
| [`offer-receipt/`](./servers/offer-receipt/) | Signed offers (payment terms) and receipts (proof of delivery) |
| [`payment-identifier/`](./servers/payment-identifier/) | Idempotency via the `payment-identifier` extension |
| [`sign-in-with-x/`](./servers/sign-in-with-x/) | Auth-only routes and pay-once-then-authenticate routes |
| [`cloudfront-lambda-edge/`](./servers/cloudfront-lambda-edge/) | Adds x402 at the CDN edge without modifying the backend |
| [`mcp/`](./servers/mcp/) | MCP server exposing paid tools |

### Fullstack

| Directory | Description |
| --- | --- |
| [`next/`](./fullstack/next/) | Next.js route protection with `@x402/next` middleware |
| [`miniapp/`](./fullstack/miniapp/) | Farcaster Mini App with x402-protected API routes |
| [`next-batch-settlement-redis/`](./fullstack/next-batch-settlement-redis/) | Next.js batch-settlement with Redis-backed channel storage |

### Facilitator

Services that verify and settle payments on-chain.

| Directory | Description |
| --- | --- |
| [`basic/`](./facilitator/basic/) | Minimal facilitator exposing `/verify` and `/settle` |
| [`advanced/`](./facilitator/advanced/) | All-networks support, Bazaar discovery, gas-sponsoring extensions, hooks |
| [`batch-settlement/`](./facilitator/batch-settlement/) | Submits batch-settlement contract calls |
| [`builder-code/`](./facilitator/builder-code/) | Appends ERC-8021 wallet attribution at settlement |

## Running Examples

Most example directories contain their own README with specific instructions for running that example. Navigate to the desired example directory and follow its instructions.

## Development

This workspace uses:

- pnpm for package management
- Turborepo for monorepo management
- TypeScript for type safety

The examples are designed to work with the main X402 packages, so they must be built before running any examples.

## A note on private keys

The examples in this folder commonly use private keys to sign messages. **Never put a private key with mainnet funds in a `.env` file**. This can result in keys getting checked into codebases and being drained.

There are many ways to generate a keypair to use exclusively for development, one way is via foundry:

```
# install foundry
curl -L https://foundry.paradigm.xyz | bash

# generate a new wallet
cast w new
```

You can fund your new wallet on most networks via the testnet [CDP Faucet](https://portal.cdp.coinbase.com/products/faucet), simply provide the address generated by cast.
