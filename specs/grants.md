# x402 Agent Grants — EIP-712 Specification

**Status:** V1 Reference Implementation  
**Last Updated:** May 2026

## Overview

An x402 grant is a **signed permission** that authorizes one agent (the "agent") to spend money on behalf of another (the "principal").

Grants are:
- **Signed with EIP-712** — using the principal's private key
- **Time-bounded** — expire after a specified timestamp
- **Budget-capped** — per-request and total limits
- **Revocable** — via on-chain registry (checked only in final 30% of lifetime)
- **Cryptographically verifiable** — any receiver can validate offline

## Grant Structure

```typescript
struct x402Grant {
  uint256 grantId;           // Unique grant identifier
  address principal;         // Who is authorizing the spend (signer)
  address agent;             // Who is authorized to spend
  uint256 issuedAt;          // Unix timestamp when grant was signed
  uint256 expiration;        // Unix timestamp when grant expires
  uint256 totalBudget;       // Total USDC available (in wei, 6 decimals)
  uint256 perRequestCap;     // Max USDC per single request (in wei)
  bytes32[] scopes;          // Tool scopes authorized (e.g., keccak256("trade"))
  bytes32 salt;              // Replay attack prevention
}
```

## EIP-712 Domain

```typescript
const DOMAIN = {
  name: "x402-AgentGrant",
  version: "1",
  chainId: 8453,              // Base L2
  verifyingContract: "0x0000000000000000000000000000000000000000",
};
```

## TypeScript Implementation

### Signing a Grant

```typescript
import { ethers } from "ethers";

const DOMAIN = {
  name: "x402-AgentGrant",
  version: "1",
  chainId: 8453,
  verifyingContract: "0x0000000000000000000000000000000000000000",
};

const TYPES = {
  x402Grant: [
    { name: "grantId", type: "uint256" },
    { name: "principal", type: "address" },
    { name: "agent", type: "address" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "totalBudget", type: "uint256" },
    { name: "perRequestCap", type: "uint256" },
    { name: "scopes", type: "bytes32[]" },
    { name: "salt", type: "bytes32" },
  ],
};

async function signGrant(wallet, grant) {
  const signature = await wallet.signTypedData(DOMAIN, TYPES, grant);
  return signature;
}
```

### Verifying a Grant (Reference Implementation)

```typescript
import { ethers } from "ethers";

function verifyGrant(grant, signature, expectedAgent, now = Math.floor(Date.now() / 1000)) {
  // 1. Check expiration (with 30-second grace period)
  if (grant.expiration < now - 30 || grant.issuedAt > now + 30) {
    return false; // Grant is expired or not yet valid
  }

  // 2. Recover signer from signature
  const DOMAIN = {
    name: "x402-AgentGrant",
    version: "1",
    chainId: 8453,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  };

  const TYPES = {
    x402Grant: [
      { name: "grantId", type: "uint256" },
      { name: "principal", type: "address" },
      { name: "agent", type: "address" },
      { name: "issuedAt", type: "uint256" },
      { name: "expiration", type: "uint256" },
      { name: "totalBudget", type: "uint256" },
      { name: "perRequestCap", type: "uint256" },
      { name: "scopes", type: "bytes32[]" },
      { name: "salt", type: "bytes32" },
    ],
  };

  let recoveredSigner;
  try {
    recoveredSigner = ethers.verifyTypedData(DOMAIN, TYPES, grant, signature);
  } catch {
    return false; // Signature is invalid
  }

  // 3. Verify the recovered signer matches the principal
  if (recoveredSigner.toLowerCase() !== grant.principal.toLowerCase()) {
    return false;
  }

  // 4. Verify the agent matches what we expect
  if (grant.agent.toLowerCase() !== expectedAgent.toLowerCase()) {
    return false;
  }

  // 5. Verify grant has non-zero budget
  if (grant.totalBudget <= 0n) {
    return false;
  }

  return true;
}
```

### Python Equivalent (eth-keys)

```python
from eth_keys import keys
from eth_account.messages import encode_defunct
import json

def verify_grant_python(grant, signature_hex, expected_agent):
    # Reconstruct the EIP-712 hash (simplified for readability)
    # In production, use eth_account.messages.encode_structured_data()
    
    # For test vectors, raw ECDSA recovery:
    sig_bytes = bytes.fromhex(signature_hex[2:])
    v, r, s = sig_bytes[-1], sig_bytes[:32], sig_bytes[32:64]
    
    message_hash = compute_eip712_hash(grant)
    recovered_pubkey = keys.PublicKey.from_signature_and_message(
        signature=keys.Signature(vrs=(v, int.from_bytes(r, 'big'), int.from_bytes(s, 'big'))),
        message_hash=message_hash
    )
    recovered_address = recovered_pubkey.to_checksum_address()
    
    # Verify
    return (
        recovered_address.lower() == grant['principal'].lower() and
        grant['agent'].lower() == expected_agent.lower() and
        grant['expiration'] > int(time.time()) and
        grant['totalBudget'] > 0
    )
```

## Revocation Check

Grants can be revoked on-chain. However, to optimize for latency, receivers only check the revocation registry during the **final 30% of the grant's lifetime**.

```typescript
function shouldCheckRevocation(grant, now = Math.floor(Date.now() / 1000)) {
  const lifetime = Number(grant.expiration - grant.issuedAt);
  const remaining = Number(grant.expiration - BigInt(now));
  return remaining < lifetime * 0.3;
}
```

**Example:**
- Grant issued at t=0, expires at t=900 (15 minutes)
- Lifetime = 900 seconds
- Revocation only checked when remaining time < 270 seconds (last 4.5 minutes)

This balances security (grants can still be revoked) with performance (no registry query on every request).

## Test Vectors

All conformance tests are in [specs/test-vectors.json](specs/test-vectors.json).

### Conformance Test Cases

1. **Valid Grant** — correctly signed, not expired, agent matches
2. **Expired Grant** — issuedAt or expiration is in the past
3. **Invalid Signature** — modified grant, signature doesn't verify
4. **Wrong Agent** — grant is for a different agent address
5. **Zero Budget** — totalBudget is 0
6. **Signature Not Recovered** — malformed signature bytes

Each test vector provides:
- The full grant struct
- The expected signature
- The test's expected outcome (pass/fail)

## Integration Notes

### When Building a Receiving Agent

1. **Receive the grant** — extract from `X-402-Payment` header (base64-decoded)
2. **Verify immediately** — call `verifyGrant()` before executing any tool
3. **Check revocation (if needed)** — only if `shouldCheckRevocation()` returns true
4. **Verify budget** — ensure `perRequestCap >= toolCost` and `totalBudget >= toolCost`
5. **Deduct from budget** — after tool execution succeeds, record the deduction
6. **Return receipt** — include `X-402-Receipt` header with settlement proof

### When Building a Paying Agent

1. **Create the grant** — populate all fields, set appropriate expiration (15 min typical)
2. **Sign with principal's key** — use `signGrant(wallet, grant)`
3. **Encode for HTTP** — base64(JSON.stringify({ grant, signature, receiptHash }))
4. **Send request** — include `X-402-Payment` header in every tool request
5. **Handle 402 responses** — if receiver returns 402, the grant was invalid or revoked
6. **Handle receipts** — extract `X-402-Receipt` header, verify settlement on-chain

---

**Maintained by:** AgentPay Team  
**License:** MIT
