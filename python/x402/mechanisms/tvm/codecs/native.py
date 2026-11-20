"""Native TON transfer encoding and decoding."""

from __future__ import annotations

from collections.abc import Mapping

from ..constants import ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER
from ..types import ParsedNativeTransfer
from .common import decode_base64_boc, normalize_address

try:
    from pytoniq_core import Cell
    from pytoniq_core.tlb.transaction import MessageAny
except ImportError as e:
    raise ImportError(
        "TVM mechanism requires pytoniq packages. Install with: pip install x402[tvm]"
    ) from e

# Extra fields that only make sense for Jetton transfers.
JETTON_ONLY_EXTRA_FIELDS = ("forwardTonAmount", "responseDestination")


def native_transfer_body(extra: Mapping[str, object]) -> Cell:
    """Return the effective body of a native TON transfer.

    The body is ``extra.forwardPayload`` when present, otherwise an empty cell.
    """
    encoded_payload = extra.get("forwardPayload")
    if encoded_payload is None:
        return Cell.empty()
    return decode_base64_boc(encoded_payload)


def has_jetton_only_extra(extra: Mapping[str, object]) -> bool:
    """Return True when ``extra`` carries fields that native TON payments must not have."""
    return any(field in extra for field in JETTON_ONLY_EXTRA_FIELDS)


def parse_native_transfer(out_msg: MessageAny) -> ParsedNativeTransfer:
    """Parse the outbound message of a native TON payment."""
    if not out_msg.is_internal or out_msg.info.dest is None:
        raise ValueError(ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER)

    extra_currencies = out_msg.info.value.other
    has_extra_currencies = bool(getattr(extra_currencies, "dict", None))
    body = out_msg.body if out_msg.body is not None else Cell.empty()

    return ParsedNativeTransfer(
        destination=normalize_address(out_msg.info.dest),
        amount=out_msg.info.value_coins,
        body=body,
        bounce=bool(out_msg.info.bounce),
        has_extra_currencies=has_extra_currencies,
        has_state_init=out_msg.init is not None,
        body_hash=body.hash,
    )
