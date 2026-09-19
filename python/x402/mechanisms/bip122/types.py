"""BIP-122-specific payment and invoice types."""

from dataclasses import dataclass
from typing import Any, Literal

LightningPaymentStatus = Literal["unpaid", "in_flight", "paid"]


@dataclass
class ExactBip122Payload:
    """Exact payment payload for BIP-122 networks."""

    invoice: str

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {"invoice": self.invoice}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExactBip122Payload":
        """Create from dictionary data."""
        return cls(invoice=data.get("invoice", ""))


ExactBip122PayloadV2 = ExactBip122Payload


@dataclass
class LightningInvoiceStatus:
    """Normalized invoice state returned by payer/receiver adapters."""

    invoice: str
    payment_hash: str
    amount_msat: int
    status: LightningPaymentStatus
    payer: str | None = None
    settled_at: int | None = None
