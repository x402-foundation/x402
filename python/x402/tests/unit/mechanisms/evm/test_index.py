"""Tests for EVM mechanism exports and utility functions."""

import pytest

from x402.mechanisms.evm import (
    DEFAULT_DECIMALS,
    DEFAULT_VALIDITY_PERIOD,
    ERR_INVALID_SIGNATURE,
    ERR_NETWORK_MISMATCH,
    ERR_UNSUPPORTED_SCHEME,
    SCHEME_EXACT,
    TX_STATUS_FAILED,
    TX_STATUS_SUCCESS,
    ClientEvmSigner,
    EthAccountSigner,
    ExactEIP3009Payload,
    ExactEvmPayloadV1,
    ExactEvmPayloadV2,
    FacilitatorEvmSigner,
    FacilitatorWeb3Signer,
    bytes_to_hex,
    create_nonce,
    create_validity_window,
    format_amount,
    get_asset_info,
    get_evm_chain_id,
    get_network_config,
    hex_to_bytes,
    is_valid_address,
    is_valid_network,
    normalize_address,
    parse_amount,
    parse_money_to_decimal,
)
from x402.mechanisms.evm.exact import (
    ExactEvmClientScheme,
    ExactEvmFacilitatorScheme,
    ExactEvmServerScheme,
)


class TestExports:
    """Test that main classes and constants are exported."""

    def test_should_export_main_classes(self):
        """Should export main scheme classes."""
        assert ExactEvmClientScheme is not None
        assert ExactEvmServerScheme is not None
        assert ExactEvmFacilitatorScheme is not None

    def test_should_export_signer_protocols(self):
        """Should export signer protocol classes."""
        assert ClientEvmSigner is not None
        assert FacilitatorEvmSigner is not None

    def test_should_export_signer_implementations(self):
        """Should export signer implementation classes."""
        assert EthAccountSigner is not None
        assert FacilitatorWeb3Signer is not None

    def test_should_export_payload_types(self):
        """Should export payload types."""
        assert ExactEIP3009Payload is not None
        assert ExactEvmPayloadV1 is not None
        assert ExactEvmPayloadV2 is not None


class TestIsValidAddress:
    """Test is_valid_address function."""

    def test_should_validate_correct_ethereum_addresses(self):
        """Should validate correct Ethereum addresses."""
        assert is_valid_address("0x1234567890123456789012345678901234567890") is True
        assert is_valid_address("0x0000000000000000000000000000000000000000") is True
        assert is_valid_address("0xABCDEFabcdef1234567890123456789012345678") is True

    def test_should_handle_addresses_without_0x_prefix(self):
        """Should handle addresses without 0x prefix."""
        assert is_valid_address("1234567890123456789012345678901234567890") is True

    def test_should_reject_invalid_addresses(self):
        """Should reject invalid addresses."""
        assert is_valid_address("") is False
        assert is_valid_address("invalid") is False
        assert is_valid_address("0x123") is False  # Too short
        assert (
            is_valid_address("0x12345678901234567890123456789012345678901234") is False
        )  # Too long
        assert (
            is_valid_address("0xGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv") is False
        )  # Invalid hex

    def test_should_reject_addresses_with_invalid_characters(self):
        """Should reject addresses with invalid hex characters."""
        assert is_valid_address("0xGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv") is False


class TestNormalizeAddress:
    """Test normalize_address function."""

    def test_should_normalize_address_to_checksummed_format(self):
        """Should normalize address to checksummed format."""
        addr = "0x1234567890123456789012345678901234567890"
        normalized = normalize_address(addr)

        assert normalized.startswith("0x")
        assert len(normalized) == 42

    def test_should_handle_addresses_without_0x_prefix(self):
        """Should handle addresses without 0x prefix."""
        addr = "1234567890123456789012345678901234567890"
        normalized = normalize_address(addr)

        assert normalized.startswith("0x")
        assert len(normalized) == 42

    def test_should_raise_for_invalid_address_length(self):
        """Should raise ValueError for invalid address length."""
        with pytest.raises(ValueError, match="Invalid address length"):
            normalize_address("0x123")

    def test_should_raise_for_invalid_hex(self):
        """Should raise ValueError for invalid hex."""
        # Use an address with exactly 40 chars but invalid hex characters (G, H, I, J, K, L, M, N are not valid hex)
        # 32 valid hex chars + 8 invalid hex chars = 40 chars total
        with pytest.raises(ValueError, match="Invalid hex"):
            normalize_address("0x0123456789abcdef0123456789abcdefGHIJKLMN")


