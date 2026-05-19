# AgentPay — x402 Payment Facilitator

> Production x402 payment facilitator for autonomous AI agents, OpenClaw skills, and any HTTP-speaking system. Register free. Pay and get paid in USDC on Base L2. No human required.

## Install

```bash
pip install x402-agentpay

curl -X POST https://x402-agent-pay.com/api/agentpay/register \
  -H "Content-Type: application/json" \
  -d '{"name": "my-openclaw-agent", "wallet": "0xYourWallet", "agent_type": "ai_agent"}'
```

## What This Skill Does

Use this skill when your OpenClaw agent needs to:

- **Pay for an API or data service** that returns `HTTP 402 Payment Required`
- **Receive USDC payments** from other agents or businesses autonomously
- **Verify an incoming x402 grant** before serving data or completing a task
- **Check payment status or receipt** for a completed settlement
- **Register a new endpoint** for a tool, service, or device on the x402 network

## Usage

```python
from x402_agentpay import FacilitatorClient

client = FacilitatorClient(api_key="YOUR_API_KEY")

# Pay an x402-protected endpoint
receipt = client.pay_endpoint(
    endpoint_url="https://api.example.com/data",
    amount_usdc=0.001
)
print(f"Settled: {receipt['tx_hash']}")

# Verify an incoming payment grant
result = client.verify_grant(
    grant_header=request.headers.get("X-402-Payment")
)
if result['valid']:
    # serve the response
    pass
```

## Protocol

AgentPay implements the [x402 open standard](https://x402.org):

- **EIP-712 Agent Grants** in the X-402-Payment header
- **USDC escrow** — funds held until service confirmed
- **Base L2** — <2s settlement, ~$0.000425 gas per tx
- **EIP-3009 transferWithAuthorization** for atomic settlement

## Configuration

```bash
AGENTPAY_API_KEY=your_api_key_here
AGENTPAY_FACILITATOR_URL=https://x402-agent-pay.com
```

## Pricing

- Free to register — no monthly fee
- $0.02 USDC flat fee per settlement on Base L2
- You keep 98%+ of revenue on your own endpoints

## Links

- Website: https://x402-agent-pay.com
- Docs: https://x402-agent-pay.com/docs
- Quick Start: https://x402-agent-pay.com/getting-started.html
- Get API Key: https://x402-agent-pay.com/onboard
- GitHub: https://github.com/shawnhvac/x402
- OpenClaw Showcase: https://github.com/openclaw/openclaw/issues/84342

## Author

Shawn Lippert - AgentPay Team - https://x402-agent-pay.com
