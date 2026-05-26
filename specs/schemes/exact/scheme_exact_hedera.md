# Exact Payment Scheme for Hedera HTS FT and native HBAR token (`exact`)

This document specifies the `exact` payment scheme for the x402 protocol on Hedera.

This scheme facilitates payments of a specific amount of a Hedera HTS fungible token (FT) or the native HBAR token on the Hedera network.

## Scheme Name

`exact`

## Protocol Flow

The protocol flow for `exact` on Hedera is client-driven.

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with a payment required signal containing `PaymentRequired`. Critically, the `extra` field in the requirements contains a **feePayer**, which is the Hedera account ID (`0.0.xxxx`) of the identity that will pay the network fees for the transaction. This is typically the facilitator.
3. **Client** creates a transaction of type `TransferTransaction` that transfers the specified `asset` from the client to the resource server’s `payTo` account for the specified `amount`, and sets the `transactionId.accountId` to `PaymentRequirements.extra.feePayer`.
4. **Client** signs the transaction with their wallet. This results in a **partially signed** transaction (the fee payer’s signature is still missing).
5. **Client** serializes the partially signed transaction and encodes it as a Base64 string.
6. **Client** sends a new request to the resource server with the `PaymentPayload` containing the Base64‑encoded partially signed transaction.
7. **Resource Server** receives the request and forwards the `PaymentPayload` and `PaymentRequirements` to a **Facilitator Server** `/verify` endpoint.
8. **Facilitator** decodes and deserializes the proposed transaction.
9. **Facilitator** inspects the transaction to ensure it is valid and only contains the expected payment transfer.
10. **Facilitator** returns a `VerifyResponse` to the **Resource Server**.
11. **Resource Server**, upon successful verification, forwards the payload to the facilitator’s `/settle` endpoint.
12. **Facilitator Server** adds its signature as the `feePayer` and submits the now fully signed transaction to the Hedera network.
13. Upon successful on‑chain settlement, the **Facilitator Server** responds with a `SettlementResponse` to the **Resource Server**.
14. **Resource Server** grants the **Client** access to the resource in its response.

## `PaymentRequirements` for `exact`

In addition to the standard x402 `PaymentRequirements` fields, the `exact` scheme on Hedera requires the following inside the `extra` field:

```json
{
  "scheme": "exact",
  "network": "hedera:mainnet",
  "amount": "1000",
  "asset": "0.0.0",
  "payTo": "0.0.1234",
  "maxTimeoutSeconds": 180,
  "extra": {
    "feePayer": "0.0.1235"
  }
}
```

- `asset`: The Hedera entity ID of the HTS fungible token. For HBAR, use `"0.0.0"`.
- `amount`: The amount to be transferred. For HBAR (`asset` `"0.0.0"`), the amount MUST be expressed in **tinybars** (1 HBAR = 10⁸ tinybars). For HTS fungible tokens, the amount is in the token’s smallest unit (as defined by the token’s decimals).
- `payTo`: The Hedera account ID of the resource server receiving the funds.
- `extra.feePayer`: The Hedera account ID that will pay the transaction fees. This is typically the facilitator’s account; this account must also sign the transaction as the fee payer.

## PaymentPayload `payload` Field

The `payload` field of the `PaymentPayload` contains:

```json
{
  "transaction": "AAAAAAAAAAAAA...AAAAAAAAAAAAA="
}
```

The `transaction` field contains the Base64‑encoded, serialized, **partially signed** versioned Hedera transaction (e.g. `TransferTransaction`), signed by the client but **not yet** signed by the fee payer.

