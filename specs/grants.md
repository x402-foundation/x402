# x402 Agent Grant Specification

**Version:** 1.3.0 (EVM Multi-Chain)
**Status:** Production
**Repo:** https://github.com/shawnhvac/x402

---

## 1. Overview

An **x402 Agent Grant** is a signed authorization that delegates spending power from a principal to a sub-agent. It is encoded in the `X-402-Payment` header on every API request.

The grant struct works across **EVM chains** (EIP-712 signed). The `chainType` field routes verification. For Solana, an `escrowId` field seeds the PDA vault — enabling true escrow-until-delivery on Solana, identical to the EVM model.

---

## 2. Grant Struct

```solidity
struct x402Grant {
    uint256 grantId;        // Unique grant identifier
    address principal;      // Who issued the grant (payer)
    address agent;          // Who is authorized to spend
    uint256 issuedAt;       // Unix timestamp — grant creation
    uint256 expiration;     // Unix timestamp — grant expiry
    uint256 totalBudget;    // Max lifetime spend (USDC micro-units, 6 decimals)
    uint256 perRequestCap;  // Max spend per single API call
    bytes32[] scopes;       // Allowed action namespaces (optional)
    bytes32 salt;           // Replay protection nonce

    // MULTI-CHAIN FIELDS (added v1.1.0)
    string chainType;       // "eip155"
    string chainId;         // CAIP-2: e.g. "8453" (Base), "1" (Ethereum)
                            // (ignored on EVM — set to bytes32(0) if unused)
}
```

**Field notes:**
- `totalBudget` and `perRequestCap` are in USDC micro-units (1 USDC = 1,000,000)
- `chainType` defaults to `"eip155"` if omitted — fully backward compatible

---

## 3. EIP-712 Domain (EVM)

For `chainType === "eip155"`, grants are signed with EIP-712:

```json
{
  "name": "x402-AgentGrant",
  "version": "1",
  "chainId": 8453,
  "verifyingContract": "0x0000000000000000000000000000000000000000"
}
```

>
> **Live Program ID (Devnet):** `CNwRWLCUL7jgk3xEgvMCeUFyt73LNEPtvucwxm3YqsFb`

---

## 4. Signing (EVM / EIP-712)

```typescript
import { ethers } from "ethers";

const domain = {
  name: "x402-AgentGrant",
  version: "1",
  chainId: 8453,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

const types = {
  x402Grant: [
    { name: "grantId",       type: "uint256"   },
    { name: "principal",     type: "address"   },
    { name: "agent",         type: "address"   },
    { name: "issuedAt",      type: "uint256"   },
    { name: "expiration",    type: "uint256"   },
    { name: "totalBudget",   type: "uint256"   },
    { name: "perRequestCap", type: "uint256"   },
    { name: "scopes",        type: "bytes32[]" },
    { name: "salt",          type: "bytes32"   },
    { name: "chainType",     type: "string"    },
    { name: "chainId",       type: "string"    },
    { name: "escrowId",      type: "bytes32"   },
  ],
};

const signature = await signer.signTypedData(domain, types, grant);
```

---

## 5. Verification (EVM / EIP-712)

```python
from eth_account import Account
from eth_account.messages import encode_defunct

grant_json = json.dumps(grant, sort_keys=True, separators=(",", ":"))
msg_hash   = Web3.keccak(text=grant_json)
recovered  = Account.recover_message(encode_defunct(msg_hash), signature=signature)
assert recovered.lower() == grant["principal"].lower()
```

---

## 6. Payment Header Format

```
X-402-Payment: <base64(JSON({ grant, signature, chainType, chainId, authorization }))>
```

**EVM payload:**
```json
{
  "grant": { "...x402Grant fields..." },
  "signature": "0x...",
  "chainType": "eip155",
  "chainId": "8453",
  "authorization": {
    "from": "0x...", "to": "0x...", "value": "1000",
    "validAfter": 1700000000, "validBefore": 1700003600,
    "nonce": "0x...", "signature": "0x..."
  }
}
```


---

## 7. Revocation

Grants can be revoked on-chain when cumulative spend exceeds **30% of `totalBudget`**. Receivers SHOULD check revocation status at this threshold.

---

## 8. Security Rules

| Rule | Requirement |
|------|-------------|
| Clock skew tolerance | ±30 seconds |
| Minimum expiration window | 30 seconds |
| Replay protection | `salt` unique per request; `escrowId` unique per Solana escrow |
| Revocation threshold | Check on-chain when spend ≥ 30% of budget |
| `perRequestCap` enforcement | Reject if `paymentAmount > perRequestCap` |
| `chainType` mismatch | Reject if grant `chainType` ≠ verifier's expected chain |

---

## 9. Test Vectors

See [`test-vectors.json`](./test-vectors.json) — 5 EVM vectors.

Live conformance: `GET https://www.x402-agent-pay.com/x402/conformance`

---
