---
title: SDK Features
description: Feature parity across TypeScript, Go, Python, and Java SDKs
---

# SDK Features

This page tracks which features are implemented in each SDK (TypeScript, Go, Python v2, Java v2).

## Core

| Component | TypeScript | Go | Python | Java |
|-----------|------------|-----|--------|------|
| Server | ✅ | ✅ | ✅ | ✅ |
| Client | ✅ | ✅ | ✅ | ✅ |
| Facilitator | ✅ | ✅ | ✅ | ✅ |

### HTTP Framework Integrations

| Role | TypeScript | Go | Python | Java |
|------|------------|-----|--------|------|
| Server | Express, Hono, Next.js, Fastify | Gin, net/http, Echo | FastAPI, Flask | Spring WebMvc, Spring WebFlux |
| Client | Fetch, Axios | net/http | httpx, requests | java.net.http, Spring RestClient / RestTemplate / WebClient |

## Networks

| Network | TypeScript | Go | Python | Java |
|---------|------------|-----|--------|------|
| evm (EIP-155) | ✅ | ✅ | ✅ | ❌ |
| svm (Solana) | ✅ | ✅ | ✅ | ❌ |
| tvm (TON) | ✅ | ❌ | ✅ | ❌ |
| avm (Algorand) | ✅ | ❌ | ❌ | ❌ |
| stellar | ✅ | ❌ | ❌ | ❌ |
| aptos | ✅ | ❌ | ❌ | ❌ |
| casper | ✅ | ❌ | ❌ | ❌ |
| hedera | ✅ | ❌ | ❌ | ❌ |
| keeta | ✅ | ❌ | ❌ | ❌ |
| near | ✅ | ❌ | ❌ | ❌ |
| ccd (Concordium) | ✅ | ❌ | ❌ | ❌ |
| xrpl | ✅ | ❌ | ❌ | ❌ |
| cardano | ✅ | ❌ | ❌ | ✅ |

## Mechanisms

| Scheme | Network | `assetTransferMethod` | TypeScript | Go | Python | Java |
|--------|---------|------------------------|------------|-----|--------|------|
| exact | evm | `eip3009` | ✅ | ✅ | ✅ | ❌ |
| exact | evm | `permit2` | ✅ | ✅ | ✅ | ❌ |
| exact | svm | - | ✅ | ✅ | ✅ | ❌ |
| exact | avm | - | ✅ | ❌ | ❌ | ❌ |
| exact | stellar | - | ✅ | ❌ | ❌ | ❌ |
| exact | aptos | - | ✅ | ❌ | ❌ | ❌ |
| exact | casper | CEP-3009 | ✅ | ❌  | ❌ | ❌ |
| exact | hedera | - | ✅ | ❌ | ❌ | ❌ |
| exact | tvm | - | ✅ | ❌ | ✅ | ❌ |
| exact | keeta | - | ✅ | ❌ | ❌ | ❌ |
| exact | near | - | ✅ | ❌ | ❌ | ❌ |
| exact | ccd (Concordium) | sponsored V1 | ✅ | ❌ | ❌ | ❌ |
| exact | xrpl | `sequence` | ✅ | ❌ | ❌ | ❌ |
| exact | xrpl | `ticketSequence` | ✅ | ❌ | ❌ | ❌ |
| exact | cardano | `default` | ✅ | ❌ | ❌ | ✅ |
| exact | cardano | `masumi` | ✅ | ❌ | ❌ | ✅ |
| exact | cardano | `script` | ✅ | ❌ | ❌ | ✅ |
| upto | evm | `permit2` | ✅ | ✅ | ✅ | ❌ |
| upto | svm | - | ✅ | ✅ | ❌ | ❌ |
| batch-settlement | evm | `eip3009` | ✅ | ✅ | ✅ | ❌ |
| batch-settlement | evm | `permit2` | ✅ | ✅ | ✅ | ❌ |
| batch-settlement | svm | - | ✅ | ✅ | ❌ | ❌ |
| auth-capture | evm | `eip3009` | ✅ | ✅ | ❌ | ❌ |
| auth-capture | evm | `permit2` | ✅ | ✅ | ❌ | ❌ |

## Extensions

| Extension | TypeScript | Go | Python | Java |
|-----------|------------|-----|--------|------|
| bazaar (server) | ✅ | ✅ | ✅ | ✅ |
| bazaar (facilitator client - list) | ✅ | ✅ | ✅ | ❌ |
| bazaar (facilitator client - search) | ✅ | ✅ | ✅ | ❌ |
| builder-code | ✅ | ✅ | ✅ | ❌ |
| sign-in-with-x | ✅ | ✅ | ✅ | ❌ |
| payment-identifier | ✅ | ✅ | ✅ | ❌ |
| offer-receipt | ✅ | ❌ | ❌ | ❌ |
| eip2612-gas-sponsoring | ✅ | ✅ | ✅ | ❌ |
| erc20-approval-gas-sponsoring | ✅ | ✅ | ✅ | ❌ |

