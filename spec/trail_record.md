# TrailRecord: Post-Settlement Accountability Layer

## Overview

A `TrailRecord` provides tamper-evident proof of an agent's action after payment settlement, enabling independent third-party verification without trusting the operator's infrastructure.

## Data Model

```typescript
interface TrailRecord {
  // Cross-reference to the x402 settlement
  payment_hash: string;        // SHA-256 of the settlement signature
  action_ref: string;          // SHA-256(agent_id || action_type || scope || timestamp_ms)
  
  // Agent action details
  agent_id: string;
  action_type: string;
  scope: Record<string, string>;
  timestamp_ms: number;
  
  // Tamper-evident anchoring
  anchor_id: string;           // Sigstore Rekor entry UUID or on-chain tx hash
  anchor_type: "sigstore_rekor" | "on_chain";
  anchor_data: Record<string, unknown>;
  
  // Evidence chain
  evidence_hash: string;       // SHA-256 of signed trail payload
  created_at_ms: number;
}
```

## Key Derivation

The `action_ref` is computed as:

```
action_ref = SHA-256(
  concat(
    encoding(agent_id),
    encoding(action_type),
    encoding(scope_json),
    encoding(timestamp_ms)
  )
)
```

This ensures the trail record is deterministically derivable from the action parameters and the payment hash.

## Verification Flow

1. Given `payment_hash`, derive the expected `action_ref`
2. Fetch `TrailRecord` using `(payment_hash, action_ref)` as composite key
3. Verify `anchor_id` against external anchor (Sigstore Rekor / blockchain)
4. Verify `evidence_hash` matches the trail payload
5. Confirm the action occurred within authorized scope

## Relationship to x402

- `payment_hash` serves as the cross-surface key between x402 settlement and post-execution evidence
- Complements x402-signals which covers fulfillment SLAs (provider obligations)
- This layer covers auditor verification (third-party provability)

## Compliance Notes

Supports EU AI Act Art. 12 requirements for automatic logging of high-risk AI systems (applicable from 2 December 2027 for Annex III systems) by providing externally anchored, tamper-evident audit trails.
