---
title: SDK Features
description: Feature parity across TypeScript, Go, and Python SDKs
---

# SDK Features

This page tracks which features are implemented in each SDK (TypeScript, Go, Python v2).

## Core

| Component | TypeScript | Go | Python |
|-----------|------------|-----|--------|
| Server | ✅ | ✅ | ✅ |
| Client | ✅ | ✅ | ✅ |
| Facilitator | ✅ | ✅ | ✅ |

### HTTP Framework Integrations

| Role | TypeScript | Go | Python |
|------|------------|-----|--------|
| Server | Express, Hono, Next.js, Fastify | Gin, net/http, Echo | FastAPI, Flask |
| Client | Fetch, Axios | net/http | httpx, requests |

## Networks

| Network | TypeScript | Go | Python |
|---------|------------|-----|--------|
| evm (EIP-155) | ✅ | ✅ | ✅ |
| svm (Solana) | ✅ | ✅ | ✅ |
| avm (Algorand) | ✅ | ❌ | ❌ |
| stellar | ✅ | ❌ | ❌ |
| aptos | ✅ | ❌ | ❌ |
| hedera | ✅ | ❌ | ❌ |

## Mechanisms

| Scheme | Network | `assetTransferMethod` | TypeScript | Go | Python |
|--------|---------|------------------------|------------|-----|--------|
| exact | evm | `eip3009` | ✅ | ✅ | ✅ |
| exact | evm | `permit2` | ✅ | ✅ | ✅ |
| exact | svm | - | ✅ | ✅ | ✅ |
| exact | avm | - | ✅ | ❌ | ❌ |
| exact | stellar | - | ✅ | ❌ | ❌ |
| exact | aptos | - | ✅ | ❌ | ❌ |
| exact | hedera | - | ✅ | ❌ | ❌ |
| upto | evm | `permit2` | ✅ | ✅ | ✅ |

## Extensions

| Extension | TypeScript | Go | Python |
|-----------|------------|-----|--------|
| bazaar (server) | ✅ | ✅ | ✅ |
| bazaar (facilitator client - list) | ✅ | ✅ | ✅ |
| bazaar (facilitator client - search) | ✅ | ✅ | ✅ |
| sign-in-with-x | ✅ | ❌ | ❌ |
| payment-identifier | ✅ | ✅ | ✅ |
| offer-receipt | ✅ | ❌ | ❌ |
| eip2612-gas-sponsoring | ✅ | ✅ | ✅ |
| erc20-approval-gas-sponsoring | ✅ | ✅ | ✅ |

## Client Hooks

| Hook | TypeScript | Go | Python |
|------|------------|-----|--------|
| onBeforePaymentCreation | ✅ | ✅ | ✅ |
| onAfterPaymentCreation | ✅ | ✅ | ✅ |
| onPaymentCreationFailure | ✅ | ✅ | ✅ |
| onPaymentResponse | ✅ | ✅ | ❌ |
| onPaymentRequired (HTTP) | ✅ | ❌ | ❌ |

## Server Hooks

| Hook | TypeScript | Go | Python |
|------|------------|-----|--------|
| onBeforeVerify | ✅ | ✅ | ✅ |
| onAfterVerify | ✅ | ✅ | ✅ |
| onVerifyFailure | ✅ | ✅ | ✅ |
| onBeforeSettle | ✅ | ✅ | ✅ |
| onAfterSettle | ✅ | ✅ | ✅ |
| onSettleFailure | ✅ | ✅ | ✅ |
| onVerifiedPaymentCanceled | ✅ | ✅ | ❌ |
| onProtectedRequest (HTTP) | ✅ | ✅ | ❌ |

## Facilitator Hooks

| Hook | TypeScript | Go | Python |
|------|------------|-----|--------|
| onBeforeVerify | ✅ | ✅ | ✅ |
| onAfterVerify | ✅ | ✅ | ✅ |
| onVerifyFailure | ✅ | ✅ | ✅ |
| onBeforeSettle | ✅ | ✅ | ✅ |
| onAfterSettle | ✅ | ✅ | ✅ |
| onSettleFailure | ✅ | ✅ | ✅ |

## Extension Hooks

| Hook | TypeScript | Go | Python |
|------|------------|-----|--------|
| enrichDeclaration | ✅ | ✅ | ✅ |
| enrichPaymentRequiredResponse | ✅ | ❌ | ❌ |
| enrichSettlementResponse | ✅ | ❌ | ❌ |

## Hook Adapter Features

| Feature | TypeScript | Go | Python |
|---------|------------|-----|--------|
| Scheme-level lifecycle hook adapters | ✅ | ✅ | ❌ |
| Extension-level lifecycle hook adapters | ✅ | ✅ | ❌ |

## MCP (Model Context Protocol)

| Feature | TypeScript | Go | Python |
|---------|------------|-----|--------|
| MCP server payment wrapper | ✅ | ✅ | ✅ |
| MCP client (auto-pay tools) | ✅ | ✅ | ✅ |
| Bazaar discovery for MCP tools | ✅ | ✅ | ✅ |

## HTTP Server Features

| Feature | TypeScript | Go | Python |
|---------|------------|-----|--------|
| dynamicPayTo | ✅ | ✅ | ✅ |
| dynamicPrice | ✅ | ✅ | ✅ |
| paywall (browser UI) | ✅ | ✅ | ✅ |
