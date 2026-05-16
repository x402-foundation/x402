# x402 Payment Flow

**Version:** 1.2.0 (Solana Escrow)
**Status:** Production

---

## Overview

The x402 payment lifecycle is identical for EVM and Solana — only the signing scheme and settlement mechanism differ. The `chainType` field in the grant determines which path is taken. For Solana, an on-chain PDA escrow is used instead of EIP-3009 authorization.

---

## Sequence Diagram — Full Flow (EVM + Solana)

```mermaid
sequenceDiagram
    participant Principal
    participant PayingAgent
    participant ReceivingAgent
    participant Chain as Chain (Base/USDC or Solana/USDC + Escrow)

    Principal->>PayingAgent: Issue grant (totalBudget, perRequestCap, chainType)
    PayingAgent->>PayingAgent: Build x402Grant struct (incl. escrowId for Solana)

    alt EVM (chainType = "eip155")
        PayingAgent->>PayingAgent: Sign with EIP-712 (signTypedData)
        PayingAgent->>PayingAgent: Sign EIP-3009 Authorization
    else Solana (chainType = "solana")
        PayingAgent->>PayingAgent: Sign with ed25519 (nacl.sign.detached)
        PayingAgent->>Chain: initialize_escrow() — lock USDC in PDA vault
    end

    PayingAgent->>ReceivingAgent: POST /api/tool<br/>X-402-Payment: base64({grant, signature, chainType, chainId, authorization/escrow})
    ReceivingAgent->>ReceivingAgent: verifyGrant() — routes by chainType

    alt EVM verification
        ReceivingAgent->>ReceivingAgent: EIP-712 recover_signer()
        ReceivingAgent->>Chain: transferWithAuthorization (EIP-3009)
        Chain-->>ReceivingAgent: Confirmed (2-6s on Base)
    else Solana verification
        ReceivingAgent->>ReceivingAgent: nacl.sign.detached.verify() (ed25519)
        Note over ReceivingAgent,Chain: USDC already locked in vault PDA
        ReceivingAgent->>ReceivingAgent: Deliver service
        ReceivingAgent->>Chain: release() — unlock USDC to receiver ATA
        Chain-->>ReceivingAgent: Confirmed (<1s on Solana)
    end

    alt Success
        ReceivingAgent-->>PayingAgent: HTTP 200 + X-402-Receipt: {txHash, network, amount, escrowId?}
    else Failure / Timeout
        ReceivingAgent-->>PayingAgent: HTTP 402 + reason
        Note over PayingAgent,Chain: After deadline: anyone calls refund()<br/>USDC returns to principal ATA
    end
```

---

## Solana Escrow Detail

**Program ID (Devnet):** `CNwRWLCUL7jgk3xEgvMCeUFyt73LNEPtvucwxm3YqsFb`

**Network:** Solana Devnet → Mainnet after audit

```mermaid
sequenceDiagram
    participant PayingAgent
    participant Facilitator
    participant SolanaChain as Solana (USDC + x402_escrow Program)
    participant ReceivingAgent

    PayingAgent->>PayingAgent: Generate 32-byte escrowId
    PayingAgent->>SolanaChain: initialize_escrow(escrowId, amount, deadline)
    SolanaChain-->>PayingAgent: Escrow PDA + vault PDA created, USDC locked

    PayingAgent->>ReceivingAgent: X-402-Payment (grant + sig + escrow.pda + escrow.vault)
    ReceivingAgent->>Facilitator: POST /x402/verify-grant (ed25519 check)
    Facilitator-->>ReceivingAgent: isValid: true

    ReceivingAgent->>ReceivingAgent: Deliver service
    ReceivingAgent->>SolanaChain: release(escrowPda, vaultPda, receiverAta)
    SolanaChain-->>ReceivingAgent: USDC transferred (<1s)
    ReceivingAgent-->>PayingAgent: HTTP 200 + X-402-Receipt

    alt Timeout (deadline passed, not released)
        Facilitator->>SolanaChain: refund(escrowPda, vaultPda, principalAta)
        SolanaChain-->>PayingAgent: USDC returned to principal
    end
```

---

## Step-by-Step (Solana Path)

### Step 1 — Principal Issues Grant

```typescript
const grant: X402SolanaGrant = {
  grantId:       "42",
  principal:     "6aCEuwH3PYx99cEmRz45otfxk39uF7ewGhqmvxfXisSG",
  agent:         "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy",
  issuedAt:      Math.floor(Date.now() / 1000),
  expiration:    Math.floor(Date.now() / 1000) + 3600,
  totalBudget:   1_000_000,    // $1.00 USDC
  perRequestCap: 5_000,        // $0.005 USDC per call
  chainType:     "solana",
  chainId:       "solana-mainnet",
  escrowId:      crypto.randomBytes(32).toString("hex"),
};
```

### Step 2 — Lock USDC in PDA Vault

```typescript
import { initializeEscrow } from "../clients/solana-escrow-client";

const { escrowPda, vaultPda, txSignature } = await initializeEscrow(
  connection,
  principalKeypair,
  new PublicKey(grant.agent),
  grant.perRequestCap,
  grant.expiration,
  grant.escrowId
);
```

### Step 3 — Sign Grant + Build Header

```typescript
import { signSolanaGrant, buildSolanaPaymentHeader } from "../clients/solana-escrow-client";

const signature = signSolanaGrant(grant, principalKeypair);
const header    = buildSolanaPaymentHeader(grant, signature, escrowPda, vaultPda);
// → set X-402-Payment: <header> on all requests
```

### Step 4 — Receiver Verifies + Releases

```typescript
// On receiving agent:
const isValid = verifySolanaGrant(grant, signature, grant.principal);
if (!isValid) return res.status(401).json({ error: "invalid signature" });

// Deliver service...

// Release escrow:
await releaseEscrow(connection, receiverKeypair, escrowPda, vaultPda, receiverAta);
```

### Step 5 — Auto-Refund (Timeout)

The AgentPay facilitator spawns a watcher for every Solana escrow. After `grant.expiration + 5s`, if the escrow hasn't been released, `refund()` is called automatically — USDC returns to the principal.

---

## Timing

| Chain | Lock | Confirmation | Auto-Refund |
|-------|------|-------------|------------|
| Base (L2) | EIP-3009 auth | 2–6s | N/A (no lock) |
| Ethereum | EIP-3009 auth | 12–30s | N/A |
| Optimism | EIP-3009 auth | 2–6s | N/A |
| Arbitrum | EIP-3009 auth | 1–3s | N/A |
| Polygon | EIP-3009 auth | 2–5s | N/A |
| **Solana** | **PDA vault lock** | **< 1s** | **After deadline** |

---

## Error Codes

| HTTP | Meaning |
|------|---------|
| 200 | Success — service delivered |
| 402 | Payment required or invalid grant |
| 401 | Signature verification failed |
| 400 | Malformed request or missing escrowId |
| 500 | Settlement / escrow transaction failed |

---

## Live Facilitator

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/x402/verify-grant` | POST | Verify EIP-712 or ed25519 grant |
| `/x402/verify` | POST | Verify EIP-3009 payment payload |
| `/x402/settle` | POST | Settle EVM (EIP-3009) or Solana (SPL) |
| `/x402/supported-networks` | GET | All 6 chains with CAIP-2 IDs |
| `/x402/conformance` | GET | Run all 7 test vectors |
| `/x402/info` | GET | Facilitator metadata |

**Base URL:** `https://www.x402-agent-pay.com`
**Spec:** https://github.com/shawnhvac/x402
