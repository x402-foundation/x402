"""Unit tests for TVM jetton codec helpers."""

from __future__ import annotations

import base64

import pytest

pytest.importorskip("pytoniq_core")

from pytoniq_core import Address, begin_cell

from x402.mechanisms.tvm.codecs.common import normalize_address
from x402.mechanisms.tvm.codecs.jetton import (
    build_jetton_transfer_body,
    build_jetton_transfer_body_fields,
    parse_jetton_transfer,
)
from x402.mechanisms.tvm.constants import (
    ERR_EXACT_TVM_INVALID_JETTON_TRANSFER,
    JETTON_TRANSFER_OPCODE,
)

from .builders import make_tvm_requirements

DESTINATION = "0:" + "d" * 64
RESPONSE_DEST = "0:" + "e" * 64
JETTON_WALLET = "0:" + "4" * 64


def _raw_transfer_body(
    *,
    opcode: int = JETTON_TRANSFER_OPCODE,
    amount: int = 100,
    destination: str | None = DESTINATION,
    response_destination: str | None = None,
    custom_payload_bit: bool = False,
    forward_ton_amount: int = 0,
    forward_payload_bit: bool = False,
) -> object:
    """Build a raw TEP-74 transfer cell allowing edge-case values."""
    builder = (
        begin_cell()
        .store_uint(opcode, 32)
        .store_uint(0, 64)
        .store_coins(amount)
        .store_address(Address(destination) if destination else None)
        .store_address(Address(response_destination) if response_destination else None)
        .store_bit(1 if custom_payload_bit else 0)
        .store_coins(forward_ton_amount)
        .store_bit(1 if forward_payload_bit else 0)
    )
    if forward_payload_bit:
        builder = builder.store_ref(begin_cell().store_uint(0xAB, 8).end_cell())
    return builder.end_cell()


class TestBuildJettonTransferBodyFields:
    def test_opcode_stored_as_first_32_bits(self):
        cell = build_jetton_transfer_body_fields(
            amount=1, pay_to=DESTINATION, extra={"forwardTonAmount": "0"}
        )
        s = cell.begin_parse()
        assert s.load_uint(32) == JETTON_TRANSFER_OPCODE

    def test_amount_stored_as_coins(self):
        cell = build_jetton_transfer_body_fields(
            amount=999, pay_to=DESTINATION, extra={"forwardTonAmount": "0"}
        )
        s = cell.begin_parse()
        s.load_uint(32)
        s.load_uint(64)
        assert s.load_coins() == 999

    def test_destination_stored_as_address(self):
        cell = build_jetton_transfer_body_fields(
            amount=1, pay_to=DESTINATION, extra={"forwardTonAmount": "0"}
        )
        s = cell.begin_parse()
        s.load_uint(32)
        s.load_uint(64)
        s.load_coins()
        addr = s.load_address()
        assert normalize_address(addr) == normalize_address(DESTINATION)

    def test_no_response_destination_stores_none_address(self):
        cell = build_jetton_transfer_body_fields(
            amount=1, pay_to=DESTINATION, extra={"forwardTonAmount": "0"}
        )
        s = cell.begin_parse()
        s.load_uint(32)
        s.load_uint(64)
        s.load_coins()
        s.load_address()
        response_addr = s.load_address()
        assert response_addr is None

    def test_response_destination_stored_as_address(self):
        extra = {"forwardTonAmount": "0", "responseDestination": RESPONSE_DEST}
        cell = build_jetton_transfer_body_fields(amount=1, pay_to=DESTINATION, extra=extra)
        s = cell.begin_parse()
        s.load_uint(32)
        s.load_uint(64)
        s.load_coins()
        s.load_address()
        response_addr = s.load_address()
        assert normalize_address(response_addr) == normalize_address(RESPONSE_DEST)

    def test_custom_payload_bit_always_zero(self):
        cell = build_jetton_transfer_body_fields(
            amount=1, pay_to=DESTINATION, extra={"forwardTonAmount": "0"}
        )
        s = cell.begin_parse()
        s.load_uint(32)
        s.load_uint(64)
        s.load_coins()
        s.load_address()
        s.load_address()
        assert s.load_bit() == 0

    def test_forward_ton_amount_stored(self):
        cell = build_jetton_transfer_body_fields(
            amount=1, pay_to=DESTINATION, extra={"forwardTonAmount": "50000000"}
        )
        s = cell.begin_parse()
        s.load_uint(32)
        s.load_uint(64)
        s.load_coins()
        s.load_address()
        s.load_address()
        s.load_bit()
        assert s.load_coins() == 50_000_000

    def test_forward_ton_amount_zero_accepted(self):
        cell = build_jetton_transfer_body_fields(
            amount=1, pay_to=DESTINATION, extra={"forwardTonAmount": "0"}
        )
        s = cell.begin_parse()
        s.load_uint(32)
        s.load_uint(64)
        s.load_coins()
        s.load_address()
        s.load_address()
        s.load_bit()
        assert s.load_coins() == 0

    def test_negative_forward_ton_amount_raises(self):
        with pytest.raises(ValueError, match="Forward ton amount should be >= 0"):
            build_jetton_transfer_body_fields(
                amount=1, pay_to=DESTINATION, extra={"forwardTonAmount": "-1"}
            )

    def test_no_forward_payload_stores_two_zero_bits(self):
        cell = build_jetton_transfer_body_fields(
            amount=1, pay_to=DESTINATION, extra={"forwardTonAmount": "0"}
        )
        s = cell.begin_parse()
        s.load_uint(32)
        s.load_uint(64)
        s.load_coins()
        s.load_address()
        s.load_address()
        s.load_bit()
        s.load_coins()
        assert s.load_uint(2) == 0

    def test_forward_payload_stored_as_ref(self):
        payload_cell = begin_cell().store_uint(0xDE, 8).end_cell()
        payload_b64 = base64.b64encode(payload_cell.to_boc()).decode()
        cell = build_jetton_transfer_body_fields(
            amount=1,
            pay_to=DESTINATION,
            extra={"forwardTonAmount": "0", "forwardPayload": payload_b64},
        )
        assert len(cell.refs) >= 1


