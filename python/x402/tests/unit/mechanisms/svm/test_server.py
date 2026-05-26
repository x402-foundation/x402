"""Tests for ExactSvmScheme server."""

import pytest

from x402.mechanisms.svm import (
    SOLANA_DEVNET_CAIP2,
    SOLANA_MAINNET_CAIP2,
    SOLANA_TESTNET_CAIP2,
    USDC_DEVNET_ADDRESS,
    USDC_MAINNET_ADDRESS,
)
from x402.mechanisms.svm.exact import ExactSvmServerScheme
from x402.schemas import AssetAmount, PaymentRequirements, SupportedKind


class TestParsePrice:
    """Test parsePrice method."""

    class TestSolanaMainnetNetwork:
        """Test Solana Mainnet network."""

        def test_should_parse_dollar_string_prices(self):
            """Should parse dollar string prices."""
            server = ExactSvmServerScheme()

            result = server.parse_price("$0.10", SOLANA_MAINNET_CAIP2)

            assert result.amount == "100000"  # 0.10 USDC = 100000 smallest units
            assert result.asset == USDC_MAINNET_ADDRESS
            assert result.extra == {}

        def test_should_parse_simple_number_string_prices(self):
            """Should parse simple number string prices."""
            server = ExactSvmServerScheme()

            result = server.parse_price("0.10", SOLANA_MAINNET_CAIP2)

            assert result.amount == "100000"
            assert result.asset == USDC_MAINNET_ADDRESS

        def test_should_parse_number_prices(self):
            """Should parse number prices."""
            server = ExactSvmServerScheme()

            result = server.parse_price(0.1, SOLANA_MAINNET_CAIP2)

            assert result.amount == "100000"
            assert result.asset == USDC_MAINNET_ADDRESS

        def test_should_handle_larger_amounts(self):
            """Should handle larger amounts."""
            server = ExactSvmServerScheme()

            result = server.parse_price("100.50", SOLANA_MAINNET_CAIP2)

            assert result.amount == "100500000"  # 100.50 USDC

        def test_should_handle_whole_numbers(self):
            """Should handle whole numbers."""
            server = ExactSvmServerScheme()

            result = server.parse_price("1", SOLANA_MAINNET_CAIP2)

            assert result.amount == "1000000"  # 1 USDC

    class TestSolanaDevnetNetwork:
        """Test Solana Devnet network."""

        def test_should_use_devnet_usdc_address(self):
            """Should use Devnet USDC address."""
            server = ExactSvmServerScheme()

            result = server.parse_price("1.00", SOLANA_DEVNET_CAIP2)

            assert result.asset == USDC_DEVNET_ADDRESS
            assert result.amount == "1000000"

    class TestSolanaTestnetNetwork:
        """Test Solana Testnet network."""

        def test_should_use_testnet_usdc_address(self):
            """Should use Testnet USDC address (same as devnet)."""
            server = ExactSvmServerScheme()

            result = server.parse_price("1.00", SOLANA_TESTNET_CAIP2)

            assert result.asset == USDC_DEVNET_ADDRESS
            assert result.amount == "1000000"

    class TestPreParsedPriceObjects:
        """Test pre-parsed price objects."""

        def test_should_handle_pre_parsed_price_objects_with_asset(self):
            """Should handle pre-parsed price objects with asset."""
            server = ExactSvmServerScheme()

            result = server.parse_price(
                {
                    "amount": "123456",
                    "asset": "CustomTokenAddress11111111111111111111",
                    "extra": {"foo": "bar"},
                },
                SOLANA_MAINNET_CAIP2,
            )

            assert result.amount == "123456"
            assert result.asset == "CustomTokenAddress11111111111111111111"
            assert result.extra == {"foo": "bar"}

        def test_should_raise_for_price_objects_without_asset(self):
            """Should raise ValueError for price objects without asset."""
            server = ExactSvmServerScheme()

            with pytest.raises(ValueError, match="Asset address required"):
                server.parse_price({"amount": "123456"}, SOLANA_MAINNET_CAIP2)

    class TestErrorCases:
        """Test error cases."""

        def test_should_raise_for_invalid_money_formats(self):
            """Should raise ValueError for invalid money formats."""
            server = ExactSvmServerScheme()

            with pytest.raises(ValueError):
                server.parse_price("not-a-price!", SOLANA_MAINNET_CAIP2)

        def test_should_raise_for_invalid_amounts(self):
            """Should raise ValueError for invalid amounts."""
            server = ExactSvmServerScheme()

            with pytest.raises(ValueError):
                server.parse_price("abc", SOLANA_MAINNET_CAIP2)


