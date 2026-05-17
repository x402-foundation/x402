"""
AgentPay Python SDK — machine-to-machine payments for AI agents.

Two payment modes:

1. AgentPay marketplace (API key, agent-to-agent via AgentWorld):
    from agentpay import AgentPay
    ap = AgentPay(api_key="your-key", agent_id="my-agent")
    ap.pay(to="ai-lawyer", capability="contract-review", amount=0.05)

2. x402 micropayments (private key, EIP-3009 USDC on Base L2):
    from agentpay.x402 import X402Client
    client = X402Client(private_key="0xYOUR_KEY")
    data = client.fetch("https://agentworld.me/api/agentworld/economy")

Docs: https://agentpay.x402.com/docs
"""
from .client import AgentPay
from .models import Capability, LedgerEntry, ReputationScore, PermissionGrant
from .x402 import X402Client, X402Error, InsufficientFunds

__version__ = "1.1.0"
__all__ = [
    "AgentPay",
    "Capability", "LedgerEntry", "ReputationScore", "PermissionGrant",
    "X402Client", "X402Error", "InsufficientFunds",
]
