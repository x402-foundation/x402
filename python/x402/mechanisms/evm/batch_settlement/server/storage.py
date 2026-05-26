"""Server-side channel storage protocol and in-memory implementation."""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from ..types import ChannelConfig


@dataclass
class PendingRequest:
    """Per-channel reservation while a request is in flight."""

    pending_id: str
    signed_max_claimable: str
    expires_at: int  # milliseconds since epoch

    def to_dict(self) -> dict[str, Any]:
        return {
            "pendingId": self.pending_id,
            "signedMaxClaimable": self.signed_max_claimable,
            "expiresAt": self.expires_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PendingRequest:
        return cls(
            pending_id=data["pendingId"],
            signed_max_claimable=str(data["signedMaxClaimable"]),
            expires_at=int(data["expiresAt"]),
        )


@dataclass
class Channel:
    """Server-side channel record."""

    channel_id: str
    channel_config: ChannelConfig
    charged_cumulative_amount: str = "0"
    signed_max_claimable: str = "0"
    signature: str = "0x"
    balance: str = "0"
    total_claimed: str = "0"
    withdraw_requested_at: int = 0
    refund_nonce: int = 0
    onchain_synced_at: int | None = None
    last_request_timestamp: int = 0
    pending_request: PendingRequest | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "channelId": self.channel_id,
            "channelConfig": self.channel_config.to_dict(),
            "chargedCumulativeAmount": self.charged_cumulative_amount,
            "signedMaxClaimable": self.signed_max_claimable,
            "signature": self.signature,
            "balance": self.balance,
            "totalClaimed": self.total_claimed,
            "withdrawRequestedAt": self.withdraw_requested_at,
            "refundNonce": self.refund_nonce,
            "lastRequestTimestamp": self.last_request_timestamp,
        }
        if self.onchain_synced_at is not None:
            out["onchainSyncedAt"] = self.onchain_synced_at
        if self.pending_request is not None:
            out["pendingRequest"] = self.pending_request.to_dict()
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Channel:
        pr = data.get("pendingRequest")
        return cls(
            channel_id=data["channelId"],
            channel_config=ChannelConfig.from_dict(data["channelConfig"]),
            charged_cumulative_amount=str(data.get("chargedCumulativeAmount", "0")),
            signed_max_claimable=str(data.get("signedMaxClaimable", "0")),
            signature=data.get("signature", "0x"),
            balance=str(data.get("balance", "0")),
            total_claimed=str(data.get("totalClaimed", "0")),
            withdraw_requested_at=int(data.get("withdrawRequestedAt", 0)),
            refund_nonce=int(data.get("refundNonce", 0)),
            onchain_synced_at=int(data["onchainSyncedAt"])
            if data.get("onchainSyncedAt") is not None
            else None,
            last_request_timestamp=int(data.get("lastRequestTimestamp", 0)),
            pending_request=PendingRequest.from_dict(pr) if pr else None,
        )

    def copy(self) -> Channel:
        return Channel(
            channel_id=self.channel_id,
            channel_config=self.channel_config,
            charged_cumulative_amount=self.charged_cumulative_amount,
            signed_max_claimable=self.signed_max_claimable,
            signature=self.signature,
            balance=self.balance,
            total_claimed=self.total_claimed,
            withdraw_requested_at=self.withdraw_requested_at,
            refund_nonce=self.refund_nonce,
            onchain_synced_at=self.onchain_synced_at,
            last_request_timestamp=self.last_request_timestamp,
            pending_request=self.pending_request,
        )


@dataclass
class ChannelUpdateResult:
    channel: Channel | None
    status: Literal["updated", "unchanged", "deleted"]


# A mutation callback receives the current channel (or None) and returns the
# next channel. Returning the same object signals "unchanged"; returning None
# signals delete.
ChannelUpdate = Callable[[Channel | None], Channel | None]


class ChannelStorage(Protocol):
    def get(self, channel_id: str) -> Channel | None: ...

    def list(self) -> list[Channel]: ...

    def update_channel(self, channel_id: str, update: ChannelUpdate) -> ChannelUpdateResult: ...


class InMemoryChannelStorage:
    """Thread-safe in-memory channel storage."""

    def __init__(self) -> None:
        self._channels: dict[str, Channel] = {}
        self._global_lock = threading.Lock()
        self._channel_locks: dict[str, threading.Lock] = {}

    def get(self, channel_id: str) -> Channel | None:
        key = channel_id.lower()
        with self._global_lock:
            ch = self._channels.get(key)
            return ch.copy() if ch else None

    def list(self) -> list[Channel]:
        with self._global_lock:
            return [c.copy() for c in self._channels.values()]

    def update_channel(self, channel_id: str, update: ChannelUpdate) -> ChannelUpdateResult:
        key = channel_id.lower()
        with self._global_lock:
            lock = self._channel_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._channel_locks[key] = lock

        with lock:
            with self._global_lock:
                current = self._channels.get(key)
                current_snapshot = current.copy() if current else None

            next_ch = update(current_snapshot)

            with self._global_lock:
                if next_ch is current_snapshot:
                    return ChannelUpdateResult(
                        channel=self._channels.get(key, current),
                        status="unchanged",
                    )
                if next_ch is None:
                    had_value = key in self._channels
                    if had_value:
                        del self._channels[key]
                    return ChannelUpdateResult(
                        channel=None,
                        status="deleted" if had_value else "unchanged",
                    )
                self._channels[key] = next_ch
                return ChannelUpdateResult(channel=next_ch.copy(), status="updated")


__all__ = [
    "Channel",
    "ChannelStorage",
    "ChannelUpdate",
    "ChannelUpdateResult",
    "InMemoryChannelStorage",
    "PendingRequest",
]
