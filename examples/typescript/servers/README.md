# x402 Server Examples

This directory contains TypeScript server examples demonstrating how to protect API endpoints with x402 payment requirements.

## Directory Structure

| Directory | Description |
| --- | --- |
| [`express/`](./express/) | Using `@x402/express` middleware |
| [`self-facilitation/`](./self-facilitation/) | Express middleware with in-process SDK facilitator |
| [`hono/`](./hono/) | Using `@x402/hono` middleware |
| [`advanced/`](./advanced/) | Advanced patterns: hooks, dynamic pricing, custom tokens |
| [`custom/`](./custom/) | Manual implementation using only `@x402/core` |

## Framework Examples

The **express**, **self-facilitation**, and **hono** directories showcase the minimal approach to adding x402 paywalls to your API. These use our middleware packages that automatically handle:

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

The **custom** directory shows how to implement x402 payment handling manually using only `@x402/core`, without any middleware. Use this approach when:

- You need complete control over the payment flow
- You're using a web framework we don't have a package for (Koa, Fastify, etc.)
- You want to understand how x402 works under the hood

## Getting Started

1. Pick an example directory
2. Follow the README in that directory
3. Use one of the [clients](../clients/) to test your server

