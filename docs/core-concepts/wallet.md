---
title: "Wallet"
description: "This page explains the role of the **wallet** in the x402 protocol."
---

In x402, a wallet is both a payment mechanism and a form of unique identity for buyers and sellers. Wallet addresses are used to send, receive, and verify payments, while also serving as identifiers within the protocol.

### Role of the Wallet

#### For Buyers

Buyers use wallets to:

* Store USDC/crypto
* Sign payment payloads
* Authorize onchain payments programmatically

Wallets enable buyers, including AI agents, to transact without account creation or credential management.

#### For Sellers

Sellers use wallets to:

* Receive USDC/crypto payments
* Define their payment destination within server configurations

A seller's wallet address is included in the payment requirements provided to buyers.

[CDP's Wallet API ](https://docs.cdp.coinbase.com/wallet-api-v2/docs/welcome)is our recommended option for programmatic payments and secure key management.

### Summary

* Wallets enable programmatic, permissionless payments in x402.
* Buyers use wallets to pay for services.
* Sellers use wallets to receive payments.
* Wallet addresses also act as unique identifiers within the protocol.
