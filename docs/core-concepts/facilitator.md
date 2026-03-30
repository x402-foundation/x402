---
title: "Facilitator"
description: "This page explains the role of the **facilitator** in the x402 protocol."
---

The facilitator is an optional but recommended service that simplifies the process of verifying and settling payments between clients (buyers) and servers (sellers).

### What is a Facilitator?

The facilitator is a service that:

* Verifies payment payloads submitted by clients.
* Settles payments on the blockchain on behalf of servers.

By using a facilitator, servers do not need to maintain direct blockchain connectivity or implement payment verification logic themselves. This reduces operational complexity and ensures accurate, real-time validation of transactions.

### Facilitator Responsibilities

* **Verify payments:** Confirm that the client's payment payload meets the server's declared payment requirements.
* **Settle payments:** Submit validated payments to the blockchain and monitor for confirmation.
* **Provide responses:** Return verification and settlement results to the server, allowing the server to decide whether to fulfill the client's request.

The facilitator does not hold funds or act as a custodian - it performs verification and execution of onchain transactions based on signed payloads provided by clients.

### Why Use a Facilitator?

Using a facilitator provides:

* **Reduced operational complexity:** Servers do not need to interact directly with blockchain nodes.
* **Protocol consistency:** Standardized verification and settlement flows across services.
* **Faster integration:** Services can start accepting payments with minimal blockchain-specific development.

While it is possible to implement verification and settlement locally, using a facilitator accelerates adoption and ensures correct protocol behavior.

### Live Facilitators

Multiple facilitators are live in production, supporting various networks including Base, Solana, Polygon, Avalanche, and more. For a complete and up-to-date list, see the [x402 Ecosystem](https://www.x402.org/ecosystem?filter=facilitators).

### Interaction Flow

1. `Client` makes an HTTP request to a `resource server`
2. `Resource server` responds with a `402 Payment Required` status and a `PAYMENT-REQUIRED` header containing the Base64-encoded payment requirements.
3. `Client` selects one of the `paymentDetails` returned by the `accepts` field of the server response and creates a `Payment Payload` based on the `scheme` of the `paymentDetails` they have selected.
4. `Client` sends the HTTP request with the `PAYMENT-SIGNATURE` header containing the `Payment Payload` (Base64-encoded) to the `resource server`
5. `Resource server` verifies the `Payment Payload` is valid either via local verification or by POSTing the `Payment Payload` and `Payment Details` to the `/verify` endpoint of the `facilitator server`.
6. `Facilitator server` performs verification of the object based on the `scheme` and `networkId` of the `Payment Payload` and returns a `Verification Response`
7. If the `Verification Response` is valid, the resource server performs the work to fulfill the request. If the `Verification Response` is invalid, the resource server returns a `402 Payment Required` status with the `PAYMENT-REQUIRED` header.
8. `Resource server` either settles the payment by interacting with a blockchain directly, or by POSTing the `Payment Payload` and `Payment Details` to the `/settle` endpoint of the `facilitator server`.
9. `Facilitator server` submits the payment to the blockchain based on the `scheme` and `networkId` of the `Payment Payload`.
10. `Facilitator server` waits for the payment to be confirmed on the blockchain.
11. `Facilitator server` returns a `Payment Execution Response` to the resource server.
12. `Resource server` returns a response to the `Client` with a `PAYMENT-RESPONSE` header containing the `Settlement Response` as Base64-encoded JSON. On success, this is a `200 OK` with the requested resource. On failure, this is a `402 Payment Required` with error details.

### Duplicate Settlement (Solana)

On Solana, a race condition can occur when the same payment transaction is submitted to a facilitator's `/settle` endpoint multiple times before the first submission is confirmed on-chain. Because Solana's RPC returns "success" for duplicate submissions (the network deduplicates at the consensus level), the facilitator may return a successful settlement response for each call. A malicious client could exploit this to access multiple resources while only paying once.

To mitigate this, the x402 SVM mechanism packages include a built-in `SettlementCache` — a short-lived, in-memory cache that detects and rejects duplicate settlement attempts for the same transaction payload. The cache requires no external storage and entries are automatically evicted after 120 seconds (approximately twice the Solana blockhash lifetime).

This protection is enabled by default when using the standard SVM facilitator registration helpers in TypeScript and Python. In Go, a shared `SettlementCache` instance should be passed to both V1 and V2 SVM facilitator schemes during registration.

**If you are a merchant settling payments directly (without a facilitator), you must implement equivalent duplicate detection yourself.** See the [Exact SVM Scheme Specification](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md) for the full specification.

### Summary

The facilitator acts as an independent verification and settlement layer within the x402 protocol. It helps servers confirm payments and submit transactions onchain without requiring direct blockchain infrastructure.

Next, explore:

* [Client / Server](/docs/core-concepts/client-server.md) — understand the roles and responsibilities of clients and servers
* [HTTP 402](/docs/core-concepts/http-402.md) — understand how payment requirements are communicated to clients
