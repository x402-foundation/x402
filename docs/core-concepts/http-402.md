---
title: "HTTP 402"
description: "For decades, HTTP 402 Payment Required has been reserved for future use. x402 unlocks it, and [absolves the internet of its original sin](https://economyofbits.substack.com/p/marc-andreessens-original-sin)."
---

### What is HTTP 402?

[HTTP 402](https://datatracker.ietf.org/doc/html/rfc7231#section-6.5.2) is a standard, but rarely used, HTTP response status code indicating that payment is required to access a resource.

In x402, this status code is activated to:

* Inform clients (buyers or agents) that payment is required.
* Communicate the details of the payment, such as amount, currency, and destination address.
* Provide the information necessary to complete the payment programmatically.

### Why x402 Uses HTTP 402

The primary purpose of HTTP 402 is to enable frictionless, API-native payments for accessing web resources, especially for:

* Machine-to-machine (M2M) payments (e.g., AI agents).
* Pay-per-use models such as API calls or paywalled content.
* Micropayments without account creation or traditional payment rails.

Using the 402 status code keeps x402 protocol natively web-compatible and easy to integrate into any HTTP-based service.

### Payment Headers in V2

x402 V2 uses three standardized headers for payment communication:

| Header | Direction | Description |
|--------|-----------|-------------|
| `PAYMENT-REQUIRED` | Server → Client | Base64-encoded `PaymentRequired` object |
| `PAYMENT-SIGNATURE` | Client → Server | Base64-encoded `PaymentPayload` object |
| `PAYMENT-RESPONSE` | Server → Client | Base64-encoded `SettlementResponse` object |

* **`PAYMENT-REQUIRED`**: Contains the Base64-encoded payment requirements from the server. This header is returned alongside the 402 status code and includes details such as accepted payment schemes, price, network, and destination address.
* **`PAYMENT-SIGNATURE`**: Contains the Base64-encoded payment payload from the client. This header is sent by the client when retrying a request after receiving a 402 response, proving they have authorized payment.
* **`PAYMENT-RESPONSE`**: Contains the Base64-encoded settlement response from the server. This header is returned by the server after attempting settlement, whether successful or failed, providing structured feedback about the payment outcome.

All headers contain valid Base64-encoded JSON strings. This encoding ensures compatibility across different HTTP implementations and prevents issues with special characters in JSON payloads.

Whether funds move **onchain** in the same HTTP round trip depends on the **scheme**: **`exact`** and **`upto`** typically settle immediately, while **`batch-settlement`** confirms the payment authorization up front and redeems value **onchain** later according to the network binding (see **[Batch settlement](/schemes/batch-settlement)**).

### Summary

HTTP 402 is the foundation of the x402 protocol, enabling services to declare payment requirements directly within HTTP responses. It:

* Signals payment is required
* Communicates necessary payment details
* Integrates seamlessly with standard HTTP workflows
