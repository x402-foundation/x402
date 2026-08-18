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

### Choosing a Facilitator Path

There is no single facilitator deployment model for every x402 integration. In practice, most teams should choose one of three paths:

| Goal | Recommended path |
| ---- | ---------------- |
| Fastest testnet or local quickstart | Use the public `x402.org` facilitator |
| Managed production deployment | Use a production facilitator provider that supports your target network |
| Full operational control | Run your own facilitator or [self-facilitate](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/self-facilitation) inside your resource server |

**Important:** the public `x402.org` facilitator is intended for development and testnet workflows. Do not assume it is the default path for production mainnet routes. For mainnet deployments, use a production facilitator that supports your network, run your own facilitator, or self-facilitate.

### Why Use a Facilitator?

Using a facilitator provides:

* **Reduced operational complexity:** Servers do not need to interact directly with blockchain nodes.
* **Protocol consistency:** Standardized verification and settlement flows across services.
* **Faster integration:** Services can start accepting payments with minimal blockchain-specific development.

While it is possible to implement verification and settlement locally, using a facilitator accelerates adoption and ensures correct protocol behavior.

### Live Facilitators

Multiple facilitators are live in production, supporting various networks including Base, Solana, Polygon, Avalanche, and more. See [Facilitators](/dev-tools/facilitators) for selected production options.

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

### Settlement Pending (EVM)

When an EVM settlement transaction is broadcast but its confirmation cannot be established — for example, due to an RPC error or a timeout while waiting for the receipt — the facilitator returns `settlement_pending` instead of a terminal failure. This is a **non-terminal** error: the transaction may still confirm on chain. The `SettlementResponse` carries the broadcast transaction hash in `transaction` and the network in `network`, so callers can reconcile on chain before deciding whether to retry.

This applies to the `exact`, `upto`, and `batch-settlement` EVM schemes (v2 only).

**Facilitators deployed behind a platform request deadline** (serverless functions, gateway timeouts) should bound the receipt wait below that deadline. If the process is killed mid-wait, the caller receives a 5xx with no transaction hash instead of `settlement_pending` with a hash to reconcile against.

In TypeScript, pass `confirmationTimeoutMs` to `toFacilitatorEvmSigner` to set this bound:

```typescript
import { toFacilitatorEvmSigner } from "@x402/evm";

const evmSigner = toFacilitatorEvmSigner(walletClient, {
  confirmationTimeoutMs: 25_000, // set a few seconds below your platform deadline
});
```

The default is `180_000` ms (3 minutes), matching viem's own default. In Python, pass `confirmation_timeout_seconds` to `FacilitatorWeb3Signer` (default `120`).

### Duplicate Settlement (Solana)

On Solana, a race condition can occur when the same payment transaction is submitted to a facilitator's `/settle` endpoint multiple times before the first submission is confirmed onchain. Because Solana's RPC returns "success" for duplicate submissions (the network deduplicates at the consensus level), the facilitator may return a successful settlement response for each call. A malicious client could exploit this to access multiple resources while only paying once.

To mitigate this, the x402 SVM mechanism packages include a built-in `SettlementCache` — a short-lived, in-memory cache that detects and rejects duplicate settlement attempts for the same transaction payload. The cache requires no external storage and entries are automatically evicted after 120 seconds (approximately twice the Solana blockhash lifetime).

This protection is enabled by default when using the standard SVM facilitator registration helpers in TypeScript and Python. In Go, a shared `SettlementCache` instance should be passed to both V1 and V2 SVM facilitator schemes during registration.

**If you are a merchant settling payments directly (without a facilitator), you must implement equivalent duplicate detection yourself.** See the [Exact SVM Scheme Specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md) for the full specification.

### Summary

The facilitator acts as an independent verification and settlement layer within the x402 protocol. It helps servers confirm payments and submit transactions onchain without requiring direct blockchain infrastructure.

Next, explore:

* [Client / Server](/core-concepts/client-server) — understand the roles and responsibilities of clients and servers
* [HTTP 402](/core-concepts/http-402) — understand how payment requirements are communicated to clients
