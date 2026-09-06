"""Jetton-specific TVM payload encoding and decoding."""

from __future__ import annotations

from collections.abc import Mapping

from ....schemas import PaymentRequirements
from ..constants import ERR_EXACT_TVM_INVALID_JETTON_TRANSFER, JETTON_TRANSFER_OPCODE
from ..types import ParsedJettonTransfer
from .common import decode_base64_boc, normalize_address

try:
    from pytoniq_core import Address, Cell, begin_cell
except ImportError as e:
    raise ImportError(
        "TVM mechanism requires pytoniq packages. Install with: pip install x402[tvm]"
    ) from e


def build_jetton_transfer_body(requirements: PaymentRequirements) -> Cell:
    """Build a TEP-74 ``transfer`` body from x402 TVM payment requirements."""
    return build_jetton_transfer_body_fields(
        amount=int(requirements.amount),
        pay_to=requirements.pay_to,
        extra=requirements.extra,
    )


def build_jetton_transfer_body_fields(
    *,
    amount: int,
    pay_to: str,
    extra: Mapping[str, object],
) -> Cell:
    """Build a TEP-74 ``transfer`` body from normalized transfer fields."""
    forward_ton_amount = int(extra.get("forwardTonAmount", 0))
    if forward_ton_amount < 0:
        raise ValueError("Forward ton amount should be >= 0")
    response_destination = extra.get("responseDestination")

    transfer_body = (
        begin_cell()
        .store_uint(JETTON_TRANSFER_OPCODE, 32)
        .store_uint(0, 64)
        .store_coins(amount)
        .store_address(Address(pay_to))
        .store_address(response_destination)
        .store_bit(0)
        .store_coins(forward_ton_amount)
    )
    encoded_forward_payload = extra.get("forwardPayload")
    if encoded_forward_payload is None:
        transfer_body = transfer_body.store_uint(0, 2)
    else:
        forward_payload = decode_base64_boc(str(encoded_forward_payload))
        transfer_body = transfer_body.store_maybe_ref(forward_payload)
    return transfer_body.end_cell()


def parse_jetton_transfer(jetton_wallet: str, body: Cell) -> ParsedJettonTransfer:
    """
    Parse a TEP-74 `transfer` body:
    transfer#0f8a7ea5 query_id:uint64 amount:(VarUInteger 16) destination:MsgAddress
                 response_destination:MsgAddress custom_payload:(Maybe ^Cell)
                 forward_ton_amount:(VarUInteger 16) forward_payload:(Either Cell ^Cell)
                 = InternalMsgBody;
    """
    body_slice = body.begin_parse()

    opcode = body_slice.load_uint(32)
    if opcode != JETTON_TRANSFER_OPCODE:
        raise ValueError(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER)

    body_slice.load_uint(64)
    amount = body_slice.load_coins()
    destination = body_slice.load_address()
    if destination is None:
        raise ValueError(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER)

    response_destination = body_slice.load_address()

    if body_slice.load_bit():
        raise ValueError(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER)
    forward_ton_amount = body_slice.load_coins()
    forward_payload = body_slice.load_ref() if body_slice.load_bit() else body_slice.to_cell()

    return ParsedJettonTransfer(
        source_wallet=jetton_wallet,
        destination=normalize_address(destination),
        response_destination=(
            normalize_address(response_destination) if response_destination else None
        ),
        jetton_amount=amount,
        attached_ton_amount=0,
        forward_ton_amount=forward_ton_amount,
        forward_payload=forward_payload,
        body_hash=body.hash,
    )
