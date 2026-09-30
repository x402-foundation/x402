"""Tests for the broadcast transaction-hash validity check."""

from x402.mechanisms.evm.utils import is_valid_tx_hash


class TestIsValidTxHash:
    def test_accepts_well_formed_32_byte_hash(self):
        assert is_valid_tx_hash("0x" + "ab" * 32) is True

    def test_rejects_all_zero_hash(self):
        # A placeholder all-zero hash must fail terminally rather than surface as
        # settlement_pending with a hash that reconciles to nothing.
        assert is_valid_tx_hash("0x" + "00" * 32) is False

    def test_rejects_malformed_hashes(self):
        assert is_valid_tx_hash("0x" + "ab" * 31) is False  # too short
        assert is_valid_tx_hash("ab" * 32) is False  # missing 0x prefix
        assert is_valid_tx_hash("0x" + "zz" * 32) is False  # non-hex
        assert is_valid_tx_hash("") is False

    def test_rejects_non_string(self):
        assert is_valid_tx_hash(None) is False
        assert is_valid_tx_hash(123) is False
