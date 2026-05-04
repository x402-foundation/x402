"""Focused tests for the exact TVM settlement payload codec."""

from __future__ import annotations

import base64

import pytest

pytest.importorskip("pytoniq_core")

from pytoniq.contract.contract import Contract
from pytoniq_core import Address, Cell, begin_cell

from x402.mechanisms.tvm.codecs.w5 import serialize_out_list, serialize_send_msg_action
from x402.mechanisms.tvm.constants import (
    ERR_EXACT_TVM_INVALID_SETTLEMENT_BOC,
    ERR_EXACT_TVM_INVALID_W5_ACTIONS,
    ERR_EXACT_TVM_INVALID_W5_MESSAGE,
    JETTON_TRANSFER_OPCODE,
    SEND_MODE_IGNORE_ERRORS,
    SEND_MODE_PAY_FEES_SEPARATELY,
    W5_INTERNAL_SIGNED_OPCODE,
)
from x402.mechanisms.tvm.exact.codec import parse_exact_tvm_payload

PAYER = "0:" + "1" * 64
SOURCE_WALLET = "0:" + "2" * 64
DESTINATION = "0:" + "3" * 64
RESPONSE_DESTINATION = "0:" + "4" * 64


def _make_transfer_body(
    *,
    destination: str = DESTINATION,
    response_destination: str | None = RESPONSE_DESTINATION,
    amount: int = 123,
    forward_ton_amount: int = 456,
    forward_payload: Cell | None = None,
) -> Cell:
    builder = (
        begin_cell()
        .store_uint(JETTON_TRANSFER_OPCODE, 32)
        .store_uint(0, 64)
        .store_coins(amount)
        .store_address(Address(destination))
        .store_address(Address(response_destination) if response_destination else None)
        .store_bit(0)
        .store_coins(forward_ton_amount)
    )
    if forward_payload is None:
        builder = builder.store_bit(0)
    else:
        builder = builder.store_bit(1).store_ref(forward_payload)
    return builder.end_cell()


def _make_signed_body(
    *,
    action_cell: Cell | None = None,
    opcode: int = W5_INTERNAL_SIGNED_OPCODE,
    wallet_id: int = 7,
    valid_until: int = 111,
    seqno: int = 9,
    has_actions: bool = True,
    has_extra_actions: bool = False,
    signature: bytes = b"\xaa" * 64,
    trailing_bit: bool = False,
) -> Cell:
    if action_cell is None:
        out_msg = Contract.create_internal_msg(
            src=None,
            dest=Address(SOURCE_WALLET),
            bounce=True,
            value=999,
            body=_make_transfer_body(forward_payload=begin_cell().store_uint(0xAB, 8).end_cell()),
        ).serialize()
        action_cell = serialize_send_msg_action(out_msg, SEND_MODE_PAY_FEES_SEPARATELY)

    builder = (
        begin_cell()
        .store_uint(opcode, 32)
        .store_uint(wallet_id, 32)
        .store_uint(valid_until, 32)
        .store_uint(seqno, 32)
    )
    if has_actions:
        builder = builder.store_bit(1).store_ref(serialize_out_list([action_cell]))
    else:
        builder = builder.store_bit(0)
    builder = builder.store_bit(1 if has_extra_actions else 0).store_bytes(signature)
    if trailing_bit:
        builder = builder.store_bit(1)
    return builder.end_cell()


def _make_settlement_boc(
    *,
    body: Cell | None = None,
    bounce: bool = True,
    internal: bool = True,
) -> str:
    body = body or _make_signed_body()
    if internal:
        message = Contract.create_internal_msg(
            src=None,
            dest=Address(PAYER),
            bounce=bounce,
            value=0,
            body=body,
        )
    else:
        message = Contract.create_external_msg(
            dest=Address(PAYER),
            body=body,
        )
    return base64.b64encode(message.serialize().to_boc()).decode("ascii")


