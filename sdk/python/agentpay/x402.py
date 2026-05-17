"""
agentpay.x402 — EIP-3009 x402 micropayment client for AI agents on Base L2.

Handles the full x402 payment flow automatically:
  1. Hits endpoint — if 402, reads paymentRequirements
  2. Signs EIP-3009 TransferWithAuthorization with agent wallet
  3. POSTs signed payload to AgentPay facilitator /x402/settle
  4. Retries original endpoint with payment proof header

No API keys. No subscriptions. Pure EVM + USDC on Base L2.

Example::

    from agentpay.x402 import X402Client

    client = X402Client(private_key="0xYOUR_AGENT_WALLET_KEY")

    # Auto-pay any x402 endpoint
    data = client.fetch("https://agentworld.me/api/agentworld/economy")

    # Pay directly to a wallet
    receipt = client.pay(to="0xRecipient", amount_usdc=0.001)
    print(receipt["txHash"])
"""
import uuid, time
import httpx
from eth_account import Account
from web3 import Web3

FACILITATOR_URL = "https://x402-agent-pay.com"
USDC_BASE       = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
CHAIN_ID        = 8453
CAIP2           = "eip155:8453"


class X402Error(Exception):
    """Payment or settlement failed."""
    pass

class InsufficientFunds(X402Error):
    """Agent wallet has insufficient USDC."""
    pass


