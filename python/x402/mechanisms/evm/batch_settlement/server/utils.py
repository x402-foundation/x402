"""Helpers for reading batch-settlement-specific extra fields from responses."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from ..errors import ERR_REFUND_PAYLOAD

_UINT_RE = re.compile(r"^\d+$")


def read_channel_state_extra(extra: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Return the nested `channelState` dict from settle/verify response extras."""
    if not extra:
        return None
    value = extra.get("channelState")
    if isinstance(value, dict):
        return value
    return None


def read_extra_string(extra: Mapping[str, Any] | None, key: str, fallback: str) -> str:
    if not extra:
        return fallback
    value = extra.get(key)
    if isinstance(value, str):
        return value
    if isinstance(value, int):
        return str(value)
    return fallback


def read_extra_number(extra: Mapping[str, Any] | None, key: str, fallback: int) -> int:
    if not extra:
        return fallback
    value = extra.get(key)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return fallback
    return fallback


@dataclass
class RefundSettlementSnapshot:
    balance: str
    total_claimed: str
    withdraw_requested_at: int
    refund_nonce: int


def parse_refund_settlement_snapshot(
    extra: Mapping[str, Any] | None,
) -> RefundSettlementSnapshot:
    channel_state = read_channel_state_extra(extra)
    return RefundSettlementSnapshot(
        balance=_parse_uint_string(channel_state, "balance"),
        total_claimed=_parse_uint_string(channel_state, "totalClaimed"),
        withdraw_requested_at=_parse_uint_number(channel_state, "withdrawRequestedAt"),
        refund_nonce=_parse_uint_number(channel_state, "refundNonce"),
    )


def _parse_uint_string(extra: Mapping[str, Any] | None, key: str) -> str:
    if not extra:
        raise ValueError(ERR_REFUND_PAYLOAD)
    value = extra.get(key)
    if isinstance(value, str) and _UINT_RE.match(value):
        return value
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return str(value)
    raise ValueError(ERR_REFUND_PAYLOAD)


def _parse_uint_number(extra: Mapping[str, Any] | None, key: str) -> int:
    if not extra:
        raise ValueError(ERR_REFUND_PAYLOAD)
    value = extra.get(key)
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    if isinstance(value, str) and _UINT_RE.match(value):
        return int(value)
    raise ValueError(ERR_REFUND_PAYLOAD)


__all__ = [
    "RefundSettlementSnapshot",
    "parse_refund_settlement_snapshot",
    "read_channel_state_extra",
    "read_extra_number",
    "read_extra_string",
]
