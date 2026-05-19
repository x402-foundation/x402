# x402AgentPay Protocol Specification v1.0

**Author:** Shawn T. Lippert (AgentPay)  
**Published:** May 19, 2026  
**Patent Status:** Patent Pending  
**Repository:** https://github.com/shawnhvac/-x402-agent-network  
**Reference Implementation:** https://x402-agent-pay.com  
**Contact:** shawnlippert383@gmail.com  

---

## Abstract

x402AgentPay is an open protocol enabling autonomous AI agents to discover, negotiate, and settle payments for digital services using HTTP 402 as a machine-native payment signal. It extends the HTTP 402 "Payment Required" status code into a full request-response payment lifecycle, combining EIP-712 typed structured data signing, EIP-3009 `transferWithAuthorization` on Base L2, and agent-to-agent service discovery — enabling zero-human, zero-invoice, zero-bank commerce between software agents at internet scale.

This document establishes the original prior art for the x402AgentPay protocol architecture, including its agent grant structure, facilitator escrow model, reputation system, and multi-party settlement flow.

---

## 1. Background & Original Problem Statement

The internet's payment infrastructure was designed for humans. Credit cards, invoices, and subscription billing all assume a human initiates and approves each transaction. This creates fundamental friction for autonomous AI agents that must:

- Discover services programmatically
- Negotiate pricing without human approval
- Pay per-request rather than per-subscription
- Operate across organizational boundaries without shared accounts
- Settle instantly without chargebacks or dispute resolution

**The original insight (2024):** HTTP already has a built-in payment signal — status code 402 "Payment Required" — that has been reserved since 1991 but never standardized. By defining a machine-readable payment negotiation protocol on top of 402, autonomous agents can pay for API access the same way browsers request web pages: send a request, receive a response, act on it.

This insight is the foundation of x402AgentPay and constitutes the original inventive concept for which patent protection is pending.

---

## 2. Core Protocol Design

### 2.1 The Agent Grant

The core payment primitive is the **Agent Grant** — a signed EIP-712 typed structured data object that authorizes a specific USDC transfer from an agent's wallet to a service provider, for a specific endpoint, at a specific price, with an expiry.

```
AgentGrant {
  domain: {
    name: "x402AgentPay",
    version: "1",
    chainId: 8453,          // Base L2
    verifyingContract: <USDC_ADDRESS>
  },
  types: {
    AgentGrant: [
      { name: "from",       type: "address" },
      { name: "to",         type: "address" },
      { name: "value",      type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore",type: "uint256" },
      { name: "nonce",      type: "bytes32" },
      { name: "endpoint",   type: "string"  },
      { name: "agentId",    type: "string"  }
    ]
  }
}
```

**Key properties:**
- Signed client-side, no private key ever transmitted
- Single-use nonce prevents replay attacks
- Time-bounded via `validBefore` (typically 60–300 seconds)
- Endpoint-scoped: a grant for `/api/weather` cannot be used for `/api/data`
- EIP-3009 compatible: maps directly to `transferWithAuthorization` on USDC

### 2.2 The Payment Lifecycle

```
AGENT                          FACILITATOR                     PROVIDER
  |                                |                               |
  |-- GET /api/endpoint ---------->|                               |
  |<-- 402 Payment Required -------|                               |
  |    X-402-Price: 0.01           |                               |
  |    X-402-Recipient: 0x...      |                               |
  |    X-402-Scheme: eip3009-usdc  |                               |
  |    X-402-Network: base         |                               |
  |                                |                               |
  |  [Agent signs AgentGrant]      |                               |
  |                                |                               |
  |-- POST /api/endpoint --------->|                               |
  |   X-402-Payment: <signed_grant>|                               |
  |                                |                               |
  |                  [Facilitator verifies EIP-712 sig]            |
  |                  [Checks nonce not used]                       |
  |                  [Verifies agent USDC balance]                 |
  |                                |                               |
  |                  [Calls transferWithAuthorization on-chain]    |
  |                                |-- Forward request ----------->|
  |                                |<-- 200 OK + response ---------|
  |<-- 200 OK + response -----------|                               |
```

### 2.3 The Facilitator

The **Facilitator** is a trustless relay and settlement engine that:

1. Parses the `X-402-Payment` header
2. Verifies the EIP-712 Agent Grant signature (raw ECDSA, no "Ethereum Signed Message" prefix)
3. Checks the nonce registry for replay prevention
4. Submits `transferWithAuthorization` to the USDC contract on Base L2
5. Forwards the original request to the provider upon settlement confirmation
6. Updates the agent's reputation score

**Critical implementation note:** EIP-712 signing uses raw ECDSA. Never prepend the "Ethereum Signed Message" prefix — this is a common implementation error that breaks signature verification.

### 2.4 Agent Discovery (AgentCore)

x402AgentPay includes a discovery layer that enables agents to find providers without human configuration:

```json
GET /.well-known/agent.json

{
  "name": "WeatherAPI Provider",
  "version": "1.0",
  "x402_facilitator": "https://x402-agent-pay.com",
  "endpoints": [
    {
      "path": "/api/weather",
      "method": "GET",
      "price_usdc": "0.01",
      "description": "Current weather for any location",
      "network": "base"
    }
  ]
}
```

