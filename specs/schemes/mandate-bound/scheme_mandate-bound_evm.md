# Scheme: `mandate-bound` `evm`

## Summary

On EVM chains, `mandate-bound` settles via a token-contract entry point that consumes an EIP-712-signed `MandateEnvelope` alongside the settlement leg. The token verifies both signatures, walks a policy chain (credential validity, registry-tracked cumulative spend, sanctions, optional travel-rule attestation), debits and credits balances, records cumulative spend against `mandateId`, and emits a versioned settlement event carrying agent attestation context.

## PaymentPayload `payload` Field

The `payload` carries the `MandateEnvelope` plus the leg amount. EIP-712 typed-data hashing uses the typehash:

```
MandateEnvelope(address principal,address agent,bytes32 kyaCredentialHash,address[] assetAllowlist,uint256 maxPerTxUsd,uint256 maxTotalUsd,uint64 notBefore,uint64 expiresAt,bytes32 mandateId,bytes32 nonce)
```

Signatures (`principalSignature`, `agentSignature`) sit alongside the struct but are excluded from the typehash.

| Field | Type | Notes |
|---|---|---|
| `principal` | `address` | Whose funds move. |
| `agent` | `address` | Authorized to call the entry point. May equal `principal`. |
| `kyaCredentialHash` | `bytes32` | `keccak256` of the principal's W3C VC. The token checks the on-chain credential-registry mirror against this hash. |
| `assetAllowlist` | `address[]` | Token addresses this mandate may spend. The single-element `[address(0)]` is the "any asset" sentinel. EIP-712 v4 array hash. |
| `maxPerTxUsd` | `uint256` | Per-tx cap in 6-decimal USD (1e6 = $1.00). |
| `maxTotalUsd` | `uint256` | Cumulative cap in 6-decimal USD, enforced against the registry counter. |
| `notBefore` | `uint64` | Unix seconds. |
| `expiresAt` | `uint64` | Unix seconds. |
| `mandateId` | `bytes32` | Unique per mandate. The cumulative-spend counter is keyed on this. |
| `nonce` | `bytes32` | One-shot replay guard. |

Example payload:

```json
{
  "scheme": "mandate-bound",
  "network": "eip155:8453",
  "payload": {
    "envelope": {
      "principal": "0xPrincipal...",
      "agent": "0xAgent...",
      "kyaCredentialHash": "0xabc...",
      "assetAllowlist": ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
      "maxPerTxUsd": "1000000",
      "maxTotalUsd": "100000000",
      "notBefore": 1735689600,
      "expiresAt": 1738281600,
      "mandateId": "0xMandateId...",
      "nonce": "0xNonce..."
    },
    "principalSignature": "0x...",
    "agentSignature": "0x...",
    "amount": "100000",
    "amountUsd6": "100000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "to": "0xRecipient...",
    "intentClass": 0,
    "memoHash": "0x..."
  }
}
```

## Verification

Before debiting any balance, the verifier MUST in order:

1. Recover the principal's signature over the EIP-712 hash and require it match `envelope.principal`. If the principal is a contract, fall through to EIP-1271 `isValidSignature`.
2. If `envelope.agent != envelope.principal`, recover the agent's signature with the same fall-through and require it match `envelope.agent`.
3. Require `block.timestamp >= envelope.notBefore && block.timestamp < envelope.expiresAt`.
4. Require the credential-registry record for `envelope.kyaCredentialHash` to be valid (not expired, not revoked).
5. Require `(envelope.mandateId, envelope.nonce)` has not been consumed. Mark it consumed.
6. Require `payload.amountUsd6 <= envelope.maxPerTxUsd`.
7. Require `envelope.assetAllowlist` contains `payload.asset` (or the `[address(0)]` sentinel).
8. Require `mandateRegistry.cumulativeSpend(envelope.mandateId) + payload.amountUsd6 <= envelope.maxTotalUsd`.
9. Call the policy hook and require it return `OK`.

A failed check reverts with `RivierRefused(reason, ctx)` where `reason` is the typed code and `ctx` is a 32-byte producer-defined tag (mandate id, credential hash, etc.).

### Refusal Codes

```solidity
enum RefusalReason {
    OK,                              // 0
    KYA_INVALID,                     // 1
    KYA_EXPIRED,                     // 2
    KYA_REVOKED,                     // 3
    MANDATE_EXPIRED,                 // 4
    MANDATE_PER_TX_CAP,              // 5
    MANDATE_CUMULATIVE_CAP,          // 6
    MANDATE_ASSET_NOT_ALLOWED,       // 7
    MANDATE_PRINCIPAL_MISMATCH,      // 8
    MANDATE_REVOKED,                 // 9
    MANDATE_SIGNATURE_INVALID,       // 10
    MANDATE_AGENT_SIGNATURE_INVALID, // 11
    JURISDICTION_GATE,               // 12
    TRAVEL_RULE_BLOCK,               // 13
    SANCTIONS_HIT,                   // 14
    POR_STALE,                       // 15
    POR_INSUFFICIENT,                // 16
    PERMISSIONED_RWA,                // 17
    PAUSED,                          // 18
    NAMESPACE_INSUFFICIENT,          // 19
    STREAM_INVALID,                  // 20
    STREAM_PAUSED,                   // 21
    POLICY_HOOK_REVERTED,            // 22
    UNKNOWN                          // 23
}

error RivierRefused(RefusalReason reason, bytes32 ctx);
```

`OK` (0) is the success sentinel. Producers MUST NOT return `UNKNOWN` (23) under normal flow; it is reserved as a defensive default.

### Dry Run

The settler MUST expose a state-read-only simulator returning the same `RefusalReason` a real settlement would revert with:

```solidity
function dryRun(DryRunInput calldata input) external view returns (DryRunResult memory);
```

Byte-equivalence invariant: for any `(caller, envelope, leg)` tuple, `dryRun({legs:[leg], envelope, caller}).reason` MUST equal the `RefusalReason` a real settlement call would revert with (or `OK` if it would succeed). Multi-leg `dryRun` simulates batched settlement and projects cumulative-cap checks against the sum.

## Settlement

After verification passes the settler MUST:

1. Debit `payload.amount` from the payer.
2. Credit `payload.amount` to `payload.to`.
3. Record cumulative spend: `mandateRegistry.recordMandateUse(envelope.mandateId, payload.amountUsd6)`.
4. Emit a versioned settlement event carrying `(transferRef, from, to, amount, intentClass, memoHash, mandateId, kyaCredentialHash, extensionVersion, extensionData)`. The `extensionData` blob is opaque per `extensionVersion`; v1 carries agent attestation (model id, version, confidence, reasoning hash, prompt hash, MCP server DID, TEE attestation hash, policy compliance proof).
5. Emit the standard ERC-20 `Transfer(from, to, amount)` for off-chain indexer compatibility.

`transferRef` is `keccak256(abi.encode(envelope.mandateId, envelope.nonce, blockNumber, legIndex))` — deterministic and unique per leg.

## Appendix

Reference implementation under MIT at https://github.com/rivier-ai/rivr. The token contract is at `contracts/src/rivier-token/RivierTokenCCT.sol` (`transferWithMandate` entry point); types at `contracts/src/rivier-token/types/`; tests at `contracts/test/rivier-token/`. The 113-test forge suite covers the byte-equivalence invariant, namespace sum-preservation under fuzzing, replay protection, and reentrancy safety of cumulative-spend tracking.

The implementation is independent of the spec. Any compliant implementation may use a different policy chain, registry shape, or storage layout. The scheme contract is the envelope, the verification ordering, and the typed refusal codes.
