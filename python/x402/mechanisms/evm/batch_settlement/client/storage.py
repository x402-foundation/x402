"""Client-side channel storage protocol and in-memory default."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class BatchSettlementClientContext:
    """Client-side channel state for an open payment channel."""

    charged_cumulative_amount: str | None = None
    balance: str | None = None
    total_claimed: str | None = None
    signed_max_claimable: str | None = None
    signature: str | None = None

    # Free-form passthrough kept for forward-compat with future fields.
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = dict(self.extra)
        if self.charged_cumulative_amount is not None:
            out["chargedCumulativeAmount"] = self.charged_cumulative_amount
        if self.balance is not None:
            out["balance"] = self.balance
        if self.total_claimed is not None:
            out["totalClaimed"] = self.total_claimed
        if self.signed_max_claimable is not None:
            out["signedMaxClaimable"] = self.signed_max_claimable
        if self.signature is not None:
            out["signature"] = self.signature
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BatchSettlementClientContext:
        known = {
            "chargedCumulativeAmount",
            "balance",
            "totalClaimed",
            "signedMaxClaimable",
            "signature",
        }
        return cls(
            charged_cumulative_amount=(
                str(data["chargedCumulativeAmount"])
                if data.get("chargedCumulativeAmount") is not None
                else None
            ),
            balance=str(data["balance"]) if data.get("balance") is not None else None,
            total_claimed=(
                str(data["totalClaimed"]) if data.get("totalClaimed") is not None else None
            ),
            signed_max_claimable=(
                str(data["signedMaxClaimable"])
                if data.get("signedMaxClaimable") is not None
                else None
            ),
            signature=data.get("signature"),
            extra={k: v for k, v in data.items() if k not in known},
        )

    def copy(self) -> BatchSettlementClientContext:
        return BatchSettlementClientContext(
            charged_cumulative_amount=self.charged_cumulative_amount,
            balance=self.balance,
            total_claimed=self.total_claimed,
            signed_max_claimable=self.signed_max_claimable,
            signature=self.signature,
            extra=dict(self.extra),
        )


class ClientChannelStorage(Protocol):
    """Sync client-side persistence for batch-settlement channels."""

    def get(self, key: str) -> BatchSettlementClientContext | None: ...
    def set(self, key: str, context: BatchSettlementClientContext) -> None: ...
    def delete(self, key: str) -> None: ...


class InMemoryClientChannelStorage:
    """Default in-process implementation of `ClientChannelStorage`."""

    def __init__(self) -> None:
        self._channels: dict[str, BatchSettlementClientContext] = {}

    def get(self, key: str) -> BatchSettlementClientContext | None:
        existing = self._channels.get(key)
        return existing.copy() if existing is not None else None

    def set(self, key: str, context: BatchSettlementClientContext) -> None:
        self._channels[key] = context.copy()

    def delete(self, key: str) -> None:
        self._channels.pop(key, None)


__all__ = [
    "BatchSettlementClientContext",
    "ClientChannelStorage",
    "InMemoryClientChannelStorage",
]