## Client Hooks

| Hook | TypeScript | Go | Python | Java |
|------|------------|-----|--------|------|
| onBeforePaymentCreation | ✅ | ✅ | ✅ | ✅ |
| onAfterPaymentCreation | ✅ | ✅ | ✅ | ✅ |
| onPaymentCreationFailure | ✅ | ✅ | ✅ | ✅ |
| onPaymentResponse | ✅ | ✅ | ✅ | ✅ |
| onPaymentRequired (HTTP) | ✅ | ✅ | ✅ | ❌ |

## Server Hooks

| Hook | TypeScript | Go | Python | Java |
|------|------------|-----|--------|------|
| onBeforeVerify | ✅ | ✅ | ✅ | ✅ |
| onAfterVerify | ✅ | ✅ | ✅ | ✅ |
| onVerifyFailure | ✅ | ✅ | ✅ | ✅ |
| onBeforeSettle | ✅ | ✅ | ✅ | ✅ |
| onAfterSettle | ✅ | ✅ | ✅ | ✅ |
| onSettleFailure | ✅ | ✅ | ✅ | ✅ |
| onVerifiedPaymentCanceled | ✅ | ✅ | ✅ | ✅ |
| onProtectedRequest (HTTP) | ✅ | ✅ | ✅ | ✅ |

## Facilitator Hooks

| Hook | TypeScript | Go | Python | Java |
|------|------------|-----|--------|------|
| onBeforeVerify | ✅ | ✅ | ✅ | ✅ |
| onAfterVerify | ✅ | ✅ | ✅ | ✅ |
| onVerifyFailure | ✅ | ✅ | ✅ | ✅ |
| onBeforeSettle | ✅ | ✅ | ✅ | ✅ |
| onAfterSettle | ✅ | ✅ | ✅ | ✅ |
| onSettleFailure | ✅ | ✅ | ✅ | ✅ |

## Extension Hooks

| Hook | TypeScript | Go | Python | Java |
|------|------------|-----|--------|------|
| enrichDeclaration | ✅ | ✅ | ✅ | ✅ |
| enrichPaymentRequiredResponse | ✅ | ❌ | ✅ | ✅ |
| enrichSettlementResponse | ✅ | ❌ | ✅ | ✅ |

## Hook Adapter Features

| Feature | TypeScript | Go | Python | Java |
|---------|------------|-----|--------|------|
| Scheme-level lifecycle hook adapters | ✅ | ✅ | ✅ | ✅ |
| Extension-level server lifecycle hook adapters | ✅ | ✅ | ✅ | ✅ |
| Extension-level server HTTP transport hook adapters | ✅ | ❌ | ✅ | ✅ |
| Extension-level client lifecycle hook adapters | ✅ | ❌ | ✅ | ❌ |
| Extension-level client HTTP transport hook adapters | ✅ | ✅ | ✅ | ❌ |

## MCP (Model Context Protocol)

| Feature | TypeScript | Go | Python | Java |
|---------|------------|-----|--------|------|
| MCP server payment wrapper | ✅ | ✅ | ✅ | ❌ |
| MCP client (auto-pay tools) | ✅ | ✅ | ✅ | ❌ |
| Bazaar discovery for MCP tools | ✅ | ✅ | ✅ | ❌ |

Java can build MCP tool declarations (`McpDiscoveryConfig`), but has no MCP server or client to serve them.

### MCP Client Hooks

| Hook | TypeScript | Go | Python | Java |
|------|------------|-----|--------|------|
| onPaymentRequired | ✅ | ✅ | ❌ | ❌ |
| onBeforePayment | ✅ | ✅ | ❌ | ❌ |
| onAfterPayment | ✅ | ✅ | ❌ | ❌ |

### MCP Server Hooks (payment wrapper)

| Hook | TypeScript | Go | Python | Java |
|------|------------|-----|--------|------|
| onBeforeExecution | ✅ | ✅ | ✅ | ❌ |
| onAfterExecution | ✅ | ✅ | ✅ | ❌ |
| onAfterSettlement | ✅ | ✅ | ✅ | ❌ |

## HTTP Server Features

| Feature | TypeScript | Go | Python | Java |
|---------|------------|-----|--------|------|
| dynamicPayTo | ✅ | ✅ | ✅ | ✅ |
| dynamicPrice | ✅ | ✅ | ✅ | ✅ |
| paywall (browser UI) | ✅ | ✅ | ✅ | ❌ (static fallback page) |

## Client Safety Features

| Feature | TypeScript | Go | Python | Java |
|---------|------------|-----|--------|------|
| spendControls (asset allowlist + USD cap) | ✅ | ✅ | ✅ | ✅ |
