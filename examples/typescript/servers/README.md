# x402 Server Examples

This directory contains TypeScript server examples demonstrating how to protect API endpoints with x402 payment requirements.

## Directory Structure

| Directory | Description |
| --- | --- |
| [`express/`](./express/) | Using `@x402/express` middleware |
| [`hono/`](./hono/) | Using `@x402/hono` middleware |
| [`fastify/`](./fastify/) | Using `@x402/fastify` middleware |
| [`self-facilitation/`](./self-facilitation/) | Express middleware with in-process SDK facilitator |
| [`advanced/`](./advanced/) | Advanced patterns: hooks, dynamic pricing, custom tokens |
| [`custom/`](./custom/) | Manual implementation without an x402 middleware package |
| [`upto/`](./upto/) | `upto` scheme: authorize a ceiling, settle only actual usage |
| [`batch-settlement/`](./batch-settlement/) | Off-chain vouchers claimed and settled in batches by a `ChannelManager` |
| [`bazaar/`](./bazaar/) | Makes a paid API discoverable via the Bazaar extension |
| [`builder-code/`](./builder-code/) | ERC-8021 builder-code attribution on paid endpoints |
| [`offer-receipt/`](./offer-receipt/) | Signed offers (payment terms) and receipts (proof of delivery) |
| [`payment-identifier/`](./payment-identifier/) | Idempotency via the `payment-identifier` extension |
| [`sign-in-with-x/`](./sign-in-with-x/) | Auth-only routes and pay-once-then-authenticate routes |
| [`cloudfront-lambda-edge/`](./cloudfront-lambda-edge/) | Adds x402 at the CDN edge without modifying the backend |
| [`mcp/`](./mcp/) | MCP server exposing paid tools |

## Framework Examples

The **express**, **hono**, and **fastify** directories showcase the minimal approach to adding x402 paywalls to your API. These use our middleware packages that automatically handle:

1. Checking for payment headers on protected routes
2. Returning 402 with payment requirements if no payment
3. Verifying payments with the facilitator
4. Settling payments on-chain after successful responses

Pick the example that matches your web framework of choice.

## Advanced Examples

The **advanced** directory demonstrates advanced features supported by our middleware:

- **Lifecycle Hooks** — Run custom logic before/after verification and settlement
- **Dynamic Pricing** — Calculate prices at runtime based on request context
- **Dynamic PayTo** — Route payments to different recipients per request
- **Custom Tokens** — Accept payments in tokens other than USDC
- **Bazaar Discovery** — Make your API discoverable by clients and AI agents

These patterns are useful for production applications that need custom business logic, observability, or marketplace functionality.

## Custom Implementation

The **custom** directory shows how to implement x402 payment handling manually, without a prebuilt x402 middleware package. Use this approach when:

- You need complete control over the payment flow
- You're using a web framework we don't have a package for
- You want to understand how x402 works under the hood

## Getting Started

1. Pick an example directory
2. Follow the README in that directory, if it has one
3. Use one of the [clients](../clients/) to test your server

