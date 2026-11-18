"""Highload V3 state and message codecs."""

from __future__ import annotations

import time
from dataclasses import dataclass

from ..types import TvmAccountState

try:
    from pytoniq_core import Cell, begin_cell
except ImportError as e:
    raise ImportError(
        "TVM mechanism requires pytoniq packages. Install with: pip install x402[tvm]"
    ) from e


MAX_SHIFT = 8191
MAX_BIT_NUMBER = 1022
MAX_USABLE_QUERY_SEQNO = MAX_SHIFT * 1023 + (MAX_BIT_NUMBER - 1)


@dataclass
class HighloadQueryState:
    old_queries: dict[int, Cell]
    queries: dict[int, Cell]


def seqno_to_query_id(seqno: int) -> int:
    """Convert a monotonic seqno into a Highload V3 query id."""
    if seqno < 0 or seqno > MAX_USABLE_QUERY_SEQNO:
        raise ValueError("Highload V3 seqno is out of range")
    shift = seqno // 1023
    bit_number = seqno % 1023
    return (shift << 10) + bit_number


def serialize_internal_transfer(actions: Cell, query_id: int) -> Cell:
    """Serialize Highload V3 internal_transfer body that installs OutActions."""
    return (
        begin_cell()
        .store_uint(0xAE42E5A4, 32)
        .store_uint(query_id, 64)
        .store_ref(actions)
        .end_cell()
    )


def load_highload_query_state(
    account_state: TvmAccountState,
    *,
    expected_code_hash: str,
    now: int | None = None,
) -> HighloadQueryState | None:
    """Decode current Highload V3 query bitmaps from account state."""
    if not account_state.is_active:
        return None

    state_init = account_state.state_init
    if state_init is None or state_init.code is None or state_init.data is None:
        raise RuntimeError("Active Highload V3 wallet state is missing code or data")
    if state_init.code.hash.hex() != expected_code_hash:
        raise RuntimeError("Unexpected code hash for Highload V3 facilitator wallet")

    data = state_init.data.begin_parse()
    data.load_bytes(32)
    data.load_uint(32)
    old_queries = data.load_dict(13, value_deserializer=lambda item: item.load_ref()) or {}
    queries = data.load_dict(13, value_deserializer=lambda item: item.load_ref()) or {}
    last_clean_time = data.load_uint(64)
    timeout = data.load_uint(22)

    if now is None:
        now = int(time.time())

    if last_clean_time < now - timeout:
        old_queries, queries = queries, {}
    if last_clean_time < now - (timeout * 2):
        old_queries = {}

    return HighloadQueryState(old_queries=dict(old_queries), queries=dict(queries))


def query_id_is_processed(query_state: HighloadQueryState, query_id: int) -> bool:
    """Check whether a Highload V3 query id was already processed."""
    shift = query_id >> 10
    bit_number = query_id & 1023
    return _bitmap_contains(query_state.old_queries.get(shift), bit_number) or _bitmap_contains(
        query_state.queries.get(shift), bit_number
    )


def _bitmap_contains(bitmap: Cell | None, bit_number: int) -> bool:
    if bitmap is None or bit_number >= len(bitmap.bits):
        return False
    return bitmap.begin_parse().skip_bits(bit_number).preload_bit() != 0
