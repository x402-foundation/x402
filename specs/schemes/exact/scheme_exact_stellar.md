# Scheme: `exact` on `Stellar`

## Versions supported

- ❌ `v1` - we don't plan to support v1 for now.
- ✅ `v2`

## Supported Networks

This spec uses [CAIP-2](https://namespaces.chainagnostic.org/stellar/caip2) identifiers:
- `stellar:pubnet` — Stellar mainnet
- `stellar:testnet` — Stellar testnet

## Summary

The x402 `exact` scheme on Stellar uses [Soroban token transfers][SEP-41] where the facilitator sponsors transaction fees while the client controls fund flow via signed authorization entries.

> [!NOTE]
> **Scope:** This spec covers [SEP-41]-compliant Soroban tokens **only**. Classic Stellar assets are not supported.

## Protocol Flow

The protocol flow for `exact` on Stellar is client-driven with facilitator-sponsored execution:

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with a `402 Payment Required` status and `PaymentRequired` header containing `extra.areFeesSponsored` (fee sponsorship indicator).
3. **Client** builds a smart contract invocation transaction calling `transfer(from, to, amount)` on the token contract [reference][SEP-41] and simulates it to identify required authorization entries.
4. **Client** signs the authorization entries (not the full transaction) with their wallet, setting expiration to `currentLedger + ledgerTimeout`, where `ledgerTimeout = ceil(maxTimeoutSeconds / estimatedLedgerSeconds)`; implementations should use the current network estimate for `estimatedLedgerSeconds` when available (fallback to `5` seconds).
5. **Client** serializes the transaction with signed auth entries and encodes it as XDR (base64).
6. **Client** sends a new request to the resource server with the `PaymentPayload` containing the base64-encoded transaction.
7. **Resource Server** forwards the `PaymentPayload` and `PaymentRequirements` to the **Facilitator Server's** `/verify` endpoint.
8. **Facilitator** decodes the transaction XDR and validates the transaction's: structure, auth entries, signature expiration, amount, payer, and recipient.
9. **Facilitator** returns a `VerifyResponse` to the **Resource Server**.
10. **Resource Server**, upon successful verification, forwards the payload to the facilitator's `/settle` endpoint.
    - NOTE: `/settle` MUST perform full verification independently and MUST NOT assume prior verification.
11. **Facilitator** rebuilds the transaction with its own account as the source, preserving all operations and auth entries.
12. **Facilitator** simulates the transaction to verify it succeeds and emits the expected transfer events.
13. **Facilitator** signs the rebuilt transaction with its own key and submits it to the Stellar network via RPC `sendTransaction`.
14. **Facilitator** polls for transaction confirmation and responds with a `SettlementResponse` to the **Resource Server**.
15. **Resource Server** grants the **Client** access to the resource in its response upon successful settlement.

## `PaymentRequirements` for `exact`

In addition to the standard x402 `PaymentRequirements` fields, the `exact` scheme on Stellar requires the following inside the `extra` field:

```json
{
  "scheme": "exact",
  "network": "stellar:testnet",
  "amount": "10000000",
  "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "payTo": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  "maxTimeoutSeconds": 60,
  "extra": {
    "areFeesSponsored": true
  }
}
```

**Field Definitions:**

- `extra.areFeesSponsored`: Whether facilitator sponsors fees. Currently always true; a non-sponsored flow will be added later.

## PaymentPayload `payload` Field

The `payload` field of the `PaymentPayload` contains:

```json
{
  "transaction": "AAAAAgAAAABriIN4poutFUmHfB6FbFJu8GgXoPPTGQWREqFpPfvO1AAAAAAAAAAAAAAAAAAAAA..."
}
```

The `transaction` field contains the base64-encoded XDR of a Stellar transaction with a single `invokeHostFunction` operation calling `transfer(from, to, amount)` and signed authorization entries with expiration derived from `maxTimeoutSeconds`.

**Full `PaymentPayload` object:**

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
    "network": "stellar:testnet",
    "amount": "10000000",
    "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "payTo": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
    "maxTimeoutSeconds": 60,
    "extra": {
      "areFeesSponsored": true
    }
  },
  "payload": {
    "transaction": "AAAAAgAAAABriIN4poutFUmHfB6FbFJu8GgXoPPTGQWREqFpPfvO1AAAAAAAAAAAAAAAAAAAAA..."
  }
}
```

## Facilitator Verification Rules (MUST)

A facilitator verifying an `exact` scheme on Stellar MUST enforce all of the following checks before sponsoring and signing the transaction:

### 1. Protocol Validation

- The `x402Version` MUST be `2`.
- Both `payload.accepted.scheme` and `requirements.scheme` MUST be `"exact"`.
- The `payload.accepted.network` MUST match `requirements.network`.

### 2. Transaction Structure

- The transaction MUST contain exactly **1 operation** of type `invokeHostFunction`.
- The function type MUST be `hostFunctionTypeInvokeContract`.
- The contract address MUST match `requirements.asset`.
- The function name MUST be `"transfer"` with exactly **3 arguments**.
  - **Argument 0 (from)**: The source address signing the auth entries.
  - **Argument 1 (to)**: MUST equal `requirements.payTo` exactly.
  - **Argument 2 (amount)**: MUST equal `requirements.amount` exactly (as i128).

### 3. Authorization Entries

- The transaction MUST contain signed authorization entries for the `from` address.
- Auth entries MUST use credential type `sorobanCredentialsAddress` only.
- The `rootInvocation` MUST NOT contain `subInvocations` that authorize additional operations beyond the transfer.
- The facilitator MUST verify that all required signers have signed their auth entries.
- The auth entry expiration ledger MUST NOT exceed `currentLedger + ceil(maxTimeoutSeconds / estimatedLedgerSeconds)`.
  - NOTE: implementations should use the current network estimate for `estimatedLedgerSeconds` when available (fallback to `5` seconds).

### 4. 🚨🚨🚨 Facilitator Safety

- The transaction source account provided by the client MUST NOT be the facilitator's address.
- The operation source account provided by the client MUST NOT be the facilitator's address.
- The facilitator MUST NOT be the `from` address in the transfer.
- The facilitator address MUST NOT appear in any authorization entries.
- The simulation MUST emit events showing only the expected balance changes (recipient increase, payer decrease), and NO OTHER BALANCE CHANGES.

These checks prevent the fee payer from being tricked into transferring their own funds or sponsoring unintended actions.

### 5. Simulation

- The facilitator MUST re-simulate the transaction against the current ledger state.
- The simulation MUST succeed without errors.
- The simulation MUST emit events confirming the exact balance change specified in `requirements.amount`.

## Settlement Logic

Settlement is performed via the facilitator rebuilding and signing the transaction:

### Phase 1: Transaction Reconstruction

1. Parse the client's signed transaction XDR.
2. Extract all operations and authorization entries.
3. Rebuild a new transaction with:
   - **Source Account**: Facilitator's Stellar address (spends [sequence number] and pays fees)
   - **Operations**: Copied from the client's transaction
   - **Auth Entries**: Copied from the client's transaction

### Phase 2: Transaction Submission

1. Sign the rebuilt transaction with the facilitator's key.
2. Submit the fully-signed transaction to the Stellar network via RPC `sendTransaction`.
3. Verify the submission status is `PENDING`, and then poll for confirmation (`SUCCESS` or `FAILED`).

### Phase 3: `SettlementResponse`

The `SettlementResponse` for the exact scheme on Stellar:

```json
{
  "success": true,
  "transaction": "a1b2c3d4e5f6...",
  "network": "stellar:testnet",
  "payer": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO"
}
```

- `transaction`: The transaction hash (64-character hex string)
- `payer`: The address that paid for the transaction (the client's address, not the facilitator)

## Appendix

Key concepts for understanding Stellar transaction composition and authorization in x402:

### Transaction Hierarchy

Per the transaction hierarchy below, the client builds and signs the contract invocation (innermost component) and sends it to the resource server. During settlement, the facilitator attaches the signed invocation to a transaction for Stellar network submission, handling fees and [sequence numbers][sequence number].

![Stellar Transaction Hierarchy](../../../static/stellar-transaction-hierarchy.png)

FeeBumpTransactions are optional but recommended for higher throughput and lower latency.

### Authorization Patterns

Clients can authorize invocations via:
1. **Auth entry signing** ([reference][auth-entry-signing]): Authorizes only the invocation.
   - Higher throughput (no [sequence number] spent by client)
   - Supports both C-accounts and G-accounts
   - Requires fee sponsorship
2. **Full transaction signing**: Signs the entire transaction, spending [sequence number].
   - Simpler approach
   - No fee sponsorship needed
   - Lower throughput (one tx/ledger per client)
   - Only supports G-accounts

The x402 protocol uses approach #1 for broader wallet support (C-accounts and G-accounts). Approach #2 may be added later for non-sponsored flows.

[SEP-41]: https://stellar.org/protocol/sep-41
[auth-entry-signing]: https://developers.stellar.org/docs/build/guides/freighter/sign-auth-entries
[sequence number]: https://developers.stellar.org/docs/learn/glossary#sequence-number
