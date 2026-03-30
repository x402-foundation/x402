"""Tests for ExactEvmScheme server."""

import pytest

from x402.mechanisms.evm import (
    get_network_config,
)
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.schemas import AssetAmount, PaymentRequirements, SupportedKind


class TestParsePrice:
    """Test parsePrice method."""

    class TestBaseMainnetNetwork:
        """Test Base Mainnet network."""

        def test_should_parse_dollar_string_prices(self):
            """Should parse dollar string prices."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"

            result = server.parse_price("$0.10", network)

            assert result.amount == "100000"  # 0.10 USDC = 100000 smallest units
            assert result.asset == get_network_config(network)["default_asset"]["address"]
            assert result.extra == {"name": "USD Coin", "version": "2"}

        def test_should_parse_simple_number_string_prices(self):
            """Should parse simple number string prices."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"

            result = server.parse_price("0.10", network)

            assert result.amount == "100000"
            assert result.asset == get_network_config(network)["default_asset"]["address"]

        def test_should_parse_number_prices(self):
            """Should parse number prices."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"

            result = server.parse_price(0.1, network)

            assert result.amount == "100000"
            assert result.asset == get_network_config(network)["default_asset"]["address"]

        def test_should_handle_larger_amounts(self):
            """Should handle larger amounts."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"

            result = server.parse_price("100.50", network)

            assert result.amount == "100500000"  # 100.50 USDC

        def test_should_handle_whole_numbers(self):
            """Should handle whole numbers."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"

            result = server.parse_price("1", network)

            assert result.amount == "1000000"  # 1 USDC

    class TestEthereumMainnetNetwork:
        """Test Ethereum Mainnet network."""

        def test_should_raise_for_network_without_default_stablecoin(self):
            """Should raise ValueError when network has no default stablecoin configured."""
            server = ExactEvmServerScheme()
            network = "eip155:1"

            with pytest.raises(ValueError, match="No default stablecoin"):
                server.parse_price("1.00", network)

    class TestBaseSepoliaNetwork:
        """Test Base Sepolia network."""

        def test_should_use_sepolia_usdc_address(self):
            """Should use Base Sepolia USDC address."""
            server = ExactEvmServerScheme()
            network = "eip155:84532"

            result = server.parse_price("1.00", network)

            assert result.asset == get_network_config(network)["default_asset"]["address"]
            assert result.amount == "1000000"

    class TestPreParsedPriceObjects:
        """Test pre-parsed price objects."""

        def test_should_handle_pre_parsed_price_objects_with_asset(self):
            """Should handle pre-parsed price objects with asset."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"

            result = server.parse_price(
                {
                    "amount": "123456",
                    "asset": "0x1234567890123456789012345678901234567890",
                    "extra": {"foo": "bar"},
                },
                network,
            )

            assert result.amount == "123456"
            assert result.asset == "0x1234567890123456789012345678901234567890"
            assert result.extra == {"foo": "bar"}

        def test_should_raise_for_price_objects_without_asset(self):
            """Should raise ValueError for price objects without asset."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"

            with pytest.raises(ValueError, match="Asset address required"):
                server.parse_price({"amount": "123456"}, network)

    class TestErrorCases:
        """Test error cases."""

        def test_should_raise_for_invalid_money_formats(self):
            """Should raise ValueError for invalid money formats."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"

            with pytest.raises(ValueError):
                server.parse_price("not-a-price!", network)

        def test_should_raise_for_invalid_amounts(self):
            """Should raise ValueError for invalid amounts."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"

            with pytest.raises(ValueError):
                server.parse_price("abc", network)


class TestEnhancePaymentRequirements:
    """Test enhancePaymentRequirements method."""

    def test_should_add_eip712_domain_to_payment_requirements(self):
        """Should add EIP-712 domain (name, version) to payment requirements."""
        server = ExactEvmServerScheme()
        network = "eip155:8453"

        requirements = PaymentRequirements(
            scheme="exact",
            network=network,
            asset=get_network_config(network)["default_asset"]["address"],
            amount="100000",
            pay_to="0x1234567890123456789012345678901234567890",
            max_timeout_seconds=3600,
            extra={},
        )

        supported_kind = SupportedKind(
            x402_version=2,
            scheme="exact",
            network=network,
            extra={},
        )

        result = server.enhance_payment_requirements(requirements, supported_kind, [])

        assert result.extra is not None
        assert "name" in result.extra
        assert "version" in result.extra
        assert result.extra["name"] == "USD Coin"
        assert result.extra["version"] == "2"

    def test_should_preserve_existing_extra_fields(self):
        """Should preserve existing extra fields."""
        server = ExactEvmServerScheme()
        network = "eip155:8453"

        requirements = PaymentRequirements(
            scheme="exact",
            network=network,
            asset=get_network_config(network)["default_asset"]["address"],
            amount="100000",
            pay_to="0x1234567890123456789012345678901234567890",
            max_timeout_seconds=3600,
            extra={"custom": "value"},
        )

        supported_kind = SupportedKind(
            x402_version=2,
            scheme="exact",
            network=network,
            extra={},
        )

        result = server.enhance_payment_requirements(requirements, supported_kind, [])

        assert result.extra is not None
        assert result.extra.get("custom") == "value"
        assert result.extra.get("name") == "USD Coin"

    def test_should_convert_decimal_amounts_to_smallest_unit(self):
        """Should convert decimal amounts to smallest unit."""
        server = ExactEvmServerScheme()
        network = "eip155:8453"

        requirements = PaymentRequirements(
            scheme="exact",
            network=network,
            asset=get_network_config(network)["default_asset"]["address"],
            amount="1.5",  # Decimal amount
            pay_to="0x1234567890123456789012345678901234567890",
            max_timeout_seconds=3600,
            extra={},
        )

        supported_kind = SupportedKind(
            x402_version=2,
            scheme="exact",
            network=network,
            extra={},
        )

        result = server.enhance_payment_requirements(requirements, supported_kind, [])

        assert result.amount == "1500000"  # Converted to smallest unit

    def test_should_set_default_asset_if_not_specified(self):
        """Should set default asset if not specified."""
        server = ExactEvmServerScheme()
        network = "eip155:8453"

        requirements = PaymentRequirements(
            scheme="exact",
            network=network,
            asset="",  # Empty asset
            amount="100000",
            pay_to="0x1234567890123456789012345678901234567890",
            max_timeout_seconds=3600,
            extra={},
        )

        supported_kind = SupportedKind(
            x402_version=2,
            scheme="exact",
            network=network,
            extra={},
        )

        result = server.enhance_payment_requirements(requirements, supported_kind, [])

        config = get_network_config(network)
        assert result.asset == config["default_asset"]["address"]


class TestRegisterMoneyParser:
    """Test registerMoneyParser method."""

    class TestSingleCustomParser:
        """Test single custom parser."""

        def test_should_use_custom_parser_for_money_values(self):
            """Should use custom parser for Money values."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"

            def custom_parser(amount: float, network: str) -> AssetAmount | None:
                # Custom logic: different conversion for large amounts
                if amount > 100:
                    return AssetAmount(
                        amount=str(int(amount * 1e9)),  # Custom decimals
                        asset="0xCustomToken123456789012345678901234567890",
                        extra={"token": "CUSTOM", "tier": "large"},
                    )
                return None  # Use default for small amounts

            server.register_money_parser(custom_parser)

            # Large amount should use custom parser
            result1 = server.parse_price(150, network)
            assert result1.asset == "0xCustomToken123456789012345678901234567890"
            assert result1.extra.get("token") == "CUSTOM"
            assert result1.amount == str(int(150 * 1e9))

            # Small amount should fall back to default (USDC)
            result2 = server.parse_price(50, network)
            assert result2.asset == get_network_config(network)["default_asset"]["address"]
            assert result2.amount == "50000000"  # 50 * 1e6

        def test_should_receive_decimal_number_not_raw_string(self):
            """Should receive decimal number, not raw string."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"
            received_amounts: list[float] = []
            received_networks: list[str] = []

            def capture_parser(amount: float, network: str) -> AssetAmount | None:
                received_amounts.append(amount)
                received_networks.append(network)
                return None  # Use default

            server.register_money_parser(capture_parser)

            server.parse_price("$1.50", network)
            assert received_amounts[-1] == 1.5
            assert received_networks[-1] == network

            server.parse_price("5.25", network)
            assert received_amounts[-1] == 5.25

            server.parse_price(10.99, network)
            assert received_amounts[-1] == 10.99

        def test_should_not_call_parser_for_asset_amount_passthrough(self):
            """Should not call parser for AssetAmount (pass-through)."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"
            parser_called = False

            def tracking_parser(amount: float, network: str) -> AssetAmount | None:
                nonlocal parser_called
                parser_called = True
                return None

            server.register_money_parser(tracking_parser)

            asset_amount = {
                "amount": "100000",
                "asset": "0xToken123456789012345678901234567890123456",
                "extra": {"custom": True},
            }

            result = server.parse_price(asset_amount, network)

            assert parser_called is False  # Parser not called for AssetAmount
            assert result.amount == "100000"
            assert result.asset == "0xToken123456789012345678901234567890123456"

        def test_should_fall_back_to_default_if_parser_returns_none(self):
            """Should fall back to default if parser returns None."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"

            def null_parser(amount: float, network: str) -> AssetAmount | None:
                return None  # Always delegate

            server.register_money_parser(null_parser)

            result = server.parse_price(1, network)

            # Should use default USDC
            assert result.asset == get_network_config(network)["default_asset"]["address"]
            assert result.amount == "1000000"

    class TestMultipleParsersChainOfResponsibility:
        """Test multiple parsers - chain of responsibility."""

        def test_should_try_parsers_in_registration_order(self):
            """Should try parsers in registration order."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"
            execution_order: list[int] = []

            def parser1(amount: float, network: str) -> AssetAmount | None:
                execution_order.append(1)
                if amount > 1000:
                    return AssetAmount(amount="1", asset="0xParser1Token", extra={})
                return None

            def parser2(amount: float, network: str) -> AssetAmount | None:
                execution_order.append(2)
                if amount > 100:
                    return AssetAmount(amount="2", asset="0xParser2Token", extra={})
                return None

            def parser3(amount: float, network: str) -> AssetAmount | None:
                execution_order.append(3)
                return AssetAmount(amount="3", asset="0xParser3Token", extra={})

            server.register_money_parser(parser1)
            server.register_money_parser(parser2)
            server.register_money_parser(parser3)

            server.parse_price(50, network)

            assert execution_order == [1, 2, 3]  # All tried

        def test_should_stop_at_first_non_null_result(self):
            """Should stop at first non-null result."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"
            execution_order: list[int] = []

            def parser1(amount: float, network: str) -> AssetAmount | None:
                execution_order.append(1)
                return None

            def parser2(amount: float, network: str) -> AssetAmount | None:
                execution_order.append(2)
                return AssetAmount(amount="winner", asset="0xWinnerToken", extra={})

            def parser3(amount: float, network: str) -> AssetAmount | None:
                execution_order.append(3)  # Should not execute
                return AssetAmount(amount="3", asset="0xParser3Token", extra={})

            server.register_money_parser(parser1)
            server.register_money_parser(parser2)
            server.register_money_parser(parser3)

            result = server.parse_price(50, network)

            assert execution_order == [1, 2]  # Stopped after parser 2
            assert result.asset == "0xWinnerToken"

        def test_should_use_default_if_all_parsers_return_null(self):
            """Should use default if all parsers return None."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"

            server.register_money_parser(lambda a, n: None)
            server.register_money_parser(lambda a, n: None)
            server.register_money_parser(lambda a, n: None)

            result = server.parse_price(1, network)

            # Should use default USDC
            assert result.asset == get_network_config(network)["default_asset"]["address"]
            assert result.amount == "1000000"

    class TestErrorHandling:
        """Test error handling."""

        def test_should_propagate_errors_from_parser(self):
            """Should propagate errors from parser."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"

            def error_parser(amount: float, network: str) -> AssetAmount | None:
                raise RuntimeError("Parser error: amount exceeds limit")

            server.register_money_parser(error_parser)

            with pytest.raises(RuntimeError, match="Parser error: amount exceeds limit"):
                server.parse_price(50, network)

    class TestChainingAndFluentApi:
        """Test chaining and fluent API."""

        def test_should_return_self_for_chaining(self):
            """Should return self for chaining."""
            server = ExactEvmServerScheme()

            def parser1(amount: float, network: str) -> AssetAmount | None:
                return None

            def parser2(amount: float, network: str) -> AssetAmount | None:
                return None

            result = server.register_money_parser(parser1).register_money_parser(parser2)

            assert result is server

    class TestEdgeCases:
        """Test edge cases."""

        def test_should_handle_zero_amounts(self):
            """Should handle zero amounts."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"
            received_amount: float | None = None

            def capture_parser(amount: float, network: str) -> AssetAmount | None:
                nonlocal received_amount
                received_amount = amount
                return None

            server.register_money_parser(capture_parser)

            server.parse_price(0, network)
            assert received_amount == 0

        def test_should_handle_very_small_decimal_amounts(self):
            """Should handle very small decimal amounts."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"
            received_amount: float | None = None

            def capture_parser(amount: float, network: str) -> AssetAmount | None:
                nonlocal received_amount
                received_amount = amount
                return None

            server.register_money_parser(capture_parser)

            server.parse_price(0.000001, network)
            assert received_amount == 0.000001

        def test_should_handle_very_large_amounts(self):
            """Should handle very large amounts."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"
            received_amount: float | None = None

            def capture_parser(amount: float, network: str) -> AssetAmount | None:
                nonlocal received_amount
                received_amount = amount
                return None

            server.register_money_parser(capture_parser)

            server.parse_price(999999999.99, network)
            assert received_amount == 999999999.99

        def test_should_handle_negative_amounts_parser_can_validate(self):
            """Should handle negative amounts (parser can validate)."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"

            def validate_parser(amount: float, network: str) -> AssetAmount | None:
                if amount < 0:
                    raise ValueError("Negative amounts not supported")
                return None

            server.register_money_parser(validate_parser)

            with pytest.raises(ValueError, match="Negative amounts not supported"):
                server.parse_price(-10, network)

    class TestRealWorldUseCases:
        """Test real-world use cases."""

        def test_should_support_network_specific_tokens(self):
            """Should support network-specific tokens."""
            server = ExactEvmServerScheme()

            def network_parser(amount: float, network: str) -> AssetAmount | None:
                # Base Sepolia uses custom test token
                if "84532" in network:  # Base Sepolia
                    return AssetAmount(
                        amount=str(int(amount * 1e6)),
                        asset="0xTestToken123456789012345678901234567890",
                        extra={"network": "sepolia", "token": "TEST"},
                    )
                return None  # Use default for mainnet

            server.register_money_parser(network_parser)

            sepolia_result = server.parse_price(10, "eip155:84532")
            assert sepolia_result.extra.get("network") == "sepolia"
            assert sepolia_result.asset == "0xTestToken123456789012345678901234567890"

            mainnet_result = server.parse_price(10, "eip155:8453")
            assert (
                mainnet_result.asset
                == get_network_config("eip155:8453")["default_asset"]["address"]
            )

        def test_should_support_tiered_pricing(self):
            """Should support tiered pricing."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"

            def premium_parser(amount: float, network: str) -> AssetAmount | None:
                if amount > 1000:
                    return AssetAmount(
                        amount=str(int(amount * 1e9)),  # Different decimals
                        asset="0xPremiumToken123456789012345678901234567890",
                        extra={"tier": "premium"},
                    )
                return None

            def standard_parser(amount: float, network: str) -> AssetAmount | None:
                if amount > 100:
                    return AssetAmount(
                        amount=str(int(amount * 1e6)),
                        asset="0xStandardToken123456789012345678901234567890",
                        extra={"tier": "standard"},
                    )
                return None

            server.register_money_parser(premium_parser)
            server.register_money_parser(standard_parser)
            # < 100 uses default

            premium = server.parse_price(2000, network)
            assert premium.extra.get("tier") == "premium"

            standard = server.parse_price(500, network)
            assert standard.extra.get("tier") == "standard"

            basic = server.parse_price(50, network)
            assert basic.asset == get_network_config(network)["default_asset"]["address"]

    class TestIntegrationWithParsePriceFlow:
        """Test integration with parsePrice flow."""

        def test_should_work_with_all_money_input_formats(self):
            """Should work with all Money input formats."""
            server = ExactEvmServerScheme()
            network = "eip155:8453"
            call_log: list[dict] = []

            def logging_parser(amount: float, network: str) -> AssetAmount | None:
                call_log.append({"amount": amount})
                return None  # Use default

            server.register_money_parser(logging_parser)

            server.parse_price("$10.50", network)
            server.parse_price("25.75", network)
            server.parse_price(42.25, network)

            assert len(call_log) == 3
            assert call_log[0]["amount"] == 10.5
            assert call_log[1]["amount"] == 25.75
            assert call_log[2]["amount"] == 42.25
