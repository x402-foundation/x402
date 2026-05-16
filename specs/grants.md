# x402 Agent Grant Specification

**Version:** 1.2.0 (Solana Escrow + Multi-Chain)
**Status:** Production
**Repo:** https://github.com/shawnhvac/x402

---

## 1. Overview

An **x402 Agent Grant** is a signed authorization that delegates spending power from a principal to a sub-agent. It is encoded in the `X-402-Payment` header on every API request.

The same grant struct works across **EVM chains** (EIP-712 signed) and **Solana** (ed25519 signed). The `chainType` field routes verification. For Solana, an `escrowId` field seeds the PDA vault — enabling true escrow-until-delivery on Solana, identical to the EVM model.

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
    string chainType;       // "eip155" (default) or "solana"
    string chainId;         // CAIP-2: "8453" or "solana-mainnet"

    // SOLANA ESCROW FIELD (added v1.2.0)
    bytes32 escrowId;       // 32-byte PDA seed for Solana escrow vault
                            // (ignored on EVM — set to bytes32(0) if unused)
}
```

**Field notes:**
- `totalBudget` and `perRequestCap` are in USDC micro-units (1 USDC = 1,000,000)
- `chainType` defaults to `"eip155"` if omitted — fully backward compatible
- `escrowId` is only required when `chainType === "solana"` — seeds the PDA vault

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

> For Solana grants, the EIP-712 domain is not used — see Section 10.

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

**Solana payload:**
```json
{
  "grant": { "...x402Grant fields...", "chainType": "solana", "escrowId": "0x..." },
  "signature": "<base64(ed25519 sig)>",
  "chainType": "solana",
  "chainId": "solana-mainnet",
  "escrow": {
    "pda":   "<base58 escrow PDA>",
    "vault": "<base58 vault PDA>"
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
| Solana deadline | `escrow.deadline` = `grant.expiration` — auto-refund after |

---

## 9. Test Vectors

See [`test-vectors.json`](./test-vectors.json) — 7 vectors including Solana escrow.

Live conformance: `GET https://www.x402-agent-pay.com/x402/conformance`

---

## 10. Solana Support (`chainType = "solana"`)

Solana grants use the same struct but signed with ed25519. An `escrowId` seeds a PDA vault — USDC is locked until delivery or deadline.

### Signing (TypeScript / ed25519)

```typescript
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

function signSolanaGrant(grant: any, signer: Keypair): string {
  const sorted  = JSON.stringify(grant, Object.keys(grant).sort());
  const message = new TextEncoder().encode(sorted);
  const sig     = nacl.sign.detached(message, signer.secretKey);
  return Buffer.from(sig).toString("base64");
}

function verifySolanaGrant(grant: any, signatureB64: string, publicKeyBase58: string): boolean {
  const sorted    = JSON.stringify(grant, Object.keys(grant).sort());
  const message   = new TextEncoder().encode(sorted);
  const signature = Buffer.from(signatureB64, "base64");
  const pubKey    = new PublicKey(publicKeyBase58).toBytes();
  return nacl.sign.detached.verify(message, signature, pubKey);
}
```

### Verification (Python / facilitator)

```python
import nacl.signing, base58, json, base64

def verify_solana_grant(grant: dict, signature_b64: str, public_key_b58: str) -> bool:
    sorted_grant = json.dumps(grant, sort_keys=True, separators=(",", ":"))
    message  = sorted_grant.encode()
    sig      = base64.b64decode(signature_b64)
    pk_bytes = base58.b58decode(public_key_b58)
    try:
        nacl.signing.VerifyKey(pk_bytes).verify(message, sig)
        return True
    except Exception:
        return False
```

### Escrow PDA Seeds

```
escrow PDA = findProgramAddressSync([b"escrow", escrowId], PROGRAM_ID)
vault PDA  = findProgramAddressSync([b"vault",  escrowId], PROGRAM_ID)
```

### Escrow Lifecycle

| Step | Who | Action |
|------|-----|--------|
| 1 | Paying agent | Sign grant + call `initialize_escrow()` — USDC locked in vault PDA |
| 2 | Paying agent | Send `X-402-Payment` header with grant + escrow PDA addresses |
| 3 | Receiving agent | Verify ed25519 signature, call `release()` on delivery |
| 4 (timeout) | Anyone | Call `refund()` after deadline — principal gets USDC back |

### USDC Mint (Solana Mainnet)

```
EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

### Program

See [`programs/solana-escrow/`](../programs/solana-escrow/) — Anchor 0.30 program.
Client: [`clients/solana-escrow-client.ts`](../clients/solana-escrow-client.ts)

Deploy command:
```bash
anchor build
anchor deploy --provider.cluster mainnet
```

---

## 11. Supported Chains (AgentPay Facilitator v2.0)

| Chain | CAIP-2 | Signing | Settlement | Escrow |
|-------|--------|---------|-----------|--------|
| Base | eip155:8453 | EIP-712 | EIP-3009 | EVM contract |
| Ethereum | eip155:1 | EIP-712 | EIP-3009 | EVM contract |
| Optimism | eip155:10 | EIP-712 | EIP-3009 | EVM contract |
| Arbitrum | eip155:42161 | EIP-712 | EIP-3009 | EVM contract |
| Polygon | eip155:137 | EIP-712 | EIP-3009 | EVM contract |
| **Solana** | **solana:mainnet** | **ed25519** | **SPL transfer** | **PDA vault** |

Fee model: free verification · 0.5% on settlement · auto-refund on timeout
