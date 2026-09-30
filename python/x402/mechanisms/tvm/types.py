"""TVM-specific payload and parsed data types."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

try:
    from pytoniq_core import Cell
    from pytoniq_core.tlb.account import StateInit
except ImportError as e:
    raise ImportError(
        "TVM mechanism requires pytoniq packages. Install with: pip install x402[tvm]"
    ) from e


@dataclass
class ExactTvmPayload:
    """Exact payment payload for TVM networks."""

    settlement_boc: str
    asset: str

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "settlementBoc": self.settlement_boc,
            "asset": self.asset,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ExactTvmPayload:
        """Create from dictionary."""
        settlement_boc = data.get("settlementBoc")
        if not isinstance(settlement_boc, str) or not settlement_boc.strip():
            raise ValueError("Exact TVM payload field 'settlementBoc' is required")

        asset = data.get("asset")
        if not isinstance(asset, str) or not asset.strip():
            raise ValueError("Exact TVM payload field 'asset' is required")

        return cls(
            settlement_boc=settlement_boc,
            asset=asset,
        )


@dataclass
class ParsedJettonTransfer:
    """Jetton transfer extracted from a W5 action."""

    source_wallet: str
    destination: str
    response_destination: str | None
    jetton_amount: int
    attached_ton_amount: int
    forward_ton_amount: int
    forward_payload: Cell
    body_hash: bytes | None = None


@dataclass
class ParsedTvmSettlement:
    """Parsed TON settlement payload."""

    payer: str
    wallet_id: int
    valid_until: int
    seqno: int
    settlement_hash: str
    body: Cell
    signed_slice_hash: bytes
    signature: bytes
    state_init: StateInit | None
    transfer: ParsedJettonTransfer


@dataclass
class TvmAccountState:
    """Subset of account state needed by the facilitator."""

    address: str
    balance: int
    is_active: bool
    is_uninitialized: bool
    is_frozen: bool
    state_init: StateInit | None


@dataclass
class TvmJettonWalletData:
    """Data returned by TEP-74 get_wallet_data()."""

    address: str
    balance: int
    owner: str
    jetton_minter: str


@dataclass
class TvmRelayRequest:
    """One relay request forwarded by the facilitator highload wallet."""

    destination: str
    body: Cell
    state_init: StateInit | None
    forward_ton_amount: int = 0
    relay_amount: int | None = None


@dataclass
class W5InitData:
    signature_allowed: bool
    seqno: int
    wallet_id: int
    public_key: bytes
    extensions_dict: Cell | None
