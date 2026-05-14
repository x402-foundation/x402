# Using x402-agentpay on top of AWS Bedrock AgentCore

**AgentPay = The Commerce Layer. AgentCore = The Runtime.**

This guide shows how to drop `x402-agentpay` into the [aws-samples/sample-agentcore-cloudfront-x402-payments](https://github.com/aws-samples/sample-agentcore-cloudfront-x402-payments) stack to add **escrow, reputation, capability-scoping, and multi-agent batch settlement** on top of AgentCore's managed payment transport.

---

## What AgentCore gives you (transport layer)
- Managed USDC wallet per agent
- `ProcessPayment` API signs x402 headers server-side
- IAM-scoped spending policies
- CloudFront + Lambda@Edge verifies payment proofs

## What x402-agentpay adds (commerce layer)
- **Escrow** — lock funds until service delivery is confirmed (not just "payment sent")
- **Capability registry** — agents advertise what they can do and what they charge per capability
- **Reputation scoring** — on-chain track record per agent address
- **Permission grants** — delegated spend authority across agent hierarchies
- **Batch settlement** — settle 100s of micro-transactions in one on-chain call
- **Audit ledger** — every payment gets a `ledger_id` + `receipt_hash` in the X-PAYMENT v3 header

---

## Installation

```bash
pip install x402-agentpay
```

---

## Integration in 3 steps

### Step 1 — Wrap the AgentCore ProcessPayment call

In `payer-agent/agent/tools.py`, replace the raw `ProcessPayment` call with AgentPay's escrow-aware wrapper:

```python
from x402_agentpay import AgentPayClient

agentpay = AgentPayClient(
    api_base="https://x402-agent-pay.com/api",
    agent_address="0xYourAgentWallet",
    api_key="YOUR_AGENTPAY_KEY"
)

# Instead of directly calling ProcessPayment:
# response = bedrock_agentcore.process_payment(x402_payload)

# Use AgentPay escrow — funds lock until content is verified delivered
escrow = agentpay.escrow.create(
    x402_payload=x402_payload,          # pass through from Lambda@Edge 402 response
    capability="content_access",         # what you're buying
    auto_release_seconds=300             # auto-release if no dispute in 5 min
)

# Now call ProcessPayment with the escrow receipt attached
payment_header = agentpay.build_payment_header(
    x402_payload=x402_payload,
    escrow_id=escrow["escrow_id"],
    receipt_hash=escrow["receipt_hash"]
)

# Retry the CloudFront request with the enriched X-PAYMENT v3 header
response = requests.get(content_url, headers={"X-PAYMENT": payment_header})
```

### Step 2 — Register capabilities on the seller side

In `seller-infrastructure/lib/lambda-edge/payment-verifier.ts`, add capability verification:

```typescript
import { verifyCapability } from 'x402-agentpay-node';  // npm package coming soon

// After standard x402 payment verification:
const capabilityOk = await verifyCapability({
  agentAddress: paymentProof.payer,
  capability: 'content_access',
  apiBase: 'https://x402-agent-pay.com/api'
});

if (!capabilityOk) {
  return { status: 403, body: 'Agent not authorized for this capability' };
}
```

### Step 3 — Read the enriched X-PAYMENT v3 header

AgentPay adds these fields to every payment header automatically:

```
X-PAYMENT: {
  "version": "3",
  "payload": "<standard x402 payload>",
  "ledger_id": "led_abc123",
  "receipt_hash": "0xdeadbeef...",
  "scope": "content_access",
  "capability": "premium_data",
  "grant_id": "grnt_xyz789"
}
```

Your Lambda@Edge verifier can log `ledger_id` for a complete audit trail — every payment traceable end-to-end.

---

## Full architecture with AgentPay

```
Browser → CloudFront (web-ui) → API Gateway → Lambda Proxy
                                                    ↓
                                            AgentCore Runtime
                                                    ↓
                                            Strands Agent
                                                ↓         ↓
                                    AgentCore         x402-agentpay
                                   ProcessPayment      escrow.create()
                                   (signs header)      (locks funds)
                                        ↓                   ↓
                                   X-PAYMENT v3 header (enriched)
                                        ↓
                              CloudFront (seller) → Lambda@Edge
                                        ↓
                                  x402.org facilitator
                                        ↓
                                  Base mainnet settlement
                                        ↓
                                  agentpay escrow.release()
                                  (funds to seller on delivery)
```

---

## Why this matters

AgentCore handles the **signing and wallet** layer. But it doesn't answer:

- Did the content actually get delivered?
- What if the agent disputes the quality?
- How do you batch 1000 micro-payments without paying 1000x gas?
- How do you know if this agent has a good track record before trusting it?

AgentPay answers all four. It's not a competitor to AgentCore — it's the commerce logic that runs on top of the transport.

---

## Links

- PyPI: `pip install x402-agentpay`
- Docs: https://x402-agent-pay.com
- Protocol: https://x402-agent-pay.com/protocol
- Patent pending — AgentPay escrow + reputation architecture

---

## Quick start (5 min)

```bash
pip install x402-agentpay boto3 strands-agents

# Set env vars
export AGENTPAY_API_KEY=your_key
export AGENTPAY_AGENT_ADDRESS=0xYourWallet

# Run the example
python examples/agentcore_with_escrow.py
```

---

*Built by [AgentPay / x402AgentPay](https://x402-agent-pay.com) — the commerce layer for autonomous agent economies.*
