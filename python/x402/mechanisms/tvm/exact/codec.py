"""Exact TVM settlement payload codec."""

from __future__ import annotations

import base64

from ..codecs.common import normalize_address
from ..codecs.jetton import parse_jetton_transfer
from ..codecs.w5 import parse_out_list
from ..constants import (
    ERR_EXACT_TVM_INVALID_SETTLEMENT_BOC,
    ERR_EXACT_TVM_INVALID_W5_ACTIONS,
    ERR_EXACT_TVM_INVALID_W5_MESSAGE,
    SEND_MODE_IGNORE_ERRORS,
    SEND_MODE_PAY_FEES_SEPARATELY,
    W5_INTERNAL_SIGNED_OPCODE,
)
from ..types import ParsedTvmSettlement

try:
    from pytoniq_core import Cell
    from pytoniq_core.tlb.transaction import MessageAny
except ImportError as e:
    raise ImportError(
        "TVM mechanism requires pytoniq packages. Install with: pip install x402[tvm]"
    ) from e


def parse_exact_tvm_payload(settlement_boc: str) -> ParsedTvmSettlement:
    """Parse an exact TVM settlement payload into structured fields."""
    try:
        root = Cell.one_from_boc(base64.b64decode(settlement_boc))
        message = MessageAny.deserialize(root.begin_parse())
    except Exception as exc:
        raise ValueError(ERR_EXACT_TVM_INVALID_SETTLEMENT_BOC) from exc

    if not message.is_internal or message.info.dest is None:
        raise ValueError(ERR_EXACT_TVM_INVALID_SETTLEMENT_BOC)

    payer = normalize_address(message.info.dest)
    state_init = message.init
    body = message.body

    body_slice = body.begin_parse()
    opcode = body_slice.load_uint(32)
    if opcode != W5_INTERNAL_SIGNED_OPCODE:
        raise ValueError(ERR_EXACT_TVM_INVALID_W5_MESSAGE)

    wallet_id = body_slice.load_uint(32)
    valid_until = body_slice.load_uint(32)
    seqno = body_slice.load_uint(32)

    has_actions = body_slice.load_bit()
    actions = parse_out_list(body_slice.load_ref()) if has_actions else []
    has_extra_actions = body_slice.load_bit()
    if has_extra_actions:
        raise ValueError(ERR_EXACT_TVM_INVALID_W5_ACTIONS)

    if len(actions) != 1 or actions[0].type_ != "action_send_msg":
        raise ValueError(ERR_EXACT_TVM_INVALID_W5_ACTIONS)

    action = actions[0]
    if (
        not action.out_msg.is_internal
        or action.out_msg.info.dest is None
        or not action.out_msg.info.bounce
    ):
        raise ValueError(ERR_EXACT_TVM_INVALID_W5_ACTIONS)

    allowed_send_modes = {
        SEND_MODE_PAY_FEES_SEPARATELY,
        SEND_MODE_PAY_FEES_SEPARATELY + SEND_MODE_IGNORE_ERRORS,
    }
    if action.mode not in allowed_send_modes:
        raise ValueError(ERR_EXACT_TVM_INVALID_W5_ACTIONS)

    transfer = parse_jetton_transfer(
        jetton_wallet=normalize_address(action.out_msg.info.dest),
        body=action.out_msg.body,
    )
    transfer.attached_ton_amount = action.out_msg.info.value_coins

    signature = body_slice.load_bytes(64)
    if body_slice.remaining_bits or body_slice.remaining_refs:
        raise ValueError(ERR_EXACT_TVM_INVALID_W5_MESSAGE)

    signed_slice = body.begin_parse().copy()
    signed_slice.bits = signed_slice.bits[:-512]
    signed_slice_hash = signed_slice.to_cell().hash

    return ParsedTvmSettlement(
        payer=payer,
        wallet_id=wallet_id,
        valid_until=valid_until,
        seqno=seqno,
        settlement_hash=root.hash.hex(),
        body=body,
        signed_slice_hash=signed_slice_hash,
        signature=signature,
        state_init=state_init,
        transfer=transfer,
    )
