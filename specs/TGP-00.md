# TGP-00: Transaction Gateway Protocol

**Status:** Draft Proposal  
**Author:** [David Bigge](mailto:dbigge@ledgerofearth.com)  
**Organization:** Ledger of Earth  
**Created:** November 2025  
**Category:** Scheme / Protocol Extension  
**Spec-Version:** 0.1-draft  

---

## Abstract

The **Transaction Gateway Protocol (TGP)** defines an optional coordination layer above **x402** that enables secure, policy-based transaction routing between multiple administrative or economic domains — called **Transaction Areas (TxAs)**.

TGP extends the x402 payment transport model to support **cross-domain settlement**, **policy negotiation**, and **trust-boundary discovery** while preserving x402’s minimalism and transport-agnostic design.  
It is intended for scenarios where payments must traverse multiple gateways or adhere to domain-specific compliance and metering policies.

---

## Motivation

While x402 enables direct client–server payments, emerging AI and machine-to-machine use cases increasingly require **multi-domain transaction flows** that span different trust, jurisdictional, or policy boundaries.  

TGP addresses this need by:

- Providing a **BGP-like coordination model** for value routing between Transaction Areas.  
- Enabling **atomic single-hop settlement** between gateways with policy enforcement.  
- Allowing **cross-domain micropayments** and dynamic pricing negotiation.  
- Supporting **telecom-grade control-plane** features such as Transaction Detail Records (TDRs), compliance signaling, and failover routes.  

TGP is designed to be compatible with the **Usage-Based Payment Scheme**, **Arbitrary Token Support**, and **MCP integration** initiatives described in the x402 roadmap.

---

## Specification

### 1. Definitions

| Term | Definition |
|------|-------------|
| **Transaction Border Controller (TBC)** | A facilitator that enforces domain-specific policy and logs settlement records. |
| **Transaction Area (TxA)** | An administrative or economic domain sharing a common policy root, similar to an Autonomous System in BGP. |
| **Policy Header** | A structured metadata object defining allowed tokens, pricing models, and settlement rules. |
| **Transaction Detail Record (TDR)** | A verifiable log entry describing the transaction flow, response codes, and settlement results. |

---

### 2. TGP Header Extensions

The following optional HTTP-style headers extend the standard x402 `X-PAYMENT` envelope.

| Header | Description | Example |
|---------|--------------|---------|
| `X-TGP-Area` | Identifier of the originating Transaction Area | `X-TGP-Area: 65001` |
| `X-TGP-Path` | Route vector or path across multiple gateways | `X-TGP-Path: 65001,65002,65003` |
| `X-TGP-Policy` | JSON object describing compliance, pricing, or token limits | `X-TGP-Policy: {"maxValue":"$5","allowedTokens":["USDC","PLSX"],"expiry":"600s"}` |
| `X-TGP-Proof` | Optional zero-knowledge or hash proof of policy compliance | `X-TGP-Proof: zkp:0xabc123...` |

These headers **must not** alter the underlying x402 payment semantics.  
They serve only as **advisory and auditable metadata** for inter-domain coordination.

---

### 3. Transaction Area Registry

Each Transaction Area publishes a signed JSON manifest at a discoverable endpoint or registry (e.g., via the x402 Bazaar).  
The manifest defines:

```json
{
  "area_id": "65001",
  "org": "Ledger of Earth",
  "policy_root": "https://example.com/policy.json",
  "supported_schemes": ["exact", "upto", "tgp"],
  "settlement_contracts": ["0xabc..."],
  "contact": "admin@ledgerofearth.com"
}
```

This enables peer gateways to verify authenticity and advertise their routes, similar to BGP peering.

---

### 4. Routing & Settlement Model

TGP supports both **single-hop** and future **multi-hop** transaction flows.

#### 4.1 Single-Hop Model

```
Client → Gateway_A (TxA65001) → Gateway_B (TxA65002) → Merchant
```

1. Client initiates x402 payment with additional TGP headers.  
2. Gateway_A validates policy and adds its area signature.  
3. Gateway_B accepts the payment, settles locally, and emits a TDR.  
4. Optionally, both gateways exchange signed receipts for atomic confirmation.

#### 4.2 Multi-Hop Extension (Future)

Gateways MAY relay payments through multiple TxAs using HTLC or ZK proofs for atomic settlement across domains.  
Routing policies are determined by cost, trust, or compliance metadata.

---

### 5. Transaction Detail Record (TDR)

Each participating gateway SHOULD log and optionally broadcast a structured TDR:

```json
{
  "txid": "0x123...",
  "origin_area": "65001",
  "dest_area": "65002",
  "timestamp": "2025-11-03T09:00:00Z",
  "amount": "1.00",
  "token": "USDC",
  "status": "SETTLED",
  "policy_ref": "hash:0xabc..."
}
```

TDRs may be stored locally, transmitted via REST, or aggregated into analytics systems.  
This supports carrier-grade accountability without disclosing customer data.

---

### 6. Security Considerations

- **No custody** — TGP gateways MUST NOT hold funds on behalf of users; they only relay policy and settlement metadata.  
- **ZK Proofs Optional** — `X-TGP-Proof` is optional but recommended when policy compliance cannot be publicly verified.  
- **Replay Protection** — Gateways SHOULD verify nonce uniqueness and timestamp validity.  
- **Auditability** — TDRs SHOULD be signed and timestamped to prevent forgery or repudiation.  
- **Privacy** — TGP headers SHOULD avoid including personally identifiable information (PII).  

---

### 7. Compatibility

- Fully compatible with x402 “exact” and “upto” schemes.  
- Intended for use with EIP-3009-compatible tokens (USDC, etc.).  
- Chain-agnostic — supports EVM, Base, PulseChain, and Solana through common interface patterns.  
- Aligns with future ERC-8004 “Trustless Agents” standard.

---

### 8. Example Request

```http
POST /api/resource HTTP/1.1
Host: gateway-b.txarea.net
X-PAYMENT: eyJhbGciOi...   (standard x402 payload)
X-TGP-Area: 65001
X-TGP-Route: 65001,65002
X-TGP-Policy: {"maxValue":"$1.00","allowedTokens":["USDC"],"expiry":"120s"}
X-TGP-Proof: zkp:0xabc123...

{
  "data": "hello world"
}
```

---

### 9. Implementation Notes

- TGP can be implemented as a **middleware layer** or **sidecar** around existing x402 facilitators.  
- Go and TypeScript reference implementations will be provided via the [Ledger of Earth/x402-tgp](https://github.com/ledgerofearth/x402-tgp) repository.  
- No modifications to the core paywall package are required for basic interoperability.

---

### 10. Future Work

- Multi-hop HTLC settlement  
- Dynamic route advertisement (TGP-BGP bridge)  
- Integration with ERC-8004 Trustless Agent identities  
- Carrier-grade telemetry (aggregated TDR dashboards)  
- Policy-as-code registry for automated compliance negotiation  

---

### References

- [x402 Specification](https://github.com/murrlincoln/x402)  
- [Usage-Based Payment Scheme (Draft)](https://github.com/murrlincoln/x402#readme)  
- [ERC-8004 Trustless Agents (Draft EIP)](https://eips.ethereum.org/)  
— Reference Implementation: [Ledger of Earth / Transaction Gateway Protocol](https://github.com/ledgerofearth/transaction-gateway-protocol)
---

*This document is an open community proposal and does not modify x402 core functionality without CDP approval.*
