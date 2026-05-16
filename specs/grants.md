# x402 Agent Grant Specification

**Version:** 1.1.0 (Solana Multi-Chain Support)
**Status:** Production
**Repo:** https://github.com/shawnhvac/x402

---

## 1. Overview

An **x402 Agent Grant** is a signed authorization that lets a principal (human or orchestrating agent) delegate spending power to a sub-agent. The grant is encoded in the `X-402-Payment` header on every API request.

The same grant struct works across **EVM chains** (signed with EIP-712) and **Solana** (signed with ed25519). The `chainType` field routes verification.

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

    // MULTI-CHAIN FIELDS
    string chainType;       // "eip155" (default) or "solana"
    string chainId;         // e.g. "8453" (Base) or "solana-mainnet"
}
```

**Field notes:**
- `totalBudget` and `perRequestCap` are in USDC micro-units (1 USDC = 1,000,000)
- `chainType` defaults to `"eip155"` if omitted — fully backward compatible
- `chainId` uses the CAIP-2 chain identifier for EVM, or `"solana-mainnet"` / `"solana-devnet"` for Solana

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

> **Note:** `chainId` matches the target chain. For Solana grants, the EIP-712 domain is not used — see Section 10.

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
  ],
};

const signature = await signer.signTypedData(domain, types, grant);
```

---

## 5. Verification (EVM / EIP-712)

```python
from eth_account import Account
from eth_account.messages import encode_defunct
import json

grant_json = json.dumps(grant, sort_keys=True, separators=(",", ":"))
msg_hash   = Web3.keccak(text=grant_json)
recovered  = Account.recover_message(encode_defunct(msg_hash), signature=signature)
assert recovered.lower() == grant["principal"].lower(), "Signature mismatch"
```

---

## 6. Payment Header Format

```
X-402-Payment: <base64(JSON({ grant, signature, chainType, chainId, authorization }))>
```

**JSON payload structure:**

```json
{
  "grant": { "...x402Grant fields..." },
  "signature": "0x...",
  "chainType": "eip155",
  "chainId": "8453",
  "authorization": {
    "from": "0x...",
    "to": "0x...",
    "value": "1000",
    "validAfter": 1700000000,
    "validBefore": 1700003600,
    "nonce": "0x...",
    "signature": "0x..."
  }
}
```

For Solana, `authorization` contains the SPL transfer authorization instead of EIP-3009 fields.

---

## 7. Revocation

Grants can be revoked on-chain when the **cumulative spend** exceeds **30% of the total lifetime budget**. This threshold triggers an on-chain revocation check via the `GrantRegistry` contract.

Receivers SHOULD check revocation status for grants where `currentSpend / totalBudget >= 0.30`.

---

## 8. Security Rules

| Rule | Requirement |
|------|-------------|
| Clock skew tolerance | ±30 seconds |
| Minimum `expiration` window | 30 seconds |
| Replay protection | `salt` must be unique per request |
| Revocation threshold | Check on-chain when spend ≥ 30% of budget |
| `perRequestCap` enforcement | Reject if `paymentAmount > perRequestCap` |
| `chainType` mismatch | Reject if grant `chainType` ≠ verifier's expected chain |

---

## 9. Test Vectors

See [`test-vectors.json`](./test-vectors.json) and the [conformance suite](./conformance.md) for 6 verified test vectors including a Solana grant vector.

Live conformance endpoint: `GET https://www.x402-agent-pay.com/x402/conformance`

---

## 10. Solana Support (`chainType = "solana"`)

When `chainType === "solana"`, use the same grant struct but sign with Solana's native **ed25519** signature (no EIP-712).

### Signing (Solana / ed25519)

```typescript
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

export function signSolanaGrant(grant: any, signer: Keypair): Uint8Array {
  const message = new TextEncoder().encode(
    JSON.stringify(grant, Object.keys(grant).sort())
  );
  return nacl.sign.detached(message, signer.secretKey);
}

export function verifySolanaGrant(
  grant: any,
  signature: Uint8Array,
  publicKey: Uint8Array
): boolean {
  const message = new TextEncoder().encode(
    JSON.stringify(grant, Object.keys(grant).sort())
  );
  return nacl.sign.detached.verify(message, signature, publicKey);
}
```

### Payment Header (Solana)

```json
{
  "grant": {
    "grantId": "42",
    "principal": "6aCEuwH3PYx99cEmRz45otfxk39uF7ewGhqmvxfXisSG",
    "agent": "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy",
    "issuedAt": 1700000000,
    "expiration": 1700003600,
    "totalBudget": 1000000,
    "perRequestCap": 5000,
    "chainType": "solana",
    "chainId": "solana-mainnet"
  },
  "signature": "<base64(ed25519 signature)>",
  "chainType": "solana",
  "chainId": "solana-mainnet",
  "authorization": {
    "from": "6aCEuwH3PYx99cEmRz45otfxk39uF7ewGhqmvxfXisSG",
    "to": "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy",
    "value": "1000",
    "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "signature": "<base64(ed25519 transfer auth)>"
  }
}
```

### Verification (Facilitator — Python)

```python
import nacl.signing, base58, json, base64

def verify_solana_grant(grant: dict, signature_b64: str, public_key_b58: str) -> bool:
    message  = json.dumps(grant, sort_keys=True, separators=(",", ":")).encode()
    sig      = base64.b64decode(signature_b64)
    pk_bytes = base58.b58decode(public_key_b58)
    try:
        nacl.signing.VerifyKey(pk_bytes).verify(message, sig)
        return True
    except Exception:
        return False
```

### USDC Mint (Solana Mainnet)

```
EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

### Notes

- Existing EVM grants remain **fully unchanged** — `chainType` defaults to `"eip155"` if omitted
- Settlement on Solana uses native SPL token transfer (not EIP-3009)
- The AgentPay facilitator routes automatically based on `chainType`
- Solana grants settle in **< 1 second** vs 2–6s on Base

---

## 11. Supported Chains (AgentPay Facilitator)

| Chain | CAIP-2 | Signing | Settlement | USDC |
|-------|--------|---------|-----------|------|
| Base | eip155:8453 | EIP-712 | EIP-3009 | 0x833589... |
| Ethereum | eip155:1 | EIP-712 | EIP-3009 | 0xA0b869... |
| Optimism | eip155:10 | EIP-712 | EIP-3009 | 0x0b2C63... |
| Arbitrum | eip155:42161 | EIP-712 | EIP-3009 | 0xaf88d0... |
| Polygon | eip155:137 | EIP-712 | EIP-3009 | 0x3c499c... |
| Solana | solana:mainnet | ed25519 | SPL transfer | EPjFWdd... |

**Fee model:** Free verification · 0.5% on successful settlement (all chains)
