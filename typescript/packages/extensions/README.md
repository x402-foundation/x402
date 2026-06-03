# `@x402/extensions` • [![npm version](https://img.shields.io/npm/v/%40x402%2Fextensions.svg)](https://www.npmjs.com/package/@x402/extensions)

Optional add-ons for the [x402](https://github.com/x402-foundation/x402) payment protocol. This package implements extensions as typed `{ info, schema }` payloads attached to `PaymentRequired.extensions` and `PaymentPayload.extensions` (see the core types package for protocol fields).

## Installation

```bash
pnpm install @x402/extensions
```

## Overview

Use extensions when you want discovery metadata, wallet re-auth, signed offers/receipts, idempotency keys, or facilitator-assisted gas for Permit2 flows. Most extension entrypoints are published as **npm subpath imports** (for example `@x402/extensions/bazaar`). A few helpers are exported only from the **package root** `@x402/extensions` alongside the aggregate barrel.

Per-extension guides live next to the TypeScript sources in this repository:

| Extension | Summary | Typical import | Documentation |
|-----------|---------|----------------|-----------------|
| Bazaar discovery | Facilitators catalog paid HTTP or MCP tools from server-declared input/output hints | `@x402/extensions/bazaar` | [src/bazaar/README.md](src/bazaar/README.md) |
| Sign-In-With-X (SIWx) | CAIP-122 wallet auth for repeat access without repaying | `@x402/extensions/sign-in-with-x` | [src/sign-in-with-x/README.md](src/sign-in-with-x/README.md) |
| Offer / receipt | Signed offers in 402 responses and signed receipts after settlement | `@x402/extensions/offer-receipt` | [src/offer-receipt/README.md](src/offer-receipt/README.md) |
| Payment identifier | Client-supplied idempotency `id` for deduplication | `@x402/extensions/payment-identifier` | [src/payment-identifier/README.md](src/payment-identifier/README.md) |
| EIP-2612 gas sponsoring | Gasless Permit2 via EIP-2612 permit + facilitator `settleWithPermit` | `@x402/extensions` | [src/eip2612-gas-sponsoring/README.md](src/eip2612-gas-sponsoring/README.md) |
| ERC-20 approval gas sponsoring | Gasless Permit2 for tokens without EIP-2612 (pre-signed `approve`) | `@x402/extensions` | [src/erc20-approval-gas-sponsoring/README.md](src/erc20-approval-gas-sponsoring/README.md) |

## Related resources

- [x402 Core package](../core/README.md) — protocol types, resource server, and facilitator client primitives
