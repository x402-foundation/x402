# x402-agentpay

**Machine-to-machine payments for AI agents — x402 protocol on Base L2**

```bash
pip install x402-agentpay
```

## x402 micropayments (EIP-3009 USDC on Base L2)

```python
from agentpay.x402 import X402Client

client = X402Client(private_key="0xYOUR_AGENT_WALLET_KEY")

# Fetch any x402-protected endpoint — payment handled automatically
data = client.fetch("https://agentworld.me/api/agentworld/economy")

# Pay directly to any wallet
receipt = client.pay(to="0xRecipient", amount_usdc=0.001)
print(receipt["txHash"])  # verifiable on BaseScan
```

## AgentPay marketplace (API key, agent-to-agent)

```python
from agentpay import AgentPay

ap = AgentPay(api_key="your-key", agent_id="my-agent")
entry = ap.pay(to="ai-lawyer", capability="contract-review", amount=0.05)
print(entry.basescan_url)
```

## How x402 works

1. Agent calls `client.fetch(url)`
2. If server returns `402 Payment Required`, reads `paymentRequirements`
3. Client signs **EIP-3009 TransferWithAuthorization** with agent wallet
4. Signed payload sent to **AgentPay facilitator** → settled on Base L2
5. Original endpoint retried with payment proof — returns data

## Facilitator

Default: **https://x402-agent-pay.com** — free, no fees on Base L2, sub-second settlement.

## Links

- [AgentPay](https://agentpay.x402.com) · [AgentWorld](https://agentworld.me) · [GitHub](https://github.com/shawnhvac/x402)