class TestParseExactTvmPayload:
    def test_should_reject_malformed_boc(self):
        with pytest.raises(ValueError, match=ERR_EXACT_TVM_INVALID_SETTLEMENT_BOC):
            parse_exact_tvm_payload("not-base64")

    def test_should_reject_non_internal_message(self):
        with pytest.raises(ValueError, match=ERR_EXACT_TVM_INVALID_SETTLEMENT_BOC):
            parse_exact_tvm_payload(_make_settlement_boc(internal=False))

    def test_should_accept_non_bounceable_settlement_wrapper(self):
        payload = parse_exact_tvm_payload(_make_settlement_boc(bounce=False))

        assert payload.payer == PAYER
        assert payload.transfer.source_wallet == SOURCE_WALLET

    def test_should_reject_wrong_w5_opcode(self):
        with pytest.raises(ValueError, match=ERR_EXACT_TVM_INVALID_W5_MESSAGE):
            parse_exact_tvm_payload(_make_settlement_boc(body=_make_signed_body(opcode=0xDEADBEEF)))

    def test_should_reject_extra_actions_flag(self):
        with pytest.raises(ValueError, match=ERR_EXACT_TVM_INVALID_W5_ACTIONS):
            parse_exact_tvm_payload(
                _make_settlement_boc(body=_make_signed_body(has_extra_actions=True))
            )

    def test_should_reject_wrong_action_count(self):
        with pytest.raises(ValueError, match=ERR_EXACT_TVM_INVALID_W5_ACTIONS):
            parse_exact_tvm_payload(_make_settlement_boc(body=_make_signed_body(has_actions=False)))

    def test_should_reject_invalid_action_type(self):
        invalid_action = (
            begin_cell()
            .store_uint(0xDEADBEEF, 32)
            .store_uint(0, 8)
            .store_ref(Cell.empty())
            .end_cell()
        )

        with pytest.raises(ValueError, match=ERR_EXACT_TVM_INVALID_W5_ACTIONS):
            parse_exact_tvm_payload(
                _make_settlement_boc(body=_make_signed_body(action_cell=invalid_action))
            )

    def test_should_reject_wrong_send_mode(self):
        out_msg = Contract.create_internal_msg(
            src=None,
            dest=Address(SOURCE_WALLET),
            bounce=True,
            value=999,
            body=_make_transfer_body(),
        ).serialize()
        wrong_mode_action = serialize_send_msg_action(out_msg, SEND_MODE_PAY_FEES_SEPARATELY + 1)

        with pytest.raises(ValueError, match=ERR_EXACT_TVM_INVALID_W5_ACTIONS):
            parse_exact_tvm_payload(
                _make_settlement_boc(body=_make_signed_body(action_cell=wrong_mode_action))
            )

    def test_should_accept_ignore_errors_send_mode(self):
        out_msg = Contract.create_internal_msg(
            src=None,
            dest=Address(SOURCE_WALLET),
            bounce=True,
            value=999,
            body=_make_transfer_body(),
        ).serialize()
        acceptable_action = serialize_send_msg_action(
            out_msg,
            SEND_MODE_PAY_FEES_SEPARATELY + SEND_MODE_IGNORE_ERRORS,
        )

        payload = parse_exact_tvm_payload(
            _make_settlement_boc(body=_make_signed_body(action_cell=acceptable_action))
        )

        assert payload.transfer.source_wallet == SOURCE_WALLET

    def test_should_reject_trailing_bits_after_signature(self):
        with pytest.raises(ValueError, match=ERR_EXACT_TVM_INVALID_W5_MESSAGE):
            parse_exact_tvm_payload(_make_settlement_boc(body=_make_signed_body(trailing_bit=True)))

    def test_should_parse_valid_settlement_boc(self):
        payload = parse_exact_tvm_payload(_make_settlement_boc())

        assert payload.payer == PAYER
        assert payload.wallet_id == 7
        assert payload.valid_until == 111
        assert payload.seqno == 9
        assert payload.transfer.source_wallet == SOURCE_WALLET
        assert payload.transfer.destination == DESTINATION
        assert payload.transfer.response_destination == RESPONSE_DESTINATION
        assert payload.transfer.jetton_amount == 123
        assert payload.transfer.attached_ton_amount == 999
        assert payload.transfer.forward_ton_amount == 456
        assert payload.signature == b"\xaa" * 64
