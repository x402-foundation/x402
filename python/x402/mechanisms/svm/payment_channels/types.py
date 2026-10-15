"""Payment-channel account and voucher values."""

from dataclasses import dataclass
from enum import IntEnum
from typing import Protocol

from solders.signature import Signature


class MessageSigner(Protocol):
    @property
    def address(self) -> str: ...

    def sign_message(self, message: bytes) -> Signature | bytes | str: ...


class ChannelStatus(IntEnum):
    OPEN = 0
    SEALED = 1
    CLOSING = 2
    DISTRIBUTED = 3


@dataclass(frozen=True)
class ChannelSplit:
    recipient: str
    bps: int


@dataclass(frozen=True)
class SettleVoucher:
    authorized_signer: str
    signature_base58: str
    cumulative_amount: int
    expires_at: int = 0


@dataclass(frozen=True)
class Channel:
    payer: str
    payee: str
    authorized_signer: str
    mint: str
    rent_payer: str
    salt: int
    open_slot: int
    deposit: int
    settled: int
    payout_watermark: int
    grace_period: int
    distribution_hash: bytes
    status: ChannelStatus = ChannelStatus.OPEN
    closure_started_at: int = 0
    payer_withdrawn_at: int = 0
    version: int = 1
    bump: int = 0

    @property
    def distributed(self) -> int:
        return self.payout_watermark
