# Extension: `atomic-dvp`

## Summary

The `atomic-dvp` extension defines an **Atomic Delivery-versus-Payment (DvP) Inversion** protocol for x402 transactions. It eliminates counterparty principal risk by cryptographically coupling on-chain value clearance to the verified delivery of the requested digital resource within a unified atomic settlement boundary.

In the standard x402 workflow, payment settlement and resource fulfillment are sequentially disconnected:
- Either the client settles value first and risks non-delivery by a failing or malicious resource server ("principal risk"), or
- The resource server fulfills compute first and risks client non-payment ("credit risk").

While optimistic reputation systems and post-settlement dispute evidence mitigate human-scale transactions, autonomous AI agents transacting high-frequency or high-value workloads require deterministic mathematical guarantees: **no value moves unless the exact digital asset or compute result is delivered.**

This extension specifies a two-phase conditional clearing protocol supporting both on-chain conditional escrow/claims (e.g. hash-time locked contracts, payment channel balance claims, atomic multi-transaction groups) and facilitator-mediated atomic settlement inversion.

---

## `PaymentRequired`

A resource server advertises support for atomic DvP settlement in the `extensions` object of the **402 Payment Required** response.

### Example

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://api.example.com/v1/settle-swap",
    "description": "Atomic Delivery-versus-Payment Resource Endpoint"
  },
  "accepts": [ ... ],
  "extensions": {
    "atomic-dvp": {
      "info": {
        "supported": true,
        "required": false,
        "settlementModes": ["facilitator-inversion", "htlc", "atomic-group"],
        "maxTimeoutSeconds": 120,
        "supportedHashFunctions": ["sha256", "keccak256"]
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "supported": { "type": "boolean" },
          "required": { "type": "boolean" },
          "settlementModes": {
            "type": "array",
            "items": { "type": "string", "enum": ["facilitator-inversion", "htlc", "atomic-group"] }
          },
          "maxTimeoutSeconds": { "type": "integer", "minimum": 10, "maximum": 3600 },
          "supportedHashFunctions": {
            "type": "array",
            "items": { "type": "string" }
          }
        },
        "required": ["supported", "settlementModes"]
      }
    }
  }
}
```

---

## `PaymentPayload`

When a client initiates an atomic DvP transaction, it provides a conditional payment authorization locked against a cryptographic fulfillment commitment.

### Example

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/v1/settle-swap"
  },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:8453"
  },
  "payload": { ... },
  "extensions": {
    "atomic-dvp": {
      "info": {
        "mode": "facilitator-inversion",
        "fulfillmentDigestLock": "sha256:4a8b7f2d1e9c8b3a7f0e2d4c6b8a1e3f5d7c9b1a3e5f7d9c1b3a5f7d9c1b3a5f",
        "expiryTimestamp": 1791024120,
        "abortRecipient": "0x1234...abcd"
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "mode": { "type": "string" },
          "fulfillmentDigestLock": { "type": "string" },
          "expiryTimestamp": { "type": "integer" },
          "abortRecipient": { "type": "string" }
        },
        "required": ["mode", "fulfillmentDigestLock", "expiryTimestamp"]
      }
    }
  }
}
```

---

## Two-Phase Settlement Flow

```
Client                  Resource Server               Facilitator / Ledger
  │                            │                                │
  │─── 1. HTTP Request ───────>│                                │
  │<── 2. 402 + DvP Terms ─────│                                │
  │                            │                                │
  │─── 3. Auth with Lock ──────────────────────────────────────>│ (Phase 1: Pre-Auth Hold)
  │                            │                                │   Funds reserved conditionally
  │                            │─── 4. Deliver + Preimage ─────>│ (Phase 2: Atomic Clearance)
  │                            │                                │   Verify digest == Lock
  │                            │<── 5. Value Cleared ───────────│   Settle on-chain / burn voucher
  │<── 6. Resource Delivered ──│                                │
```

### Protocol Invariants

1. **Pre-Authorization Hold (Phase 1)**:
   - The client signs a conditional authorization (or off-chain signed voucher / claim) that reserves funds but prevents immediate withdrawal by the payee.
   - The authorization normatively commits to `fulfillmentDigestLock`.

2. **Atomic Settlement Inversion (Phase 2)**:
   - To clear funds, the resource server or facilitator MUST present the exact response body preimage whose hash matches `fulfillmentDigestLock`.
   - The facilitator or smart contract executes the settlement transaction and delivers the plaintext resource to the client within the same atomic state transition.
   - If the preimage fails to match or is corrupted, settlement is immediately refused, and no funds are deducted.

3. **Deterministic Timeout & Auto-Abort**:
   - If the fulfillment preimage is not presented before `expiryTimestamp`, the hold automatically voids.
   - The client incurs zero financial loss, completely eliminating counterparty delivery risk.

---

## Security & Architectural Considerations

- **Principal Risk Elimination**: In high-value institutional settlement and autonomous agent operations, DvP inversion ensures that payment execution is mathematically impossible without delivery of valid goods.
- **Ledger-Agnostic Abstraction**:
  - *EVM Rails*: Implemented via EIP-3009 / Permit2 conditional authorizations or escrow contracts.
  - *XRPL Rails*: Implemented via conditional escrow (`EscrowCreate` with `Condition` / `Fulfillment`) or signed payment channel claims (`PaymentChannelClaim`).
  - *Algorand Rails*: Implemented via 16-transaction Atomic Transaction Composer (ATC) groups or TEAL smart contracts.
- **Fail-Safe Idempotency**: Repeated delivery submissions with identical preimages MUST resolve to the original settled status without double-spending client balances.
