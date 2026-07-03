"""Tests for ERC-7702 delegation detection utilities."""

from x402.mechanisms.evm.erc7702 import (
    get_erc7702_delegate_address,
    is_erc7702_delegation,
)


class TestIsERC7702Delegation:
    def test_valid_delegation(self):
        delegate = bytes.fromhex("1234567890abcdef1234567890abcdef12345678")
        code = b"\xef\x01\x00" + delegate
        assert is_erc7702_delegation(code) is True

    def test_empty_code(self):
        assert is_erc7702_delegation(b"") is False

    def test_wrong_prefix(self):
        delegate = bytes.fromhex("1234567890abcdef1234567890abcdef12345678")
        code = b"\xef\x02\x00" + delegate
        assert is_erc7702_delegation(code) is False

    def test_too_short(self):
        assert is_erc7702_delegation(b"\xef\x01\x00\x12") is False

    def test_too_long(self):
        delegate = bytes.fromhex("1234567890abcdef1234567890abcdef12345678")
        code = b"\xef\x01\x00" + delegate + b"\x00"
        assert is_erc7702_delegation(code) is False

    def test_regular_contract_bytecode(self):
        code = bytes.fromhex("6080604052")
        assert is_erc7702_delegation(code) is False


class TestGetERC7702DelegateAddress:
    def test_valid_delegation(self):
        delegate_hex = "1234567890abcdef1234567890abcdef12345678"
        code = b"\xef\x01\x00" + bytes.fromhex(delegate_hex)
        result = get_erc7702_delegate_address(code)
        assert result == "0x" + delegate_hex

    def test_invalid_code(self):
        assert get_erc7702_delegate_address(bytes.fromhex("6080")) is None

    def test_empty_code(self):
        assert get_erc7702_delegate_address(b"") is None
