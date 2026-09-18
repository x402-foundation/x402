---
title: "Exact: Nano (XNO) Mainnet"
description: "Exact-payment scheme for Nano (XNO) on its native mainnet."
---

# Exact: Nano (XNO) Mainnet

This scheme extends the [Exact Payment scheme](../overview.md) for Nano (XNO) on the Nano mainnet.

## Network

| Property | Value |
|----------|-------|
| Network ID | `nano:mainnet` |
| Currency | Nano (XNO) |
| Decimals | 30 (1 XNO = 10^30 raw) |
| Finality | ~0.3 seconds (sub-second) |
| Fee | Zero (Nano's protocol is feeless) |

## Payment Flow

The standard x402 `exact` flow applies:

1. Client requests a resource with `Accept-Preference: price*XNO` from a merchant offering `nano:mainnet`
2. Merchant responds with a `402 Payment Required` containing the price in raw (atto-XNO) and `pay_to` as a `nano_...` address
3. Client constructs an x402 Offer and signs a send block to the Nano network
4. Once confirmed (1 confirmation needed due to Nano's vote-based consensus), the client presents the block hash as proof of payment
5. Merchant verifies with a Nano RPC node that the block exists and the destination matches

## Facilitator

When using a facilitator, the facilitator performs the RPC verification and signs the Receipt. Any x402-compatible facilitator that accepts `nano:mainnet` as a network ID can be used.

See [Facilitators](../../dev-tools/facilitators.md) for available production services.

## Client Implementations

- [feeless402](https://github.com/MiroShark/feeless402) — Python feeless x402 client (Nano-native)
- [openai-agents-nano](https://github.com/PANDeveloper001/openai-agents-nano-x402) — OpenAI Agents SDK adapter using feeless402
