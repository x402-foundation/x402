"""Wire objects and server accounting for SVM batch settlement."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from typing_extensions import NotRequired, TypedDict


class BatchChannelConfig(TypedDict):
    payer: str
    payerAuthorizer: str
    receiver: str
    receiverAuthorizer: str
    token: str
    withdrawDelay: int
    salt: str
    openSlot: int
    voucherSigner: NotRequired[Literal["client", "server"]]


class BatchVoucher(TypedDict):
    channelId: str
    maxClaimableAmount: str
    expiresAt: int
    signature: str


class BatchAuthorization(TypedDict):
    type: Literal["proof"]
    channelId: str
    payer: str
    requestId: str
    authorizedAmount: str
    expiresAt: int
    signature: str


class CloseAuthorization(TypedDict):
    validBefore: int
    signature: str


@dataclass
class ChannelReservation:
    ceiling: int
    expires_at: float
    kind: Literal["client", "server", "deposit", "close"]
    request_id: str | None = None


@dataclass
class ChannelState:
    channel_id: str
    network: str
    channel_config: dict[str, Any]
    fee_payer: str
    token_program: str
    deposit: int = 0
    charged_cumulative_amount: int = 0
    signed_max_claimable: int = 0
    settled: int = 0
    payout_watermark: int = 0
    status: Literal["open", "closing", "distributed"] = "open"
    close_requested_at: int = 0
    onchain_synced_at: float = 0
    highest_voucher: dict[str, Any] | None = None
    open_signature: str | None = None
    close_signature: str | None = None
    reservations: dict[str, ChannelReservation] = field(default_factory=dict)

    def snapshot(self) -> dict[str, Any]:
        return {
            "channelId": self.channel_id,
            "balance": str(self.deposit),
            "totalClaimed": str(self.settled),
            "withdrawRequestedAt": self.close_requested_at,
            "chargedCumulativeAmount": str(self.charged_cumulative_amount),
        }


@dataclass
class BatchOperation:
    channel_id: str
    request_id: str
    ceiling: int
    status: Literal["reserved", "completed"] = "reserved"
    actual: int | None = None
    cumulative: int | None = None