class TestEnhancePaymentRequirements:
    """Test enhancePaymentRequirements method."""

    def test_should_add_fee_payer_to_payment_requirements(self):
        """Should add feePayer to payment requirements."""
        server = ExactSvmServerScheme()

        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_MAINNET_CAIP2,
            asset=USDC_MAINNET_ADDRESS,
            amount="100000",
            pay_to="PayToAddress11111111111111111111111111",
            max_timeout_seconds=3600,
            extra={},
        )

        facilitator_address = "FacilitatorAddress1111111111111111111"
        supported_kind = SupportedKind(
            x402_version=2,
            scheme="exact",
            network=SOLANA_MAINNET_CAIP2,
            extra={"feePayer": facilitator_address},
        )

        result = server.enhance_payment_requirements(requirements, supported_kind, [])

        assert result.extra is not None
        assert result.extra.get("feePayer") == facilitator_address

    def test_should_preserve_existing_extra_fields(self):
        """Should preserve existing extra fields."""
        server = ExactSvmServerScheme()

        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to="PayToAddress11111111111111111111111111",
            max_timeout_seconds=3600,
            extra={"custom": "value"},
        )

        supported_kind = SupportedKind(
            x402_version=2,
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            extra={"feePayer": "FeePayer1111111111111111111111111111"},
        )

        result = server.enhance_payment_requirements(requirements, supported_kind, [])

        assert result.extra is not None
        assert result.extra.get("custom") == "value"
        assert result.extra.get("feePayer") == "FeePayer1111111111111111111111111111"


