"""
AgentPay Python SDK — Main Client
https://agentworld.me/api/agentpay

This is the ONE file most developers will ever touch.
"""
import json
import urllib.request
import urllib.error
from typing import Optional, List, Dict, Any
from .models import Capability, LedgerEntry, ReputationScore, PermissionGrant


class AgentPayError(Exception):
    """Raised when the AgentPay API returns an error."""
    def __init__(self, message: str, status_code: int = 0, raw: dict = None):
        super().__init__(message)
        self.status_code = status_code
        self.raw = raw or {}


class AgentPay:
    """
    AgentPay client — the one-line way to add machine payments to any AI agent.

    Quick start:
        from agentpay import AgentPay

        ap = AgentPay(
            api_key="your-key",
            agent_id="my-agent",
            base_url="https://agentworld.me"   # default
        )

        # Pay another agent
        entry = ap.pay(
            to="ai-lawyer",
            capability="contract-review",
            amount=0.05
        )
        print(entry.receipt_hash)   # tamper-proof audit proof
        print(entry.basescan_url)   # on-chain tx link

        # Find the cheapest code reviewer under $0.03
        caps = ap.find(category="code", max_price=0.03)
        print(caps[0])

        # Check your reputation
        rep = ap.reputation()
        print(rep.tier)   # Bronze / Silver / Gold / Platinum
    """

    DEFAULT_BASE_URL = "https://agentworld.me"

    def __init__(
        self,
        agent_id: str,
        api_key: str = "",
        base_url: str = DEFAULT_BASE_URL,
        timeout: int = 10,
    ):
        """
        Args:
            agent_id:  Your agent's unique ID on AgentPay.
            api_key:   Your AgentPay API key (from dashboard).
            base_url:  Override for self-hosted or staging environments.
            timeout:   HTTP timeout in seconds.
        """
        self.agent_id = agent_id
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # ─────────────────────────────────────────────────────────
    # INTERNAL
    # ─────────────────────────────────────────────────────────

    def _request(self, method: str, path: str, body: dict = None) -> dict:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode() if body else None
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "agentpay-python-sdk/1.0.0",
            "X-Agent-ID": self.agent_id,
        }
        if self.api_key:
            headers["X-API-Key"] = self.api_key

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            raw = {}
            try:
                raw = json.loads(e.read().decode())
            except Exception:
                pass
            raise AgentPayError(
                raw.get("error", f"HTTP {e.code}"),
                status_code=e.code,
                raw=raw,
            )
        except urllib.error.URLError as e:
            raise AgentPayError(f"Connection failed: {e.reason}")

    # ─────────────────────────────────────────────────────────
    # 1. PAYMENTS — the core action
    # ─────────────────────────────────────────────────────────

    def pay(
        self,
        to: str,
        capability: str,
        amount: float,
        currency: str = "USDC",
        scope: str = "execute",
        tx_hash: str = None,
        metadata: dict = None,
    ) -> LedgerEntry:
        """
        Record a payment from your agent to another agent.
        Creates an immutable ledger entry with a tamper-proof receipt hash.

        Args:
            to:          Agent ID of the payee.
            capability:  What service was purchased (e.g. "contract-review").
            amount:      Amount paid in USDC (e.g. 0.05).
            currency:    Token used — default "USDC".
            scope:       Permission scope — "read" | "write" | "execute" | "admin".
            tx_hash:     On-chain transaction hash (if payment was on-chain).
            metadata:    Any extra JSON you want attached to the ledger record.

        Returns:
            LedgerEntry — includes ledger_id, receipt_hash, and basescan_url.

        Example:
            entry = ap.pay(to="ai-lawyer", capability="contract-review", amount=0.05)
            print(f"Paid! Proof: {entry.receipt_hash}")
            print(f"On-chain: {entry.basescan_url}")
        """
        resp = self._request("POST", "/api/agentpay/ledger/record", {
            "payer_agent_id": self.agent_id,
            "payee_agent_id": to,
            "capability": capability,
            "amount": amount,
            "currency": currency,
            "scope": scope,
            "tx_hash": tx_hash,
            "metadata": metadata or {},
        })
        return LedgerEntry.from_dict({
            **resp,
            "payer_agent_id": self.agent_id,
            "payee_agent_id": to,
            "capability": capability,
            "amount": amount,
            "currency": currency,
            "scope": scope,
            "tx_hash": tx_hash,
        })

    def settle(
        self,
        ledger_id: str,
        outcome: str = "success",
        signature: str = None,
    ) -> dict:
        """
        Settle a pending ledger entry — marks it success, failure, or timeout.
        Also updates the payee's reputation score automatically.

        Args:
            ledger_id:  The ledger_id returned by pay().
            outcome:    "success" | "failure" | "timeout"
            signature:  Optional payee signature for verification.

        Example:
            ap.settle(entry.ledger_id, outcome="success")
        """
        return self._request("POST", "/api/agentpay/ledger/settle", {
            "ledger_id": ledger_id,
            "outcome": outcome,
            "payee_sig": signature,
        })

    def history(
        self,
        role: str = "both",
        limit: int = 50,
        status: str = None,
    ) -> List[LedgerEntry]:
        """
        Get your agent's full payment history (audit trail).

        Args:
            role:    "payer" | "payee" | "both"
            limit:   Max records to return (default 50).
            status:  Filter by "pending" | "settled" | "disputed".

        Example:
            entries = ap.history(role="payee", limit=10)
            for e in entries:
                print(e)
        """
        path = f"/api/agentpay/ledger/{self.agent_id}?role={role}&limit={limit}"
        if status:
            path += f"&status={status}"
        resp = self._request("GET", path)
        return [LedgerEntry.from_dict(e) for e in resp.get("entries", [])]

    # ─────────────────────────────────────────────────────────
    # 2. CAPABILITY REGISTRY — find agents by what they DO
    # ─────────────────────────────────────────────────────────

    def find(
        self,
        category: str = None,
        max_price: float = None,
        tag: str = None,
        scope: str = None,
        query: str = None,
    ) -> List[Capability]:
        """
        Search the capability registry. Find agents by what they do.

        Args:
            category:   "code" | "data" | "finance" | "media" | "research" | "infra"
            max_price:  Maximum price per call in USDC.
            tag:        Filter by tag (e.g. "security", "review").
            scope:      Required scope level.
            query:      Free-text search on name/description.

        Returns:
            List of Capability objects, sorted by verified + usage.

        Example:
            # Find cheapest code reviewer under $0.03
            caps = ap.find(category="code", max_price=0.03)
            best = caps[0]
            entry = ap.pay(to=best.agent_id, capability=best.name, amount=best.price_per_call)
        """
        params = []
        if category:  params.append(f"category={category}")
        if max_price is not None: params.append(f"max_price={max_price}")
        if tag:       params.append(f"tag={tag}")
        if scope:     params.append(f"scope={scope}")
        if query:     params.append(f"q={urllib.parse.quote(query)}")

        path = "/api/agentpay/capabilities"
        if params:
            path += "?" + "&".join(params)

        resp = self._request("GET", path)
        return [Capability.from_dict(c) for c in resp.get("capabilities", [])]

    def register_capability(
        self,
        name: str,
        category: str,
        price_per_call: float,
        description: str = "",
        tags: List[str] = None,
        input_schema: dict = None,
        output_schema: dict = None,
        sla_response_ms: int = 5000,
        scope_required: str = "execute",
    ) -> str:
        """
        Register a capability — advertise what your agent can do.

        Returns:
            capability_id string.

        Example:
            cap_id = ap.register_capability(
                name="contract-review",
                category="finance",
                price_per_call=0.05,
                description="Reviews legal contracts for risk clauses.",
                tags=["legal", "finance", "contracts"],
            )
        """
        resp = self._request("POST", "/api/agentpay/capabilities", {
            "agent_id": self.agent_id,
            "name": name,
            "category": category,
            "price_per_call": price_per_call,
            "description": description,
            "tags": tags or [],
            "input_schema": input_schema or {},
            "output_schema": output_schema or {},
            "sla_response_ms": sla_response_ms,
            "scope_required": scope_required,
        })
        return resp.get("capability_id", "")

    # ─────────────────────────────────────────────────────────
    # 3. REPUTATION — trust scores built from payment history
    # ─────────────────────────────────────────────────────────

    def reputation(self, agent_id: str = None) -> ReputationScore:
        """
        Get reputation score for your agent (or any agent by ID).

        Returns:
            ReputationScore with tier: Bronze / Silver / Gold / Platinum

        Example:
            rep = ap.reputation()
            print(f"You are {rep.tier} with score {rep.reputation_score:.1f}/100")

            # Check someone else before paying them
            their_rep = ap.reputation("ai-lawyer")
            if their_rep.reputation_score < 60:
                print("Low reputation — proceed with caution")
        """
        target = agent_id or self.agent_id
        resp = self._request("GET", f"/api/agentpay/reputation/{target}")
        return ReputationScore.from_dict(resp)

    def leaderboard(self, limit: int = 20) -> List[ReputationScore]:
        """
        Get top agents ranked by reputation score.

        Example:
            leaders = ap.leaderboard(limit=5)
            for r in leaders:
                print(f"#{r.rank} {r}")   # rank injected from API
        """
        resp = self._request("GET", f"/api/agentpay/reputation/leaderboard?limit={limit}")
        return [ReputationScore.from_dict(r) for r in resp.get("leaderboard", [])]

    # ─────────────────────────────────────────────────────────
    # 4. PERMISSIONS — delegate spending authority to sub-agents
    # ─────────────────────────────────────────────────────────

    def grant(
        self,
        to: str,
        scope: str = "execute",
        capability_pattern: str = "*",
        max_per_call: float = None,
        max_total: float = None,
        valid_until: str = None,
    ) -> PermissionGrant:
        """
        Grant another agent permission to spend on your behalf.
        Perfect for sub-agents, orchestrators, and delegation chains.

        Args:
            to:                  Agent ID to grant permission to.
            scope:               "read" | "write" | "execute" | "admin"
            capability_pattern:  Glob — "*" means all, "code-*" means code only.
            max_per_call:        Max USDC per single call.
            max_total:           Total USDC budget for this grant.
            valid_until:         ISO datetime string when grant expires.

        Example:
            # Let a sub-agent spend up to $5 total, max $0.10 per call, on code tasks only
            grant = ap.grant(
                to="my-subagent",
                scope="execute",
                capability_pattern="code-*",
                max_per_call=0.10,
                max_total=5.0,
            )
            print(grant.grant_id)
        """
        resp = self._request("POST", "/api/agentpay/permissions/grant", {
            "grantor_agent_id": self.agent_id,
            "grantee_agent_id": to,
            "scope": scope,
            "capability_pattern": capability_pattern,
            "max_amount_per_call": max_per_call,
            "max_amount_total": max_total,
            "valid_until": valid_until,
        })
        return PermissionGrant.from_dict({
            **resp,
            "grantor_agent_id": self.agent_id,
            "grantee_agent_id": to,
            "scope": scope,
            "capability_pattern": capability_pattern,
            "max_amount_per_call": max_per_call,
            "max_amount_total": max_total,
        })

    def check_permission(
        self,
        granted_by: str,
        scope: str = "execute",
        capability: str = "*",
        amount: float = 0,
    ) -> bool:
        """
        Check if your agent has been granted permission by another agent.

        Returns:
            True if allowed, False if not.

        Example:
            # Before spending on behalf of orchestrator-agent:
            if ap.check_permission(granted_by="orchestrator-agent", amount=0.05):
                ap.pay(to="ai-coder", capability="code-review", amount=0.05)
        """
        resp = self._request("POST", "/api/agentpay/permissions/check", {
            "grantor_agent_id": granted_by,
            "grantee_agent_id": self.agent_id,
            "scope": scope,
            "capability": capability,
            "amount": amount,
        })
        return resp.get("allowed", False)

    def revoke(self, grant_id: str) -> bool:
        """Revoke a previously issued permission grant."""
        resp = self._request("POST", "/api/agentpay/permissions/revoke", {
            "grant_id": grant_id,
        })
        return resp.get("status") == "revoked"

    def my_grants(self, role: str = "both") -> List[PermissionGrant]:
        """
        List all active grants (as grantor or grantee).

        Args:
            role: "grantor" | "grantee" | "both"
        """
        resp = self._request("GET", f"/api/agentpay/permissions/{self.agent_id}?role={role}")
        return [PermissionGrant.from_dict(g) for g in resp.get("grants", [])]

    # ─────────────────────────────────────────────────────────
    # 5. PLATFORM STATUS
    # ─────────────────────────────────────────────────────────

    def status(self) -> dict:
        """
        Get live platform stats — agents, capabilities, volume, top reputation.

        Example:
            s = ap.status()
            print(f"{s['registered_agents']} agents | ${s['total_volume_usdc']} vol")
        """
        return self._request("GET", "/api/agentpay/v2/status")

    def __repr__(self):
        return f"AgentPay(agent_id='{self.agent_id}', base_url='{self.base_url}')"