class TestGetEvmChainId:
    """Test get_evm_chain_id function (CAIP-2 only)."""

    def test_should_extract_chain_id_from_caip2_format(self):
        """Should extract chain ID from CAIP-2 format."""
        assert get_evm_chain_id("eip155:8453") == 8453
        assert get_evm_chain_id("eip155:1") == 1
        assert get_evm_chain_id("eip155:84532") == 84532

    def test_should_handle_arbitrary_caip2_chain(self):
        """Should handle any valid CAIP-2 chain ID."""
        assert get_evm_chain_id("eip155:999999") == 999999

    def test_should_reject_legacy_names(self):
        """Should reject legacy network names (use evm.v1.utils for v1)."""
        with pytest.raises(ValueError, match="expected eip155:CHAIN_ID"):
            get_evm_chain_id("base")
        with pytest.raises(ValueError, match="expected eip155:CHAIN_ID"):
            get_evm_chain_id("base-sepolia")

    def test_should_raise_for_unsupported_formats(self):
        """Should raise ValueError for unsupported formats."""
        with pytest.raises(ValueError, match="expected eip155:CHAIN_ID"):
            get_evm_chain_id("unknown-network")
        with pytest.raises(ValueError, match="Invalid CAIP-2 network format"):
            get_evm_chain_id("eip155:")  # Invalid format


class TestGetNetworkConfig:
    """Test get_network_config function (CAIP-2 only)."""

    def test_should_return_config_for_supported_networks(self):
        """Should return config for supported networks."""
        config = get_network_config("eip155:8453")

        assert config is not None
        assert config["chain_id"] == 8453
        assert "default_asset" in config

    def test_should_reject_legacy_names(self):
        """Should reject legacy network names (use evm.v1.utils for v1)."""
        with pytest.raises(ValueError, match="expected eip155:CHAIN_ID"):
            get_network_config("base")

    def test_should_return_minimal_config_for_unknown_networks(self):
        """Should return a minimal config with chain_id for valid but unconfigured networks."""
        config = get_network_config("eip155:99999")
        assert config["chain_id"] == 99999


class TestGetAssetInfo:
    """Test get_asset_info function."""

    def test_should_return_asset_info_by_symbol(self):
        """Should return asset info for known address (get_asset_info takes address, not symbol)."""
        network = "eip155:8453"
        usdc_address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
        asset_info = get_asset_info(network, usdc_address)

        assert asset_info["address"].startswith("0x")
        assert asset_info["name"] == "USD Coin"
        assert asset_info["decimals"] == 6

    def test_should_return_asset_info_by_address(self):
        """Should return asset info by address."""
        network = "eip155:8453"
        usdc_address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
        asset_info = get_asset_info(network, usdc_address)

        assert asset_info["address"].lower() == usdc_address.lower()

    def test_should_raise_for_unknown_asset(self):
        """Should raise ValueError for an unregistered asset address."""
        unknown_address = "0x1234567890123456789012345678901234567890"
        with pytest.raises(ValueError, match="not a registered asset"):
            get_asset_info("eip155:8453", unknown_address)


class TestIsValidNetwork:
    """Test is_valid_network function (CAIP-2 only)."""

    def test_should_return_true_for_supported_networks(self):
        """Should return True for supported CAIP-2 networks."""
        assert is_valid_network("eip155:8453") is True
        assert is_valid_network("eip155:1") is True

    def test_should_return_false_for_legacy_names(self):
        """Should return False for legacy network names."""
        assert is_valid_network("base") is False

    def test_should_return_false_for_unsupported_networks(self):
        """Should return False for non-eip155 or malformed networks; True for any valid eip155 format."""
        assert is_valid_network("eip155:99999") is True  # Valid format, any chain ID
        assert is_valid_network("unknown-network") is False


class TestCreateNonce:
    """Test create_nonce function."""

    def test_should_generate_hex_string_with_0x_prefix(self):
        """Should generate hex string with 0x prefix."""
        nonce = create_nonce()

        assert nonce.startswith("0x")
        assert len(nonce) == 66  # 0x + 64 hex chars (32 bytes)

    def test_should_generate_different_nonces(self):
        """Should generate different nonces."""
        nonce1 = create_nonce()
        nonce2 = create_nonce()

        assert nonce1 != nonce2


class TestParseAmount:
    """Test parse_amount function."""

    def test_should_convert_decimal_amounts_to_smallest_unit(self):
        """Should convert decimal amounts to smallest unit."""
        assert parse_amount("0.10", 6) == 100000
        assert parse_amount("1.00", 6) == 1000000
        assert parse_amount("0.01", 6) == 10000
        assert parse_amount("123.456789", 6) == 123456789

    def test_should_handle_whole_numbers(self):
        """Should handle whole numbers."""
        assert parse_amount("1", 6) == 1000000
        assert parse_amount("100", 6) == 100000000

    def test_should_handle_different_decimals(self):
        """Should handle different decimal places."""
        assert parse_amount("1", 9) == 1000000000  # 9 decimals
        assert parse_amount("1", 2) == 100  # 2 decimals
        assert parse_amount("1", 0) == 1  # 0 decimals


