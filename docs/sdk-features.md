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
| Server | Express, Hono, Next.js | Gin, net/http | FastAPI, Flask |
| Client | Fetch, Axios | net/http | httpx, requests |

## Networks

| Network | TypeScript | Go | Python |
|---------|------------|-----|--------|
| evm (EIP-155) | ✅ | ✅ | ✅ |
| svm (Solana) | ✅ | ✅ | ✅ |
| stellar | ✅ | ❌ | ❌ |
| aptos | ✅ | ❌ | ❌ |

## Mechanisms

| Mechanism | TypeScript | Go | Python |
|-----------|------------|-----|--------|
| exact/evm (EIP-3009) | ✅ | ✅ | ✅ |
| exact/evm (Permit2) | ✅ | ✅ | ✅ |
| exact/svm (SPL) | ✅ | ✅ | ✅ |
| exact/stellar (Soroban) | ✅ | ❌ | ❌ |
| exact/aptos (Fungible Assets) | ✅ | ❌ | ❌ |
| upto/evm (Permit2) | ✅ | ✅ | ❌ |

## Extensions

| Extension | TypeScript | Go | Python |
|-----------|------------|-----|--------|
| bazaar (server) | ✅ | ✅ | ✅ |
| bazaar (facilitator client) | ✅ | ✅ | ✅ |
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

## HTTP Server Features

| Feature | TypeScript | Go | Python |
|---------|------------|-----|--------|
| dynamicPayTo | ✅ | ✅ | ✅ |
| dynamicPrice | ✅ | ✅ | ✅ |
| paywall (browser UI) | ✅ | ✅ | ✅ |
