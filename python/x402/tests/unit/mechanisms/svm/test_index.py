"""Tests for SVM mechanism exports and utility functions."""

import pytest

from x402.mechanisms.svm import (
    SCHEME_EXACT,
    SOLANA_DEVNET_CAIP2,
    SOLANA_MAINNET_CAIP2,
    SOLANA_TESTNET_CAIP2,
    SVM_ADDRESS_REGEX,
    USDC_DEVNET_ADDRESS,
    USDC_MAINNET_ADDRESS,
    ClientSvmSigner,
    ExactSvmPayload,
    FacilitatorSvmSigner,
    KeypairSigner,
    convert_to_token_amount,
    get_usdc_address,
    normalize_network,
    validate_svm_address,
)
from x402.mechanisms.svm.exact import (
    ExactSvmClientScheme,
    ExactSvmFacilitatorScheme,
    ExactSvmScheme,
    ExactSvmServerScheme,
)


class TestExports:
    """Test that main classes and constants are exported."""

    def test_should_export_main_classes(self):
        """Should export main scheme classes."""
        assert ExactSvmScheme is not None
        assert ExactSvmClientScheme is not None
        assert ExactSvmServerScheme is not None
        assert ExactSvmFacilitatorScheme is not None

    def test_should_export_signer_protocols(self):
        """Should export signer protocol classes."""
        assert ClientSvmSigner is not None
        assert FacilitatorSvmSigner is not None

    def test_should_export_signer_implementations(self):
        """Should export signer implementation classes."""
        assert KeypairSigner is not None

    def test_should_export_payload_types(self):
        """Should export payload types."""
        assert ExactSvmPayload is not None


class TestValidateSvmAddress:
    """Test validateSvmAddress function."""

    def test_should_validate_correct_solana_addresses(self):
        """Should validate correct Solana addresses."""
        assert validate_svm_address(USDC_MAINNET_ADDRESS) is True
        assert validate_svm_address(USDC_DEVNET_ADDRESS) is True
        assert validate_svm_address("11111111111111111111111111111111") is True

    def test_should_reject_invalid_addresses(self):
        """Should reject invalid addresses."""
        assert validate_svm_address("") is False
        assert validate_svm_address("invalid") is False
        assert validate_svm_address("0x1234567890abcdef") is False
        assert validate_svm_address("too-short") is False

    def test_should_reject_addresses_with_invalid_characters(self):
        """Should reject addresses with invalid base58 characters (0, O, I, l)."""
        # 'O' not allowed in base58
        assert validate_svm_address("0000000000000000000000000000000O") is False
        # 'I' not allowed in base58
        assert validate_svm_address("0000000000000000000000000000000I") is False
        # 'l' (lowercase L) not allowed in base58
        assert validate_svm_address("0000000000000000000000000000000l") is False


class TestNormalizeNetwork:
    """Test normalizeNetwork function."""

    def test_should_return_caip2_format_as_is(self):
        """Should return CAIP-2 format as-is."""
        assert normalize_network(SOLANA_MAINNET_CAIP2) == SOLANA_MAINNET_CAIP2
        assert normalize_network(SOLANA_DEVNET_CAIP2) == SOLANA_DEVNET_CAIP2
        assert normalize_network(SOLANA_TESTNET_CAIP2) == SOLANA_TESTNET_CAIP2

    def test_should_convert_v1_network_names_to_caip2(self):
        """Should convert V1 network names to CAIP-2."""
        assert normalize_network("solana") == SOLANA_MAINNET_CAIP2
        assert normalize_network("solana-devnet") == SOLANA_DEVNET_CAIP2
        assert normalize_network("solana-testnet") == SOLANA_TESTNET_CAIP2

    def test_should_raise_for_unsupported_networks(self):
        """Should raise ValueError for unsupported networks."""
        with pytest.raises(ValueError, match="Unsupported SVM network"):
            normalize_network("solana:unknown")
        with pytest.raises(ValueError, match="Unsupported SVM network"):
            normalize_network("ethereum:1")
        with pytest.raises(ValueError, match="Unsupported SVM network"):
            normalize_network("unknown-network")


class TestGetUsdcAddress:
    """Test getUsdcAddress function."""

    def test_should_return_mainnet_usdc_address(self):
        """Should return mainnet USDC address."""
        assert get_usdc_address(SOLANA_MAINNET_CAIP2) == USDC_MAINNET_ADDRESS

    def test_should_return_devnet_usdc_address(self):
        """Should return devnet USDC address."""
        assert get_usdc_address(SOLANA_DEVNET_CAIP2) == USDC_DEVNET_ADDRESS

    def test_should_return_testnet_usdc_address(self):
        """Should return testnet USDC address (same as devnet)."""
        assert get_usdc_address(SOLANA_TESTNET_CAIP2) == USDC_DEVNET_ADDRESS

    def test_should_raise_for_unsupported_networks(self):
        """Should raise ValueError for unsupported networks."""
        with pytest.raises(ValueError, match="Unsupported SVM network"):
            get_usdc_address("solana:unknown")


class TestConvertToTokenAmount:
    """Test convertToTokenAmount function."""

    def test_should_convert_decimal_amounts_to_token_units_6_decimals(self):
        """Should convert decimal amounts to token units (6 decimals)."""
        assert convert_to_token_amount("0.10", 6) == "100000"
        assert convert_to_token_amount("1.00", 6) == "1000000"
        assert convert_to_token_amount("0.01", 6) == "10000"
        assert convert_to_token_amount("123.456789", 6) == "123456789"

    def test_should_handle_whole_numbers(self):
        """Should handle whole numbers."""
        assert convert_to_token_amount("1", 6) == "1000000"
        assert convert_to_token_amount("100", 6) == "100000000"

    def test_should_handle_different_decimals(self):
        """Should handle different decimal places."""
        assert convert_to_token_amount("1", 9) == "1000000000"  # SOL
        assert convert_to_token_amount("1", 2) == "100"
        assert convert_to_token_amount("1", 0) == "1"

    def test_should_raise_for_invalid_amounts(self):
        """Should raise ValueError for invalid amounts."""
        with pytest.raises(ValueError, match="Invalid amount"):
            convert_to_token_amount("abc", 6)
        with pytest.raises(ValueError, match="Invalid amount"):
            convert_to_token_amount("", 6)
        # NaN is parsed by Decimal but fails on conversion to int
        with pytest.raises(ValueError):
            convert_to_token_amount("NaN", 6)


class TestConstants:
    """Test that constants are exported with correct values."""

    def test_should_export_correct_usdc_addresses(self):
        """Should export correct USDC addresses."""
        assert USDC_MAINNET_ADDRESS == "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        assert USDC_DEVNET_ADDRESS == "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

    def test_should_have_valid_address_regex(self):
        """Should have valid address regex."""
        import re

        pattern = re.compile(SVM_ADDRESS_REGEX)
        assert pattern.match(USDC_MAINNET_ADDRESS) is not None

    def test_should_export_scheme_exact(self):
        """Should export scheme identifier."""
        assert SCHEME_EXACT == "exact"
