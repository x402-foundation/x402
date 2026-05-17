"""
AgentPay data models — clean Python objects for every API response.
"""
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any
from datetime import datetime


@dataclass
class Capability:
    capability_id: str
    agent_id: str
    name: str
    category: str
    description: str = ""
    price_per_call: float = 0.01
    price_currency: str = "USDC"
    scope_required: str = "execute"
    tags: List[str] = field(default_factory=list)
    sla_response_ms: int = 5000
    sla_uptime: float = 99.0
    success_rate: float = 100.0
    total_calls: int = 0
    verified: bool = False
    active: bool = True

    @classmethod
    def from_dict(cls, d: dict) -> "Capability":
        return cls(
            capability_id=d.get("capability_id", ""),
            agent_id=d.get("agent_id", ""),
            name=d.get("name", ""),
            category=d.get("category", ""),
            description=d.get("description", ""),
            price_per_call=float(d.get("price_per_call", 0.01)),
            price_currency=d.get("price_currency", "USDC"),
            scope_required=d.get("scope_required", "execute"),
            tags=d.get("tags", []),
            sla_response_ms=int(d.get("sla_response_ms", 5000)),
            sla_uptime=float(d.get("sla_uptime", 99.0)),
            success_rate=float(d.get("success_rate", 100.0)),
            total_calls=int(d.get("total_calls", 0)),
            verified=bool(d.get("verified", False)),
            active=bool(d.get("active", True)),
        )

    def __str__(self):
        return f"[{self.category}] {self.name} — ${self.price_per_call:.4f} USDC | ✓{self.success_rate}% | scope:{self.scope_required}"


@dataclass
class LedgerEntry:
    ledger_id: str
    payer_agent_id: str
    payee_agent_id: str
    capability: str
    amount: float
    currency: str = "USDC"
    scope: str = "execute"
    status: str = "pending"
    outcome: Optional[str] = None
    receipt_hash: Optional[str] = None
    tx_hash: Optional[str] = None
    grant_id: Optional[str] = None
    created_at: Optional[str] = None
    settled_at: Optional[str] = None

    @classmethod
    def from_dict(cls, d: dict) -> "LedgerEntry":
        return cls(
            ledger_id=d.get("ledger_id", ""),
            payer_agent_id=d.get("payer_agent_id", ""),
            payee_agent_id=d.get("payee_agent_id", ""),
            capability=d.get("capability", ""),
            amount=float(d.get("amount", 0)),
            currency=d.get("currency", "USDC"),
            scope=d.get("scope", "execute"),
            status=d.get("status", "pending"),
            outcome=d.get("outcome"),
            receipt_hash=d.get("receipt_hash"),
            tx_hash=d.get("tx_hash"),
            grant_id=d.get("grant_id"),
            created_at=d.get("created_at"),
            settled_at=d.get("settled_at"),
        )

    @property
    def basescan_url(self) -> Optional[str]:
        if self.tx_hash and self.tx_hash.startswith("0x"):
            return f"https://basescan.org/tx/{self.tx_hash}"
        return None

    def __str__(self):
        return (
            f"LedgerEntry {self.ledger_id[:12]}... | "
            f"{self.payer_agent_id} → {self.payee_agent_id} | "
            f"${self.amount:.4f} {self.currency} | {self.status}"
        )


@dataclass
class ReputationScore:
    agent_id: str
    reputation_score: float = 50.0
    tier: str = "Bronze"
    total_completed: int = 0
    total_failed: int = 0
    total_volume_usdc: float = 0.0
    success_rate: float = 0.0
    consecutive_successes: int = 0
    unique_payers: int = 0
    last_active: Optional[str] = None

    @classmethod
    def from_dict(cls, d: dict) -> "ReputationScore":
        return cls(
            agent_id=d.get("agent_id", ""),
            reputation_score=float(d.get("reputation_score", 50.0)),
            tier=d.get("tier", "Bronze"),
            total_completed=int(d.get("total_completed", 0)),
            total_failed=int(d.get("total_failed", 0)),
            total_volume_usdc=float(d.get("total_volume_usdc", 0.0)),
            success_rate=float(d.get("success_rate", 0.0)),
            consecutive_successes=int(d.get("consecutive_successes", 0)),
            unique_payers=int(d.get("unique_payers", 0)),
            last_active=d.get("last_active"),
        )

    def __str__(self):
        return (
            f"{self.agent_id} | {self.tier} ({self.reputation_score:.1f}/100) | "
            f"✓{self.success_rate}% | ${self.total_volume_usdc:.4f} vol"
        )


@dataclass
class PermissionGrant:
    grant_id: str
    grantor_agent_id: str
    grantee_agent_id: str
    scope: str
    capability_pattern: str = "*"
    max_amount_per_call: Optional[float] = None
    max_amount_total: Optional[float] = None
    amount_used: float = 0.0
    valid_until: Optional[str] = None
    revoked: bool = False

    @classmethod
    def from_dict(cls, d: dict) -> "PermissionGrant":
        return cls(
            grant_id=d.get("grant_id", ""),
            grantor_agent_id=d.get("grantor_agent_id", ""),
            grantee_agent_id=d.get("grantee_agent_id", ""),
            scope=d.get("scope", "execute"),
            capability_pattern=d.get("capability_pattern", "*"),
            max_amount_per_call=d.get("max_amount_per_call"),
            max_amount_total=d.get("max_amount_total"),
            amount_used=float(d.get("amount_used", 0.0)),
            valid_until=d.get("valid_until"),
            revoked=bool(d.get("revoked", False)),
        )

    @property
    def remaining_budget(self) -> Optional[float]:
        if self.max_amount_total is not None:
            return round(self.max_amount_total - self.amount_used, 4)
        return None

    def __str__(self):
        budget = f" | budget: ${self.remaining_budget:.4f} remaining" if self.remaining_budget is not None else ""
        return (
            f"Grant {self.grant_id[:12]}... | "
            f"{self.grantor_agent_id} → {self.grantee_agent_id} | "
            f"scope:{self.scope} | cap:{self.capability_pattern}{budget}"
        )
