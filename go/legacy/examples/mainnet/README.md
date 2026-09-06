# Example Mainnet Server

This example demonstrates how to accept real USDC payments on Base mainnet using Coinbase's [hosted x402 facilitator](https://docs.cdp.coinbase.com/x402/docs/welcome).

## Prerequisites

- CDP api keys (access via [Coinbase Developer Platform](https://docs.cdp.coinbase.com/))
- A valid Ethereum address for receiving payments

## Setup

1. Copy `.env-local` to `.env` and add your Ethereum address to receive payments:

```bash
cp .env-local .env
```

2. Run the server:

```bash
go run mainnet.go
```
