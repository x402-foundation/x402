---
title: "Facilitators"
description: "Production facilitator services for x402 payments."
---

[Facilitators](/core-concepts/facilitator) verify and settle x402 payments on behalf of resource servers. 
Anyone can run a facilitator. You can [run your own](/core-concepts/network-and-token-support#running-your-own-facilitator) or [self-facilitate](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/self-facilitation). 
The table below lists selected production options; it is not an exhaustive catalog. 

## Which option should I use?

Use this as a quick operator guide:

- **Public testnet / quickstart:** use the `x402.org` facilitator
- **Managed production mainnet:** use a production facilitator provider that supports your target network
- **Full control:** run your own facilitator or self-facilitate in-process

If you are evaluating a mainnet EVM route, decide on your production facilitator path up front. The public `x402.org` facilitator is convenient for development, but it is not intended to be the default production choice for mainnet routes.

| Name | Description |
| ---- | ----------- | 
| [Built on Stellar](https://developers.stellar.org/docs/build/apps/x402/built-on-stellar) | Free, public x402 facilitator for Stellar |
| [CDP Facilitator](https://docs.cdp.coinbase.com/x402/docs/quickstart-sellers) | Coinbase-hosted facilitator with KYT/OFAC checks on every transaction |
| [Corbits](https://corbits.dev) | Production-grade multi-network, multi-token facilitator supporting EVM and Solana |
| [Dexter](https://dexter.cash/facilitator) | Free public x402 facilitator across Solana and EVM chains with no fees and no account required |
| [HPP Facilitator](https://docs.hpp.io/x402/facilitator) | Gasless, public x402 facilitator for HPP Mainnet and Sepolia |
| [Meridian](https://mrdn.finance) | Multi-chain facilitator with developer-first features |
| [Mogami Facilitator](https://facilitator.mogami.tech) | Free, developer-focused facilitator for Base with optional self-hosted Docker deployment |
| [NEAR x402 Facilitator](https://x402.mikedotexe.com/supported) | Independent facilitator for NEAR mainnet and testnet; NEP-141 USDC settled through NEP-366 signed delegates with relayer-sponsored gas |
| [PayAI Facilitator](https://facilitator.payai.network) | Multi-network facilitator supporting all tokens. No API keys required |
| [Polygon Facilitator](https://docs.polygon.technology/payment-services/agentic-payments/x402/intro/) | Production-grade x402 facilitator for Polygon Mainnet and Amoy testnet |
| [Solvador](https://solvador.com) | Multi-network facilitator with broad mainnet coverage across EVM plus Solana and NEAR, supporting multiple schemes and extensions |
| [T54 XRPL Facilitator](https://xrpl-x402.t54.ai) | x402 facilitator for the XRP Ledger, covering mainnet and testnet with XRP and RLUSD support |

For testnet development, the [x402.org facilitator](/core-concepts/network-and-token-support#x402org-facilitator) requires no setup. It is not intended for mainnet routes; use a production facilitator, a self-hosted facilitator, or [self-facilitation](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/self-facilitation) for production networks.