class TestRegisterMoneyParser:
    """Test registerMoneyParser method."""

    class TestSingleCustomParser:
        """Test single custom parser."""

        def test_should_use_custom_parser_for_money_values(self):
            """Should use custom parser for Money values."""
            server = ExactSvmServerScheme()

            def custom_parser(amount: float, network: str) -> AssetAmount | None:
                # Custom logic: different conversion for large amounts
                if amount > 100:
                    return AssetAmount(
                        amount=str(int(amount * 1e9)),  # Custom decimals
                        asset="CustomTokenMint1111111111111111111111",
                        extra={"token": "CUSTOM", "tier": "large"},
                    )
                return None  # Use default for small amounts

            server.register_money_parser(custom_parser)

            # Large amount should use custom parser
            result1 = server.parse_price(150, SOLANA_MAINNET_CAIP2)
            assert result1.asset == "CustomTokenMint1111111111111111111111"
            assert result1.extra.get("token") == "CUSTOM"
            assert result1.amount == str(int(150 * 1e9))

            # Small amount should fall back to default (USDC)
            result2 = server.parse_price(50, SOLANA_MAINNET_CAIP2)
            assert result2.asset == USDC_MAINNET_ADDRESS  # Mainnet USDC
            assert result2.amount == "50000000"  # 50 * 1e6

        def test_should_receive_decimal_number_not_raw_string(self):
            """Should receive decimal number, not raw string."""
            server = ExactSvmServerScheme()
            received_amounts: list[float] = []
            received_networks: list[str] = []

            def capture_parser(amount: float, network: str) -> AssetAmount | None:
                received_amounts.append(amount)
                received_networks.append(network)
                return None  # Use default

            server.register_money_parser(capture_parser)

            server.parse_price("$1.50", SOLANA_MAINNET_CAIP2)
            assert received_amounts[-1] == 1.5
            assert received_networks[-1] == SOLANA_MAINNET_CAIP2

            server.parse_price("5.25", SOLANA_MAINNET_CAIP2)
            assert received_amounts[-1] == 5.25

            server.parse_price(10.99, SOLANA_MAINNET_CAIP2)
            assert received_amounts[-1] == 10.99

        def test_should_not_call_parser_for_asset_amount_passthrough(self):
            """Should not call parser for AssetAmount (pass-through)."""
            server = ExactSvmServerScheme()
            parser_called = False

            def tracking_parser(amount: float, network: str) -> AssetAmount | None:
                nonlocal parser_called
                parser_called = True
                return None

            server.register_money_parser(tracking_parser)

            asset_amount = {
                "amount": "100000",
                "asset": "TokenMint1111111111111111111111111111",
                "extra": {"custom": True},
            }

            result = server.parse_price(asset_amount, SOLANA_MAINNET_CAIP2)

            assert parser_called is False  # Parser not called for AssetAmount
            assert result.amount == "100000"
            assert result.asset == "TokenMint1111111111111111111111111111"

        def test_should_fall_back_to_default_if_parser_returns_none(self):
            """Should fall back to default if parser returns None."""
            server = ExactSvmServerScheme()

            def null_parser(amount: float, network: str) -> AssetAmount | None:
                return None  # Always delegate

            server.register_money_parser(null_parser)

            result = server.parse_price(1, SOLANA_MAINNET_CAIP2)

            # Should use default Solana mainnet USDC
            assert result.asset == USDC_MAINNET_ADDRESS
            assert result.amount == "1000000"

    class TestMultipleParsersChainOfResponsibility:
        """Test multiple parsers - chain of responsibility."""

        def test_should_try_parsers_in_registration_order(self):
            """Should try parsers in registration order."""
            server = ExactSvmServerScheme()
            execution_order: list[int] = []

            def parser1(amount: float, network: str) -> AssetAmount | None:
                execution_order.append(1)
                if amount > 1000:
                    return AssetAmount(amount="1", asset="Parser1Token", extra={})
                return None

            def parser2(amount: float, network: str) -> AssetAmount | None:
                execution_order.append(2)
                if amount > 100:
                    return AssetAmount(amount="2", asset="Parser2Token", extra={})
                return None

            def parser3(amount: float, network: str) -> AssetAmount | None:
                execution_order.append(3)
                return AssetAmount(amount="3", asset="Parser3Token", extra={})

            server.register_money_parser(parser1)
            server.register_money_parser(parser2)
            server.register_money_parser(parser3)

            server.parse_price(50, SOLANA_MAINNET_CAIP2)

            assert execution_order == [1, 2, 3]  # All tried

        def test_should_stop_at_first_non_null_result(self):
            """Should stop at first non-null result."""
            server = ExactSvmServerScheme()
            execution_order: list[int] = []

            def parser1(amount: float, network: str) -> AssetAmount | None:
                execution_order.append(1)
                return None

            def parser2(amount: float, network: str) -> AssetAmount | None:
                execution_order.append(2)
                return AssetAmount(amount="winner", asset="WinnerToken", extra={})

            def parser3(amount: float, network: str) -> AssetAmount | None:
                execution_order.append(3)  # Should not execute
                return AssetAmount(amount="3", asset="Parser3Token", extra={})

            server.register_money_parser(parser1)
            server.register_money_parser(parser2)
            server.register_money_parser(parser3)

            result = server.parse_price(50, SOLANA_MAINNET_CAIP2)

            assert execution_order == [1, 2]  # Stopped after parser 2
            assert result.asset == "WinnerToken"

        def test_should_use_default_if_all_parsers_return_null(self):
            """Should use default if all parsers return None."""
            server = ExactSvmServerScheme()

            server.register_money_parser(lambda a, n: None)
            server.register_money_parser(lambda a, n: None)
            server.register_money_parser(lambda a, n: None)

            result = server.parse_price(1, SOLANA_MAINNET_CAIP2)

            # Should use default Solana mainnet USDC
            assert result.asset == USDC_MAINNET_ADDRESS
            assert result.amount == "1000000"

    class TestErrorHandling:
        """Test error handling."""

        def test_should_propagate_errors_from_parser(self):
            """Should propagate errors from parser."""
            server = ExactSvmServerScheme()

            def error_parser(amount: float, network: str) -> AssetAmount | None:
                raise RuntimeError("Parser error: amount exceeds limit")

            server.register_money_parser(error_parser)

            with pytest.raises(RuntimeError, match="Parser error: amount exceeds limit"):
                server.parse_price(50, SOLANA_MAINNET_CAIP2)

    class TestChainingAndFluentApi:
        """Test chaining and fluent API."""

        def test_should_return_self_for_chaining(self):
            """Should return self for chaining."""
            server = ExactSvmServerScheme()

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
            server = ExactSvmServerScheme()
            received_amount: float | None = None

            def capture_parser(amount: float, network: str) -> AssetAmount | None:
                nonlocal received_amount
                received_amount = amount
                return None

            server.register_money_parser(capture_parser)

            server.parse_price(0, SOLANA_MAINNET_CAIP2)
            assert received_amount == 0

        def test_should_handle_very_small_decimal_amounts(self):
            """Should handle very small decimal amounts."""
            server = ExactSvmServerScheme()
            received_amount: float | None = None

            def capture_parser(amount: float, network: str) -> AssetAmount | None:
                nonlocal received_amount
                received_amount = amount
                return None

            server.register_money_parser(capture_parser)

            server.parse_price(0.000001, SOLANA_MAINNET_CAIP2)
            assert received_amount == 0.000001

        def test_should_handle_very_large_amounts(self):
            """Should handle very large amounts."""
            server = ExactSvmServerScheme()
            received_amount: float | None = None

            def capture_parser(amount: float, network: str) -> AssetAmount | None:
                nonlocal received_amount
                received_amount = amount
                return None

            server.register_money_parser(capture_parser)

            server.parse_price(999999999.99, SOLANA_MAINNET_CAIP2)
            assert received_amount == 999999999.99

        def test_should_handle_negative_amounts_parser_can_validate(self):
            """Should handle negative amounts (parser can validate)."""
            server = ExactSvmServerScheme()

            def validate_parser(amount: float, network: str) -> AssetAmount | None:
                if amount < 0:
                    raise ValueError("Negative amounts not supported")
                return None

            server.register_money_parser(validate_parser)

            with pytest.raises(ValueError, match="Negative amounts not supported"):
                server.parse_price(-10, SOLANA_MAINNET_CAIP2)

    class TestRealWorldUseCases:
        """Test real-world use cases."""

        def test_should_support_network_specific_tokens(self):
            """Should support network-specific tokens."""
            server = ExactSvmServerScheme()

            def network_parser(amount: float, network: str) -> AssetAmount | None:
                # Mainnet uses USDC, devnet uses custom test token
                if "EtWTRA" in network:  # Devnet
                    return AssetAmount(
                        amount=str(int(amount * 1e6)),
                        asset="TestTokenMint1111111111111111111111",
                        extra={"network": "devnet", "token": "TEST"},
                    )
                return None  # Use default for mainnet

            server.register_money_parser(network_parser)

            devnet_result = server.parse_price(10, SOLANA_DEVNET_CAIP2)
            assert devnet_result.extra.get("network") == "devnet"
            assert devnet_result.asset == "TestTokenMint1111111111111111111111"

            mainnet_result = server.parse_price(10, SOLANA_MAINNET_CAIP2)
            assert mainnet_result.asset == USDC_MAINNET_ADDRESS  # Default

        def test_should_support_tiered_pricing(self):
            """Should support tiered pricing."""
            server = ExactSvmServerScheme()

            def premium_parser(amount: float, network: str) -> AssetAmount | None:
                if amount > 1000:
                    return AssetAmount(
                        amount=str(int(amount * 1e9)),  # Different decimals
                        asset="PremiumTokenMint11111111111111111",
                        extra={"tier": "premium"},
                    )
                return None

            def standard_parser(amount: float, network: str) -> AssetAmount | None:
                if amount > 100:
                    return AssetAmount(
                        amount=str(int(amount * 1e6)),
                        asset="StandardTokenMint1111111111111111",
                        extra={"tier": "standard"},
                    )
                return None

            server.register_money_parser(premium_parser)
            server.register_money_parser(standard_parser)
            # < 100 uses default

            premium = server.parse_price(2000, SOLANA_MAINNET_CAIP2)
            assert premium.extra.get("tier") == "premium"

            standard = server.parse_price(500, SOLANA_MAINNET_CAIP2)
            assert standard.extra.get("tier") == "standard"

            basic = server.parse_price(50, SOLANA_MAINNET_CAIP2)
            assert basic.asset == USDC_MAINNET_ADDRESS  # Default USDC

    class TestIntegrationWithParsePriceFlow:
        """Test integration with parsePrice flow."""

        def test_should_work_with_all_money_input_formats(self):
            """Should work with all Money input formats."""
            server = ExactSvmServerScheme()
            call_log: list[dict] = []

            def logging_parser(amount: float, network: str) -> AssetAmount | None:
                call_log.append({"amount": amount})
                return None  # Use default

            server.register_money_parser(logging_parser)

            server.parse_price("$10.50", SOLANA_MAINNET_CAIP2)
            server.parse_price("25.75", SOLANA_MAINNET_CAIP2)
            server.parse_price(42.25, SOLANA_MAINNET_CAIP2)

            assert len(call_log) == 3
            assert call_log[0]["amount"] == 10.5
            assert call_log[1]["amount"] == 25.75
            assert call_log[2]["amount"] == 42.25