Full `PaymentPayload` object:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://example.com/weather",
    "description": "Access to protected content",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "hedera:mainnet",
    "amount": "1000",
    "asset": "0.0.0",
    "payTo": "0.0.1234",
    "maxTimeoutSeconds": 180,
    "extra": {
      "feePayer": "0.0.1235"
    }
  },
  "payload": {
    "transaction": "AAAAAAAAAAAAA...AAAAAAAAAAAAA="
  }
}
```

## `SettlementResponse`

The `SettlementResponse` for the `exact` scheme on Hedera:

```json
{
  "success": true,
  "transactionId": "0.0.1235@1700000000.000000000",
  "network": "hedera:mainnet",
  "payer": "0.0.1235"
}
```

- `transactionId`: The Hedera transaction ID of the submitted transaction.
- `payer`: The Hedera account ID of the fee payer that sponsored the transaction.

## Facilitator Verification Rules (MUST)

A facilitator verifying an `exact`‑scheme Hedera payment MUST enforce all of the following checks before sponsoring and signing the transaction.

### 1. Transaction layout

- The decompiled transaction MUST be a `TransferTransaction` **directly**. It MUST NOT be wrapped in a `ScheduleCreateTransaction` or any other transaction type.
- The transaction MUST:
  1. Have `transactionId.accountId == extra.feePayer` from the `PaymentRequirements`. This ensures the facilitator’s account is the fee payer at the network level.
  2. Contain **only** transfer operations (HBAR or HTS FT transfers) necessary to implement the requested payment. No additional transfers or non‑transfer operations are allowed.
  3. Have the net sum of all HBAR transfers equal zero.
  4. Have the net sum of all transfers for the specified `asset` equal zero.

### 2. Fee payer safety

- The configured `feePayer` (`PaymentRequirements.extra.feePayer`) MUST:
  - NOT appear as a **negative** entry in any HBAR transfer list.
  - NOT appear as a **negative** entry in the token transfer list for the specified `asset`.
- The `feePayer` MAY appear as a positive entry (i.e., receive value), for example when collecting fees or custom fee distributions, but it MUST NOT be the net sender of funds in the payment transaction; it only sponsors network fees via `transactionId.accountId`.

### 3. Network and asset correctness

- The `network` field in `PaymentRequirements` MUST be a valid Hedera CAIP-2 network identifier corresponding to the Hedera network on which the transaction will be submitted (e.g. `hedera:mainnet`, `hedera:testnet`).
- The `asset` in `PaymentRequirements` MUST be:
  - Either `"0.0.0"` to indicate HBAR, **or**
  - A valid fungible token ID for an HTS fungible token.
- All token transfers in the transaction MUST be for the single `asset` specified in `PaymentRequirements.asset`. No other token IDs may appear.

### 4. Transfer intent and destination

- The transaction MUST transfer value from the client’s account(s) to the `payTo` account specified in `PaymentRequirements.payTo`.
- For HBAR payments:
  - The net HBAR amount credited to `payTo` MUST equal `PaymentRequirements.amount` (after normalizing units if necessary).
- For HTS FT payments:
  - The net token amount credited to `payTo` for `asset` MUST equal `PaymentRequirements.amount`.

### 5. Amount exactness

- The `amount` transferred to `payTo` for the given `asset` MUST equal `PaymentRequirements.amount` **exactly**.
- No additional positive net transfers to any other party (besides `payTo`) may exist for the specified `asset`.
- The facilitator MUST reject any transaction where:
  - The net amount to `payTo` is not exactly equal to `PaymentRequirements.amount`, or
  - The client is sending more than `PaymentRequirements.amount` in total for the specified `asset`.

### 6. General validity and replay protection

- The transaction MUST:
  - Not have been previously submitted/observed (implementations SHOULD perform idempotency / replay checks where possible).
- The facilitator SHOULD simulate or pre‑check the transaction using Hedera APIs where available to ensure:
  - The client has sufficient balance of the `asset` to cover the transfer.
  - The transaction is expected to succeed on chain (no obvious `INSUFFICIENT_BALANCE`, invalid token association, or similar failures).

These checks are security‑critical to ensure the fee payer cannot be tricked into transferring their own funds or sponsoring unintended actions. Implementations MAY introduce stricter limits (e.g., additional policy around max fee, max amount, or allowed token lists) but MUST NOT relax the above constraints.

### Account aliases and auto-account creation

When the resource server’s `payTo` is specified as an **account alias** (e.g. an EVM address or public key alias) rather than an existing account ID, a transfer of HBAR to that alias can trigger **auto-account creation** on Hedera. In that case, the facilitator effectively funds the creation of the new account (the first transfer to the alias creates the account and credits it). A malicious or poorly configured resource server could use this to have facilitators pay for account creation on its behalf.

This specification does **not** require facilitators to forbid such transfers. Facilitators MAY handle this in whatever way they see fit: for example, they MAY require that `payTo` resolve to an existing account and reject transactions that would trigger auto-account creation, or they MAY allow it and accept the cost. Implementations SHOULD document their policy and, if they allow transfers to aliases, consider the associated cost and abuse potential.


