# x402 Client Examples

This directory contains TypeScript client examples demonstrating how to make HTTP requests to x402-protected endpoints.

## Directory Structure

| Directory | Description |
| --- | --- |
| [`fetch/`](./fetch/) | Using `@x402/fetch` with the native Fetch API |
| [`axios/`](./axios/) | Using `@x402/axios` with Axios |
| [`advanced/`](./advanced/) | Advanced patterns: lifecycle hooks, network preferences |
| [`custom/`](./custom/) | Manual implementation without `@x402/fetch` or `@x402/axios` |
| [`auth-capture/`](./auth-capture/) | Pays an auth-capture endpoint by signing an ERC-3009 `ReceiveWithAuthorization` |
| [`batch-settlement/`](./batch-settlement/) | Pays a sequence of requests over one payment channel using cumulative vouchers |
| [`builder-code/`](./builder-code/) | Verifies ERC-8021 builder-code attribution on the settlement transaction |
| [`erc7702/`](./erc7702/) | Paying from an ERC-7702 delegated EOA |
| [`offer-receipt/`](./offer-receipt/) | Extracts and verifies signed offers and receipts |
| [`payment-identifier/`](./payment-identifier/) | Idempotent retries via the `payment-identifier` extension |
| [`sign-in-with-x/`](./sign-in-with-x/) | Both SIWX flows: auth-only access and paid-once access |
| [`mcp/`](./mcp/) | MCP client that pays for tool calls |
| [`mcp-chatbot/`](./mcp-chatbot/) | Chatbot combining an LLM, MCP tool discovery, and x402 payments |

## Framework Examples

The **fetch** and **axios** directories showcase the minimal approach to integrating x402 payments into your HTTP client. These use our client interceptors that automatically handle the 402 payment flow:

1. Intercept 402 responses
2. Parse payment requirements
3. Create and sign payment
4. Retry request with payment header

Pick the example that matches your HTTP client of choice.

## Advanced Examples

The **advanced** directory demonstrates advanced features supported by our client interceptors:

- **Lifecycle Hooks** — Run custom logic before/after payment creation
- **Network Preferences** — Configure preferred payment networks with fallbacks

These patterns are useful for production applications that need observability, custom validation, or user preference handling.

## Custom Implementation

The **custom** directory shows how to implement x402 payment handling manually, without any client interceptors. Use this approach when:

- You need complete control over the payment flow
- You're integrating with an HTTP client we don't have a package for
- You want to understand how x402 works under the hood

## Getting Started

1. Pick an example directory
2. Follow the README in that directory, if it has one
3. Make sure you have a [server](../servers/) running to test against

