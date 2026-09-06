---
title: "Client / Server"
description: "This page explains the roles and responsibilities of the **client** and **server** in the x402 protocol."
---

Understanding these roles is essential to designing, building, or integrating services that use x402 for programmatic payments.

**Note**\
Client refers to the technical component making an HTTP request. In practice, this is often the _buyer_ of the resource.

Server refers to the technical component responding to the request. In practice, this is typically the _seller_ of the resource

### Client Role

The client is the entity that initiates a request to access a paid resource.

Clients can include:

* Human-operated applications
* Autonomous agents
* Programmatic services acting on behalf of users or systems

#### Responsibilities

* **Initiate requests:** Send an HTTP request to the resource server.
* **Handle payment requirements:** Read the `402 Payment Required` response and extract payment details.
* **Prepare payment payload:** Use the provided payment requirements to construct a valid payment payload.
* **Resubmit request with payment:** Retry the request with the `PAYMENT-SIGNATURE` header containing the signed payment payload.

Clients do not need to manage accounts, credentials, or session tokens beyond their crypto wallet. All interactions are stateless and occur over standard HTTP requests.

### Server Role

The server is the resource provider enforcing payment for access to its services.

Servers can include:

* API services
* Content providers
* Any HTTP-accessible resource requiring monetization

#### Responsibilities

* **Define payment requirements:** Respond to unauthenticated requests with an HTTP `402 Payment Required`, including all necessary payment details in the response body.
* **Verify payment payloads:** Validate incoming payment payloads, either locally or by using a facilitator service.
* **Settle transactions:** Upon successful verification, submit the payment for settlement.
* **Provide the resource:** Once payment is confirmed, return the requested resource to the client.

Servers do not need to manage client identities or maintain session state. Verification and settlement are handled per request.

#### Duplicate Settlement on Solana

If your server settles payments directly on Solana (without delegating to a facilitator), be aware of a race condition: the same signed payment transaction can be submitted multiple times before the first submission is confirmed onchain. Solana's RPC will return "success" for each submission, since the network deduplicates at the consensus level. A malicious client can exploit this to obtain access to multiple resources while only paying once.

To mitigate this, servers that settle Solana payments themselves **must** maintain a short-lived, in-memory cache of transaction payloads currently being settled:

1. After verification succeeds, derive a cache key from the transaction payload (e.g., the base64-encoded transaction string).
2. If the key is already present in the cache, reject the settlement with a `"duplicate_settlement"` error.
3. If the key is not present, insert it into the cache and proceed with settlement.
4. Evict entries older than 120 seconds (approximately twice the Solana blockhash lifetime).

If you are using a facilitator, the x402 SVM libraries already include built-in duplicate settlement protection via a `SettlementCache`. See the [Exact SVM Scheme Specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md) for full details.

### Communication Flow

The typical flow between a client and a server in the x402 protocol is as follows:

1. **Client initiates request** to the server for a paid resource.
2. **Server responds with `402 Payment Required`**, including the payment requirements in the response body.
3. **Client prepares and submits a payment payload** based on the provided requirements, including it in the `PAYMENT-SIGNATURE` header (Base64-encoded).
4. **Server verifies the payment payload**, either locally or through a facilitator service.
5. **Server settles the payment** and confirms transaction completion.
6. **Server responds with the requested resource** (on success) or an error response (on failure), including a `PAYMENT-RESPONSE` header (Base64-encoded) with settlement details in both cases.

### Timeouts and Safe Retries

An HTTP timeout or lost response does not prove that a payment failed or cancel work already accepted by the server. Choose a retry strategy based on what has been submitted:

* **Before submitting payment:** If neither this nor an earlier attempt has submitted a payment authorization or broadcast a transaction, retry only when the HTTP operation itself is safe to repeat. Preparing a signed payload locally is not the same as sending it in `PAYMENT-SIGNATURE`; check whether your payment mechanism broadcasts during preparation.
* **After sending `PAYMENT-SIGNATURE`:** Treat the payment outcome as unknown. Do not automatically create or authorize a second payment, because the server may have received and settled the first one.
* **When settlement details are available:** Decode `PAYMENT-RESPONSE` and use its `transaction` and `network` to [reconcile the transaction onchain](/core-concepts/facilitator#settlement-pending-and-auto-recovery). `success: false` with `errorReason: "settlement_pending"` is non-terminal, not permission to pay again.
* **When no transaction hash is available:** Use the resource server's or facilitator provider's lookup or support process, if available. A missing response or lookup result is not proof that settlement did not occur.

Reconciliation closes the unknown state only when it produces terminal evidence. If the expected payment is confirmed, recover the original operation's result through the server rather than paying again. If settlement is conclusively unsuccessful, a new payment may be considered after checking whether the application operation is safe to repeat. A receipt-wait timeout, retry limit, cache expiry, or payment authorization expiry is not evidence that a previously broadcast transaction failed.

The [x402 HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md) does not define a universal settlement-status endpoint or application decision deadline. Facilitators and payment mechanisms handle bounded receipt waiting and transaction reconciliation; applications choose reconciliation backoff, attempt limits, and business deadlines. If the outcome is still unknown at that deadline, stop automatic payment attempts and move the operation to manual review or an unresolved state.

For retries of the same logical request, preserve its [`payment-identifier`](/extensions/payment-identifier) when the server supports the extension. Deduplication depends on the server's request binding, storage, and cache lifetime; the identifier alone does not make a retry safe. Replaying the same signed payload also requires the mechanism's replay protections and the application's idempotency guarantees.

Once another payment attempt is safe, construct it from the latest `PaymentRequired` response, including updated extension challenges. Re-run payment policy checks or request user approval when terms such as `scheme`, `network`, `amount`, `asset`, or `payTo` change. A corrective `402` alone does not resolve an earlier unknown settlement outcome.

To resume reconciliation after a restart, applications should persist the logical request/payment identifier, request and payment-terms fingerprint, observed settlement state, known transaction hash and network, last reconciliation time, evidence references, and application deadline/policy version and action. Keep settlement state separate from application action: a deadline can trigger manual review while settlement remains unknown. This is application-owned bookkeeping, not a new protocol record.

### Summary

In the x402 protocol:

* The **client** requests resources and supplies the signed payment payload.
* The **server** enforces payment requirements, verifies transactions, and provides the resource upon successful payment.

This interaction is stateless, HTTP-native, and compatible with both human applications and automated agents.

Next, explore:

* [Facilitator](/core-concepts/facilitator) — how servers verify and settle payments
* [HTTP 402](/core-concepts/http-402) — how servers communicate payment requirements to clients