class TestFormatAmount:
    """Test format_amount function."""

    def test_should_convert_smallest_unit_to_decimal_string(self):
        """Should convert smallest unit to decimal string."""
        assert format_amount(100000, 6) == "0.1"
        assert format_amount(1000000, 6) == "1"
        assert format_amount(10000, 6) == "0.01"
        assert format_amount(123456789, 6) == "123.456789"

    def test_should_handle_different_decimals(self):
        """Should handle different decimal places."""
        assert format_amount(1000000000, 9) == "1"
        assert format_amount(100, 2) == "1"
        assert format_amount(1, 0) == "1"


class TestCreateValidityWindow:
    """Test create_validity_window function."""

    def test_should_create_validity_window_with_default_duration(self):
        """Should create validity window with default duration."""

        valid_after, valid_before = create_validity_window()

        assert valid_after is not None
        assert valid_before is not None
        assert valid_before > valid_after
        # Should be approximately 1 hour apart (3600 seconds)
        assert valid_before - valid_after >= 3600 - 100  # Allow some tolerance

    def test_should_create_validity_window_with_custom_duration(self):
        """Should create validity window with custom duration."""
        from datetime import timedelta

        duration = timedelta(hours=2)
        valid_after, valid_before = create_validity_window(duration=duration)

        assert valid_before - valid_after >= 7200 - 100  # Approximately 2 hours

    def test_should_apply_buffer_to_valid_after(self):
        """Should apply buffer to valid_after (clock skew)."""
        valid_after, valid_before = create_validity_window()

        import time

        now = int(time.time())
        # valid_after should be in the past (with buffer)
        assert valid_after < now


class TestHexToBytes:
    """Test hex_to_bytes function."""

    def test_should_convert_hex_string_to_bytes(self):
        """Should convert hex string to bytes."""
        hex_str = "0x1234abcd"
        result = hex_to_bytes(hex_str)

        assert isinstance(result, bytes)
        assert result == bytes.fromhex("1234abcd")

    def test_should_handle_hex_string_without_0x_prefix(self):
        """Should handle hex string without 0x prefix."""
        hex_str = "1234abcd"
        result = hex_to_bytes(hex_str)

        assert isinstance(result, bytes)
        assert result == bytes.fromhex("1234abcd")


class TestBytesToHex:
    """Test bytes_to_hex function."""

    def test_should_convert_bytes_to_hex_string(self):
        """Should convert bytes to hex string."""
        data = bytes.fromhex("1234abcd")
        result = bytes_to_hex(data)

        assert result.startswith("0x")
        assert result == "0x1234abcd"

    def test_should_handle_empty_bytes(self):
        """Should handle empty bytes."""
        result = bytes_to_hex(b"")

        assert result == "0x"


class TestParseMoneyToDecimal:
    """Test parse_money_to_decimal function."""

    def test_should_parse_dollar_string_prices(self):
        """Should parse dollar string prices."""
        assert parse_money_to_decimal("$1.50") == 1.5
        assert parse_money_to_decimal("$0.10") == 0.1
        assert parse_money_to_decimal("$100") == 100.0

    def test_should_parse_simple_number_strings(self):
        """Should parse simple number strings."""
        assert parse_money_to_decimal("1.50") == 1.5
        assert parse_money_to_decimal("0.10") == 0.1
        assert parse_money_to_decimal("100") == 100.0

    def test_should_parse_numbers(self):
        """Should parse numbers."""
        assert parse_money_to_decimal(1.5) == 1.5
        assert parse_money_to_decimal(100) == 100.0

    def test_should_strip_usd_usdc_suffixes(self):
        """Should strip USD/USDC suffixes."""
        assert parse_money_to_decimal("1.50 USD") == 1.5
        assert parse_money_to_decimal("1.50 USDC") == 1.5
        assert parse_money_to_decimal("1.50 usd") == 1.5
        assert parse_money_to_decimal("1.50 usdc") == 1.5

    def test_should_raise_for_invalid_formats(self):
        """Should raise ValueError for invalid formats."""
        with pytest.raises(ValueError):
            parse_money_to_decimal("not-a-number")


class TestConstants:
    """Test that constants are exported with correct values."""

    def test_should_export_scheme_exact(self):
        """Should export scheme identifier."""
        assert SCHEME_EXACT == "exact"

    def test_should_export_default_decimals(self):
        """Should export default decimals."""
        assert DEFAULT_DECIMALS == 6

    def test_should_export_default_validity_period(self):
        """Should export default validity period."""
        assert DEFAULT_VALIDITY_PERIOD == 3600  # 1 hour

    def test_should_export_transaction_status_constants(self):
        """Should export transaction status constants."""
        assert TX_STATUS_SUCCESS == 1
        assert TX_STATUS_FAILED == 0

    def test_should_export_error_codes(self):
        """Should export error codes."""
        assert ERR_INVALID_SIGNATURE is not None
        assert ERR_UNSUPPORTED_SCHEME is not None
        assert ERR_NETWORK_MISMATCH is not None
