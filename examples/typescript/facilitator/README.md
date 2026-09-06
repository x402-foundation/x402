# x402 Facilitator Examples

This directory contains TypeScript facilitator examples. A facilitator verifies payment payloads and settles them on-chain, so a resource server can accept payments without holding keys or submitting transactions itself.

## Directory Structure

| Directory | Description |
| --- | --- |
| [`basic/`](./basic/) | Minimal facilitator exposing `/verify` and `/settle` |
| [`advanced/`](./advanced/) | All-networks support, Bazaar discovery, gas-sponsoring extensions, lifecycle hooks |
| [`batch-settlement/`](./batch-settlement/) | Submits batch-settlement contract calls |
| [`builder-code/`](./builder-code/) | Appends ERC-8021 wallet attribution at settlement |

## Getting Started

1. Pick an example directory
2. Follow the README in that directory
3. Point a [server](../servers/)'s `FACILITATOR_URL` at it, then drive the flow with a [client](../clients/)
