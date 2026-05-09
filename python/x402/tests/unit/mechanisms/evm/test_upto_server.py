"""Tests for UptoEvmScheme server."""

import pytest

from x402.mechanisms.evm import get_network_config
from x402.mechanisms.evm.upto import UptoEvmServerScheme
from x402.schemas import AssetAmount, PaymentRequirements, SupportedKind

FACILITATOR = "0x1111111111111111111111111111111111111111"


class TestParsePrice:
    class TestBaseMainnetNetwork:
        def test_should_parse_dollar_string_prices(self):
            server = UptoEvmServerScheme()
            network = "eip155:8453"
            result = server.parse_price("$0.10", network)
            assert result.amount == "100000"
            assert result.asset == get_network_config(network)["default_asset"]["address"]

        def test_should_parse_number_prices(self):
            server = UptoEvmServerScheme()
            network = "eip155:8453"
            result = server.parse_price(0.1, network)
            assert result.amount == "100000"

        def test_default_conversion_includes_permit2(self):
            server = UptoEvmServerScheme()
            network = "eip155:8453"
            result = server.parse_price("$1.00", network)
            assert result.extra.get("assetTransferMethod") == "permit2"

    class TestPreParsedPriceObjects:
        def test_should_handle_pre_parsed_price_objects_with_asset(self):
            server = UptoEvmServerScheme()
            network = "eip155:8453"
            result = server.parse_price(
                {"amount": "123456", "asset": "0x1234567890123456789012345678901234567890"},
                network,
            )
            assert result.amount == "123456"

        def test_should_raise_for_price_objects_without_asset(self):
            server = UptoEvmServerScheme()
            network = "eip155:8453"
            with pytest.raises(ValueError, match="Asset address required"):
                server.parse_price({"amount": "123456"}, network)


class TestEnhancePaymentRequirements:
    def test_should_always_set_permit2_and_facilitator_address(self):
        server = UptoEvmServerScheme()
        network = "eip155:8453"

        requirements = PaymentRequirements(
            scheme="upto",
            network=network,
            asset=get_network_config(network)["default_asset"]["address"],
            amount="100000",
            pay_to="0x1234567890123456789012345678901234567890",
            max_timeout_seconds=3600,
            extra={},
        )

        supported_kind = SupportedKind(
            x402_version=2,
            scheme="upto",
            network=network,
            extra={"facilitatorAddress": FACILITATOR},
        )

        result = server.enhance_payment_requirements(requirements, supported_kind, [])

        assert result.extra is not None
        assert result.extra["assetTransferMethod"] == "permit2"
        assert result.extra["facilitatorAddress"] == FACILITATOR
        assert result.extra["name"]
        assert result.extra["version"]

    def test_should_convert_decimal_amounts_to_smallest_unit(self):
        server = UptoEvmServerScheme()
        network = "eip155:8453"

        requirements = PaymentRequirements(
            scheme="upto",
            network=network,
            asset=get_network_config(network)["default_asset"]["address"],
            amount="1.5",
            pay_to="0x1234567890123456789012345678901234567890",
            max_timeout_seconds=3600,
            extra={},
        )

        supported_kind = SupportedKind(
            x402_version=2,
            scheme="upto",
            network=network,
            extra={"facilitatorAddress": FACILITATOR},
        )

        result = server.enhance_payment_requirements(requirements, supported_kind, [])
        assert result.amount == "1500000"

    def test_should_set_default_asset_if_not_specified(self):
        server = UptoEvmServerScheme()
        network = "eip155:8453"

        requirements = PaymentRequirements(
            scheme="upto",
            network=network,
            asset="",
            amount="100000",
            pay_to="0x1234567890123456789012345678901234567890",
            max_timeout_seconds=3600,
            extra={},
        )

        supported_kind = SupportedKind(
            x402_version=2,
            scheme="upto",
            network=network,
            extra={"facilitatorAddress": FACILITATOR},
        )

        result = server.enhance_payment_requirements(requirements, supported_kind, [])

        config = get_network_config(network)
        assert result.asset == config["default_asset"]["address"]

    def test_should_copy_extension_keys_from_supported_kind_extra(self):
        server = UptoEvmServerScheme()
        network = "eip155:8453"
        requirements = PaymentRequirements(
            scheme="upto",
            network=network,
            asset=get_network_config(network)["default_asset"]["address"],
            amount="100000",
            pay_to="0x1234567890123456789012345678901234567890",
            max_timeout_seconds=3600,
            extra={},
        )
        supported_kind = SupportedKind(
            x402_version=2,
            scheme="upto",
            network=network,
            extra={
                "facilitatorAddress": FACILITATOR,
                "erc20ApprovalGasSponsoring": {"version": "1"},
            },
        )

        result = server.enhance_payment_requirements(
            requirements, supported_kind, ["erc20ApprovalGasSponsoring"]
        )
        assert result.extra is not None
        assert result.extra["erc20ApprovalGasSponsoring"] == {"version": "1"}

    def test_should_fail_without_facilitator_address(self):
        server = UptoEvmServerScheme()
        network = "eip155:8453"
        requirements = PaymentRequirements(
            scheme="upto",
            network=network,
            asset=get_network_config(network)["default_asset"]["address"],
            amount="100000",
            pay_to="0x1234567890123456789012345678901234567890",
            max_timeout_seconds=3600,
            extra={},
        )
        supported_kind = SupportedKind(
            x402_version=2,
            scheme="upto",
            network=network,
            extra={},
        )

        with pytest.raises(ValueError, match="facilitatorAddress"):
            server.enhance_payment_requirements(requirements, supported_kind, [])


class TestRegisterMoneyParser:
    def test_should_use_custom_parser_for_money_values(self):
        server = UptoEvmServerScheme()
        network = "eip155:8453"

        def custom_parser(amount: float, network: str) -> AssetAmount | None:
            if amount > 100:
                return AssetAmount(
                    amount=str(int(amount * 1e9)),
                    asset="0xCustomToken123456789012345678901234567890",
                    extra={"token": "CUSTOM"},
                )
            return None

        server.register_money_parser(custom_parser)

        result = server.parse_price(150, network)
        assert result.asset == "0xCustomToken123456789012345678901234567890"

        result2 = server.parse_price(50, network)
        assert result2.asset == get_network_config(network)["default_asset"]["address"]

    def test_should_return_self_for_chaining(self):
        server = UptoEvmServerScheme()
        result = server.register_money_parser(lambda a, n: None)
        assert result is server