This `/.well-known/agent.json` standard is an original contribution of x402AgentPay, enabling zero-configuration agent-to-agent service mesh formation.

---

## 3. The Reputation System

x402AgentPay introduces a **tri-factor reputation score** for agents that directly influences payment terms and service access:

```
reputation_score = (0.60 × success_rate) 
                 + (0.25 × provider_diversity) 
                 + (0.15 × time_decay_factor)
```

**Factors:**
- `success_rate`: Ratio of successful settlements to total attempts (last 90 days)
- `provider_diversity`: Number of distinct providers paid (normalized, max 1.0)
- `time_decay_factor`: Recency weighting — recent activity scored higher than old

**Uses:**
- Providers can gate access to `reputation_score >= 0.7`
- High-reputation agents may receive preferential pricing
- Low-reputation agents may be required to pre-stake collateral

This reputation model is an original inventive element of x402AgentPay.

---

## 4. Multi-Party Settlement & Revenue Share

x402AgentPay supports a **revenue pool model** where platform participants earn a share of settlement fees based on volume contribution:

```
Settlement fee: $0.02 USDC per transaction

Distribution:
├── Provider:          receives requested amount (100% of service price)
├── Revenue Pool:      20-30% of $0.02 fee → shared by registered partners by volume
└── Platform (AgentPay): remainder of $0.02 fee
```

Partners register via `POST /api/agentpay/register` and receive:
- `api_key` for authenticated access
- `partner_id` for revenue attribution
- Pool share proportional to settlement volume routed through their integration

---

## 5. AgentWorld — Live Reference Implementation

**AgentWorld** (https://agentworld.me) is the production reference implementation of x402AgentPay, demonstrating the protocol's capabilities at scale:

- **99+ autonomous AI agents** operating across 10 simulated cities
- **Real on-chain settlement** — every agent transaction settles via x402AgentPay on Base L2
- **AGWC token** (contract: `0xfa6071375b2bC079BF781D51906Beee0b6F53b0B`) — native utility token
- **Treasury**: `0x367F1b3D8Ca90D1e087481a9A40d585Bf3451a03` (Base L2)
- **Live since:** April 2026
- **Monthly settlements:** 75M+ transactions ecosystem-wide (x402 protocol total)

AgentWorld demonstrates that x402AgentPay can power a full autonomous agent economy with real USDC flows, organic agent behavior, and on-chain settlement — without any human-initiated payment step.

---

## 6. Prior Art Timeline

| Date | Event |
|------|-------|
| 2024 | Original concept: x402AgentPay — AI agents pay for APIs via HTTP 402 |
| Early 2026 | AgentPay facilitator v1 deployed on Base L2 |
| April 2026 | AgentWorld live — reference implementation with 90+ agents |
| May 2, 2026 | PR submitted to x402-foundation/x402: "Add AgentPay — Services/Endpoints + Multi-Chain Facilitator" (2 comments) |
| May 2026 | Tate Programs onboarded as first external partner |
| May 15, 2026 | x402 specs + reference implementation published to github.com/shawnhvac/x402 |
| May 19, 2026 | This specification published — public timestamped prior art record |

---

## 7. What Is Patent Pending

The following specific innovations constitute the subject matter for which patent protection is pending:

1. **The Agent Grant structure** — an EIP-712 typed data object that simultaneously functions as a payment authorization AND an API access credential, eliminating the need for API keys

2. **The 402-negotiate-settle lifecycle** — the three-phase HTTP protocol (402 response → client signing → authorized forwarding) as applied specifically to autonomous software agent payment flows

3. **Endpoint-scoped signed authorizations** — restricting a payment grant to a specific URL path, preventing use of a payment credential across service boundaries

4. **The tri-factor agent reputation system** — success rate + provider diversity + time decay as a composite creditworthiness signal for autonomous agents

5. **The /.well-known/agent.json discovery standard** — enabling zero-configuration agent-to-agent service mesh formation via a well-known URI convention

6. **Multi-party revenue pool attribution** — distributing facilitator fees to ecosystem participants proportionally by volume, without custodying funds

---

## 8. Implementation References

| Component | Location |
|-----------|----------|
| Facilitator (Python) | https://x402-agent-pay.com/docs |
| Agent Grant signing (TypeScript) | https://github.com/shawnhvac/-x402-agent-network |
| Substreams integration (Rust) | https://github.com/shawnhvac/x402 |
| AgentWorld reference impl | https://agentworld.me |
| OpenAPI spec | https://x402-agent-pay.com/openapi.json |

---

## 9. License

This specification is published under Creative Commons Attribution 4.0 International (CC BY 4.0).

The reference implementation is open source. The specific protocol innovations described in Section 7 are subject to pending patent protection. Use of this specification to build compatible implementations is permitted and encouraged. Use of the specific patented innovations in a competing facilitator product requires a license.

---

*Published May 19, 2026 by Shawn T. Lippert / AgentPay*  
*Patent Pending — Application on file*  
*This document constitutes a public timestamped record of prior art.*
