# x402 Typescript SDK

This folder contains Typescript packages to help developers implement the x402 protocol in their front-end and back-end applications.

| Package | Description | Latest version |
| --- | --- | --- |
| [`@x402/core`](./packages/core) | Transport-agnostic client, server, and facilitator components. | [![npm version](https://img.shields.io/npm/v/%40x402%2Fcore.svg)](https://www.npmjs.com/package/@x402/core) |
| [`@x402/extensions`](./packages/extensions) | Additional functionality built on top of x402 (Bazaar, Sign-in-with-x). | [![npm version](https://img.shields.io/npm/v/%40x402%2Fextensions.svg)](https://www.npmjs.com/package/@x402/extensions) |
| [`@x402/mcp`](./packages/mcp) | MCP server integration for x402. | [![npm version](https://img.shields.io/npm/v/%40x402%2Fmcp.svg)](https://www.npmjs.com/package/@x402/mcp) |

## HTTP integrations

| Package | Description | Latest version |
| --- | --- | --- |
| [`@x402/axios`](./packages/http/axios) | Axios interceptor for x402 payment flows. | [![npm version](https://img.shields.io/npm/v/%40x402%2Faxios.svg)](https://www.npmjs.com/package/@x402/axios) |
| [`@x402/express`](./packages/http/express) | Express middleware for x402-protected routes. | [![npm version](https://img.shields.io/npm/v/%40x402%2Fexpress.svg)](https://www.npmjs.com/package/@x402/express) |
| [`@x402/fastify`](./packages/http/fastify) | Fastify middleware for x402-protected routes. | [![npm version](https://img.shields.io/npm/v/%40x402%2Ffastify.svg)](https://www.npmjs.com/package/@x402/fastify) |
| [`@x402/fetch`](./packages/http/fetch) | Fetch wrapper for x402 payment handling. | [![npm version](https://img.shields.io/npm/v/%40x402%2Ffetch.svg)](https://www.npmjs.com/package/@x402/fetch) |
| [`@x402/hono`](./packages/http/hono) | Hono middleware for x402 integrations. | [![npm version](https://img.shields.io/npm/v/%40x402%2Fhono.svg)](https://www.npmjs.com/package/@x402/hono) |
| [`@x402/next`](./packages/http/next) | Next.js integration for x402. | [![npm version](https://img.shields.io/npm/v/%40x402%2Fnext.svg)](https://www.npmjs.com/package/@x402/next) |
| [`@x402/paywall`](./packages/http/paywall) | Browser paywall UI for x402-enabled apps. | [![npm version](https://img.shields.io/npm/v/%40x402%2Fpaywall.svg)](https://www.npmjs.com/package/@x402/paywall) |

## Chains implementations

| Package | Description | Latest version |
| --- | --- | --- |
| **EVM** - [`@x402/evm`](./packages/mechanisms/evm) | EVM implementation of x402 using the Exact payment scheme. | [![npm version](https://img.shields.io/npm/v/%40x402%2Fevm.svg)](https://www.npmjs.com/package/@x402/evm) |
| **Algorand** - [`@x402/avm`](./packages/mechanisms/avm) | AVM implementation of x402 using ASA transfers. | [![npm version](https://img.shields.io/npm/v/%40x402%2Favm.svg)](https://www.npmjs.com/package/@x402/avm) |
| **Aptos** - [`@x402/aptos`](./packages/mechanisms/aptos) | Aptos implementation of the x402 payment protocol. | [![npm version](https://img.shields.io/npm/v/%40x402%2Faptos.svg)](https://www.npmjs.com/package/@x402/aptos) |
| **Stellar** - [`@x402/stellar`](./packages/mechanisms/stellar) | Stellar implementation of x402 using Soroban token transfers. | [![npm version](https://img.shields.io/npm/v/%40x402%2Fstellar.svg)](https://www.npmjs.com/package/@x402/stellar) |
| **Solana** - [`@x402/svm`](./packages/mechanisms/svm) | SVM implementation of x402 using SPL token transfers. | [![npm version](https://img.shields.io/npm/v/%40x402%2Fsvm.svg)](https://www.npmjs.com/package/@x402/svm) |

