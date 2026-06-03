---
title: "Payment Schemes"
description: "Choose between exact, upto, and batch-settlement payment schemes in x402."
---

Payment schemes define the payment semantics for a resource: `exact` is for fixed-price requests where the buyer authorizes the advertised amount, `upto` is for single-request usage-based billing where the buyer authorizes a maximum and the seller charges actual usage, and `batch-settlement` is for high-volume or repeated micropayments where per-request authorizations are accumulated against a reusable channel. Network implementations define how those semantics are encoded for EVM, SVM, TVM (TON), AVM, Stellar, Aptos, Hedera, and other networks; see [SDK Features](/sdk-features) for current SDK support.

### Schemes in a 402 Response

A protected resource advertises one or more payment requirements in its HTTP 402 Payment Required response. The `scheme` names the payment semantics and `network` names the network implementation.

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://api.example.com/weather",
    "description": "Weather data",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "1000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0xYourEvmAddress",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    },
    {
      "scheme": "exact",
      "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "amount": "1000",
      "asset": "So11111111111111111111111111111111111111112",
      "payTo": "YourSolanaAddress",
      "maxTimeoutSeconds": 60,
      "extra": {
        "feePayer": "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd"
      }
    }
  ]
}
```

Servers register scheme implementations for the networks they advertise. Clients register scheme implementations for the networks they can pay on. When the client receives a 402 response, the SDK selects an `accepts` entry whose `scheme` and `network` match a registered implementation.

### Specs

For scheme-level payload semantics, see the network-agnostic specifications. Each scheme page links to its currently implemented network specs.

* [`exact` spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact.md)
* [`upto` spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/upto/scheme_upto.md)
* [`batch-settlement` spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md)