class TestBuildJettonTransferBody:
    def test_delegates_amount_and_pay_to_from_requirements(self):
        req = make_tvm_requirements(
            amount="250", pay_to=DESTINATION, extra={"forwardTonAmount": "0"}
        )
        cell = build_jetton_transfer_body(req)
        s = cell.begin_parse()
        s.load_uint(32)
        s.load_uint(64)
        assert s.load_coins() == 250
        addr = s.load_address()
        assert normalize_address(addr) == normalize_address(DESTINATION)

    def test_amount_coerced_from_string(self):
        req = make_tvm_requirements(
            amount="1000000", pay_to=DESTINATION, extra={"forwardTonAmount": "0"}
        )
        cell = build_jetton_transfer_body(req)
        s = cell.begin_parse()
        s.load_uint(32)
        s.load_uint(64)
        assert s.load_coins() == 1_000_000

    def test_returns_cell(self):
        from pytoniq_core import Cell as TonCell

        req = make_tvm_requirements(amount="1", pay_to=DESTINATION, extra={"forwardTonAmount": "0"})
        cell = build_jetton_transfer_body(req)
        assert isinstance(cell, TonCell)


class TestParseJettonTransfer:
    def test_round_trip_extracts_destination(self):
        cell = build_jetton_transfer_body_fields(
            amount=500, pay_to=DESTINATION, extra={"forwardTonAmount": "0"}
        )
        result = parse_jetton_transfer(JETTON_WALLET, cell)
        assert normalize_address(result.destination) == normalize_address(DESTINATION)

    def test_round_trip_extracts_jetton_amount(self):
        cell = build_jetton_transfer_body_fields(
            amount=777, pay_to=DESTINATION, extra={"forwardTonAmount": "0"}
        )
        result = parse_jetton_transfer(JETTON_WALLET, cell)
        assert result.jetton_amount == 777

    def test_round_trip_extracts_forward_ton_amount(self):
        cell = build_jetton_transfer_body_fields(
            amount=1, pay_to=DESTINATION, extra={"forwardTonAmount": "12345"}
        )
        result = parse_jetton_transfer(JETTON_WALLET, cell)
        assert result.forward_ton_amount == 12345

    def test_source_wallet_set_to_jetton_wallet_arg(self):
        cell = build_jetton_transfer_body_fields(
            amount=1, pay_to=DESTINATION, extra={"forwardTonAmount": "0"}
        )
        result = parse_jetton_transfer(JETTON_WALLET, cell)
        assert result.source_wallet == JETTON_WALLET

    def test_body_hash_equals_cell_hash(self):
        cell = build_jetton_transfer_body_fields(
            amount=1, pay_to=DESTINATION, extra={"forwardTonAmount": "0"}
        )
        result = parse_jetton_transfer(JETTON_WALLET, cell)
        assert result.body_hash == cell.hash

    def test_attached_ton_amount_always_zero(self):
        cell = build_jetton_transfer_body_fields(
            amount=1, pay_to=DESTINATION, extra={"forwardTonAmount": "99"}
        )
        result = parse_jetton_transfer(JETTON_WALLET, cell)
        assert result.attached_ton_amount == 0

    def test_response_destination_none_when_absent(self):
        cell = build_jetton_transfer_body_fields(
            amount=1, pay_to=DESTINATION, extra={"forwardTonAmount": "0"}
        )
        result = parse_jetton_transfer(JETTON_WALLET, cell)
        assert result.response_destination is None

    def test_response_destination_normalized_when_present(self):
        extra = {"forwardTonAmount": "0", "responseDestination": RESPONSE_DEST}
        cell = build_jetton_transfer_body_fields(amount=1, pay_to=DESTINATION, extra=extra)
        result = parse_jetton_transfer(JETTON_WALLET, cell)
        assert normalize_address(result.response_destination) == normalize_address(RESPONSE_DEST)

    def test_wrong_opcode_raises(self):
        cell = _raw_transfer_body(opcode=0xDEAD_BEEF)
        with pytest.raises(ValueError, match=ERR_EXACT_TVM_INVALID_JETTON_TRANSFER):
            parse_jetton_transfer(JETTON_WALLET, cell)

    def test_custom_payload_bit_set_raises(self):
        cell = _raw_transfer_body(custom_payload_bit=True)
        with pytest.raises(ValueError, match=ERR_EXACT_TVM_INVALID_JETTON_TRANSFER):
            parse_jetton_transfer(JETTON_WALLET, cell)

    def test_null_destination_raises(self):
        cell = _raw_transfer_body(destination=None)
        with pytest.raises(ValueError, match=ERR_EXACT_TVM_INVALID_JETTON_TRANSFER):
            parse_jetton_transfer(JETTON_WALLET, cell)

    def test_forward_payload_from_ref_when_bit_one(self):
        cell = _raw_transfer_body(forward_payload_bit=True)
        result = parse_jetton_transfer(JETTON_WALLET, cell)
        assert result.forward_payload is not None

    def test_forward_payload_from_slice_when_bit_zero(self):
        cell = _raw_transfer_body(forward_payload_bit=False)
        result = parse_jetton_transfer(JETTON_WALLET, cell)
        assert result.forward_payload is not None
