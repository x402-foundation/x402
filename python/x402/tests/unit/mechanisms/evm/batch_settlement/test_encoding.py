"""Unit tests for batch-settlement ABI-encoding helpers.

Mirrors go/mechanisms/evm/batch-settlement/encoding_test.go.
"""

from __future__ import annotations

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.encoding import (
        build_eip2612_permit_data,
        build_erc3009_collector_data,
        build_erc3009_deposit_nonce,
        build_permit2_collector_data,
    )
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


CHANNEL_ID = "0x" + "11" * 32


class TestBuildErc3009DepositNonce:
    def test_deterministic(self):
        a = build_erc3009_deposit_nonce(CHANNEL_ID, "0x02")
        b = build_erc3009_deposit_nonce(CHANNEL_ID, "0x02")
        assert a == b
        assert a.startswith("0x") and len(a) == 66

    def test_different_salts_produce_different_nonces(self):
        a = build_erc3009_deposit_nonce(CHANNEL_ID, "0x01")
        b = build_erc3009_deposit_nonce(CHANNEL_ID, "0x02")
        assert a != b

    def test_different_channel_ids_produce_different_nonces(self):
        a = build_erc3009_deposit_nonce("0x" + "aa" * 32, "0x01")
        b = build_erc3009_deposit_nonce("0x" + "bb" * 32, "0x01")
        assert a != b

    def test_accepts_int_salt(self):
        # Salts may be passed as ints as well as hex strings.
        a = build_erc3009_deposit_nonce(CHANNEL_ID, "0x02")
        b = build_erc3009_deposit_nonce(CHANNEL_ID, "2")
        assert a == b

    def test_rejects_invalid_salt(self):
        with pytest.raises(ValueError):
            build_erc3009_deposit_nonce(CHANNEL_ID, "not-hex")


class TestBuildErc3009CollectorData:
    def test_deterministic(self):
        a = build_erc3009_collector_data("0", "9999999999", "0x01", "0xdeadbeef")
        b = build_erc3009_collector_data("0", "9999999999", "0x01", "0xdeadbeef")
        assert a == b
        assert len(a) > 0

    def test_different_inputs_differ(self):
        a = build_erc3009_collector_data("0", "1", "0x01", "0xff")
        b = build_erc3009_collector_data("0", "2", "0x01", "0xff")
        assert a != b

    def test_rejects_invalid_valid_after(self):
        with pytest.raises(ValueError):
            build_erc3009_collector_data("not-a-number", "0", "0x01", "0xff")

    def test_rejects_invalid_valid_before(self):
        with pytest.raises(ValueError):
            build_erc3009_collector_data("0", "not-a-number", "0x01", "0xff")

    def test_rejects_invalid_salt(self):
        with pytest.raises(ValueError):
            build_erc3009_collector_data("0", "1", "not-hex", "0xff")


class TestBuildPermit2CollectorData:
    def test_empty_and_missing_eip2612_segment_encode_identically(self):
        a = build_permit2_collector_data("100", "9999999999", "0xdeadbeef", b"")
        b = build_permit2_collector_data("100", "9999999999", "0xdeadbeef", "")
        assert a == b

    def test_accepts_eip2612_segment(self):
        permit = build_eip2612_permit_data(
            "1000000",
            "9999999999",
            27,
            "0x" + "11" * 32,
            "0x" + "22" * 32,
        )
        with_permit = build_permit2_collector_data("1", "9999999999", "0xff", permit)
        without = build_permit2_collector_data("1", "9999999999", "0xff", b"")
        assert with_permit != without

    def test_rejects_invalid_nonce(self):
        with pytest.raises(ValueError):
            build_permit2_collector_data("not-a-number", "1", "0xff", b"")

    def test_rejects_invalid_deadline(self):
        with pytest.raises(ValueError):
            build_permit2_collector_data("1", "not-a-number", "0xff", b"")

    def test_accepts_hex_string_for_eip2612_segment(self):
        a = build_permit2_collector_data("1", "9", "0xff", "0xabcd")
        b = build_permit2_collector_data("1", "9", "0xff", b"\xab\xcd")
        assert a == b


class TestBuildEip2612PermitData:
    def test_deterministic(self):
        kwargs = {
            "value": "1000",
            "deadline": "1234567890",
            "v": 28,
            "r": "0x" + "aa" * 32,
            "s": "0x" + "bb" * 32,
        }
        a = build_eip2612_permit_data(**kwargs)
        b = build_eip2612_permit_data(**kwargs)
        assert a == b

    def test_rejects_non_numeric_value(self):
        with pytest.raises(ValueError):
            build_eip2612_permit_data(
                value="not-a-number",
                deadline="1",
                v=27,
                r="0x" + "00" * 32,
                s="0x" + "00" * 32,
            )