class X402Client:
    """
    x402 micropayment client — EIP-3009 USDC on Base L2.

    Args:
        private_key:   Agent wallet private key (hex, 0x prefix optional)
        facilitator:   Facilitator URL (default: https://x402-agent-pay.com)
        max_per_call:  Max USDC per automatic payment (default: 0.01)
        timeout:       HTTP timeout seconds (default: 30)

    Example::

        from agentpay.x402 import X402Client

        client = X402Client(private_key="0xabc...")

        # Fetch a paid x402 endpoint — payment auto-handled
        data = client.fetch("https://agentworld.me/api/agentworld/economy")

        # Pay directly to any wallet
        receipt = client.pay(to="0xAddress", amount_usdc=0.001)
        print(receipt["txHash"])

        # Check facilitator status
        print(client.health())
    """

    def __init__(self, private_key: str, facilitator: str = FACILITATOR_URL,
                 max_per_call: float = 0.01, timeout: int = 30):
        self.account     = Account.from_key(private_key)
        self.address     = self.account.address
        self.facilitator = facilitator.rstrip("/")
        self.max_per_call = max_per_call
        self.timeout     = timeout

    def fetch(self, url: str, method: str = "GET", json: dict = None) -> dict:
        """
        Fetch a URL, handling x402 payment challenges automatically.

        If the server returns 402, signs and settles payment via the
        AgentPay facilitator, then retries with proof header.

        Returns:
            Parsed JSON response dict.

        Raises:
            X402Error:         Payment or settlement failed.
            InsufficientFunds: Agent wallet has insufficient USDC.
            httpx.HTTPError:   Network / HTTP errors on non-402 responses.
        """
        with httpx.Client(timeout=self.timeout) as http:
            resp = http.request(method, url, json=json,
                                headers={"User-Agent": "x402-agentpay/1.1.0"})
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code != 402:
                resp.raise_for_status()

            # Parse 402 requirements
            try:
                body = resp.json()
            except Exception:
                raise X402Error(f"402 non-JSON body: {resp.text[:200]}")

            reqs = body.get("paymentRequirements") or body.get("payment_requirements") or body
            if isinstance(reqs, list):
                reqs = reqs[0]

            amount_raw  = int(reqs.get("maxAmountRequired",
                              reqs.get("maxAmount",
                              reqs.get("amount", 1000))))
            amount_usdc = amount_raw / 1e6
            to_address  = reqs.get("payTo", reqs.get("to", ""))
            network     = reqs.get("network", CAIP2)

            if not to_address:
                raise X402Error(f"402 response missing payTo: {reqs}")
            if amount_usdc > self.max_per_call:
                raise X402Error(
                    f"Required {amount_usdc} USDC exceeds max_per_call={self.max_per_call}"
                )

            proof = self._settle(to_address, amount_raw, network, url)

            retry = http.request(method, url, json=json, headers={
                "User-Agent":        "x402-agentpay/1.1.0",
                "X-Payment":         proof.get("txHash", ""),
                "X-Payment-Network": network,
            })
            retry.raise_for_status()
            return retry.json()

    def pay(self, to: str, amount_usdc: float, resource: str = "") -> dict:
        """
        Pay USDC directly to any wallet via the AgentPay facilitator.

        Args:
            to:           Recipient wallet address
            amount_usdc:  Amount in USDC (e.g. 0.001)
            resource:     Optional URL/label logged on the facilitator

        Returns:
            dict: success, txHash, explorer, amount, payer, payee

        Raises:
            X402Error, InsufficientFunds
        """
        return self._settle(to, int(amount_usdc * 1e6), CAIP2, resource)

    def health(self) -> dict:
        """Check facilitator health and version."""
        r = httpx.get(f"{self.facilitator}/x402/health", timeout=10)
        r.raise_for_status()
        return r.json()

    def supported_networks(self) -> list:
        """List networks supported by this facilitator."""
        r = httpx.get(f"{self.facilitator}/x402/supported-networks", timeout=10)
        r.raise_for_status()
        return r.json().get("supported_networks", [])

    # ── Internal ──────────────────────────────────────────────────────────────

    def _sign_eip3009(self, to: str, amount: int) -> dict:
        now         = int(time.time())
        nonce_bytes = bytes(uuid.uuid4().bytes) + b"\x00" * 16  # 32 bytes

        signed = self.account.sign_typed_data(
            domain_data={
                "name":              "USD Coin",
                "version":           "2",
                "chainId":           CHAIN_ID,
                "verifyingContract": Web3.to_checksum_address(USDC_BASE),
            },
            message_types={
                "TransferWithAuthorization": [
                    {"name": "from",        "type": "address"},
                    {"name": "to",          "type": "address"},
                    {"name": "value",       "type": "uint256"},
                    {"name": "validAfter",  "type": "uint256"},
                    {"name": "validBefore", "type": "uint256"},
                    {"name": "nonce",       "type": "bytes32"},
                ]
            },
            message_data={
                "from":        self.address,
                "to":          Web3.to_checksum_address(to),
                "value":       amount,
                "validAfter":  now - 60,
                "validBefore": now + 600,
                "nonce":       nonce_bytes,
            },
        )
        sig = signed.signature.hex()
        if not sig.startswith("0x"):
            sig = "0x" + sig
        return {
            "from":        self.address,
            "to":          Web3.to_checksum_address(to),
            "value":       amount,
            "validAfter":  now - 60,
            "validBefore": now + 600,
            "nonce":       "0x" + nonce_bytes.hex(),
            "signature":   sig,
        }

    def _settle(self, to_address: str, amount_raw: int, network: str, resource: str) -> dict:
        payload = self._sign_eip3009(to_address, amount_raw)
        body = {
            "paymentPayload": {
                "network": network,
                "payload": payload,
            },
            "paymentRequirements": {
                "network":   network,
                "resource":  resource,
                "maxAmount": amount_raw,
            },
        }
        try:
            resp = httpx.post(f"{self.facilitator}/x402/settle",
                              json=body, timeout=self.timeout)
        except httpx.RequestError as e:
            raise X402Error(f"Facilitator unreachable: {e}")

        try:
            result = resp.json()
        except Exception:
            raise X402Error(f"Facilitator non-JSON: {resp.text[:200]}")

        if not result.get("success"):
            err = result.get("error", str(result))
            if "insufficient" in err.lower() or "balance" in err.lower():
                raise InsufficientFunds(f"Insufficient USDC: {err}")
            raise X402Error(f"Settlement failed: {err}")

        return result
