"""Tests for the exact TVM server scheme."""

from __future__ import annotations

import pytest

pytest.importorskip("pytoniq_core")

from x402.mechanisms.tvm import (
    TVM_MAINNET,
    TVM_TESTNET,
    USDT_MAINNET_MINTER,
    USDT_TESTNET_MINTER,
)
from x402.mechanisms.tvm.exact import ExactTvmServerScheme
from x402.schemas import AssetAmount, SupportedKind

from .builders import EMPTY_FORWARD_PAYLOAD_B64, make_tvm_requirements

ZERO_BIT_PAYLOAD_B64 = EMPTY_FORWARD_PAYLOAD_B64


def _make_requirements(**overrides):
    return make_tvm_requirements(
        asset=overrides.pop("asset", USDT_TESTNET_MINTER),
        pay_to=overrides.pop("pay_to", USDT_TESTNET_MINTER),
        **overrides,
    )


class TestParsePrice:
    """Test parse_price."""

    class TestMainnetNetwork:
        @pytest.mark.parametrize(
            ("price", "amount"),
            [
                pytest.param("$0.10", "100000", id="dollar-string"),
                pytest.param("0.10", "100000", id="plain-string"),
                pytest.param(0.1, "100000", id="float"),
                pytest.param(1, "1000000", id="int"),
            ],
        )
        def test_should_parse_prices_against_default_mainnet_usdt(self, price, amount):
            server = ExactTvmServerScheme()
            result = server.parse_price(price, TVM_MAINNET)

            assert result.amount == amount
            assert result.asset == USDT_MAINNET_MINTER
            assert result.extra == {
                "areFeesSponsored": True,
                "forwardPayload": ZERO_BIT_PAYLOAD_B64,
                "forwardTonAmount": "0",
            }

    class TestTestnetNetwork:
        def test_should_use_testnet_default_asset(self):
            server = ExactTvmServerScheme()

            result = server.parse_price("$0.001", TVM_TESTNET)

            assert result.amount == "1000"
            assert result.asset == USDT_TESTNET_MINTER

    class TestPreParsedPriceObjects:
        def test_should_preserve_preparsed_dict_price(self):
            server = ExactTvmServerScheme()

            result = server.parse_price(
                {
                    "amount": "123456",
                    "asset": "0:" + "1" * 64,
                    "extra": {"foo": "bar"},
                },
                TVM_MAINNET,
            )

            assert result.amount == "123456"
            assert result.asset == "0:" + "1" * 64
            assert result.extra == {"foo": "bar"}

        def test_should_preserve_asset_amount_instance(self):
            server = ExactTvmServerScheme()

            result = server.parse_price(
                AssetAmount(
                    amount="42",
                    asset="0:" + "2" * 64,
                    extra={"token": "CUSTOM"},
                ),
                TVM_TESTNET,
            )

            assert result.amount == "42"
            assert result.asset == "0:" + "2" * 64
            assert result.extra == {"token": "CUSTOM"}

        @pytest.mark.parametrize("price", [{"amount": "1"}, AssetAmount(amount="1", asset="")])
        def test_should_reject_passthrough_price_without_asset(self, price):
            server = ExactTvmServerScheme()

            with pytest.raises(ValueError, match="Asset address required"):
                server.parse_price(price, TVM_MAINNET)

    class TestCustomMoneyParsers:
        def test_should_use_custom_money_parser_before_default_conversion(self):
            server = ExactTvmServerScheme()

            def custom_parser(amount: float, network: str) -> AssetAmount | None:
                assert network == TVM_MAINNET
                if amount >= 100:
                    return AssetAmount(
                        amount="999",
                        asset="0:" + "9" * 64,
                        extra={"tier": "large"},
                    )
                return None

            server.register_money_parser(custom_parser)

            large = server.parse_price(100, TVM_MAINNET)
            small = server.parse_price(1, TVM_MAINNET)

            assert large.amount == "999"
            assert large.asset == "0:" + "9" * 64
            assert large.extra == {"tier": "large"}
            assert small.asset == USDT_MAINNET_MINTER
            assert small.amount == "1000000"

        def test_should_not_call_custom_parser_for_passthrough_price_objects(self):
            server = ExactTvmServerScheme()
            parser_called = False

            def tracking_parser(amount: float, network: str) -> AssetAmount | None:
                nonlocal parser_called
                parser_called = True
                return None

            server.register_money_parser(tracking_parser)

            server.parse_price(
                AssetAmount(amount="123", asset="0:" + "4" * 64),
                TVM_MAINNET,
            )

            assert parser_called is False

    class TestErrorCases:
        def test_should_raise_when_network_has_no_default_asset(self):
            server = ExactTvmServerScheme()

            with pytest.raises(ValueError, match="No default stablecoin configured"):
                server.parse_price("1.00", "tvm:123")


class TestEnhancePaymentRequirements:
    """Test enhance_payment_requirements."""

    class TestDefaultAssetNormalization:
        def test_should_set_default_asset_and_normalize_decimal_amount(self):
            server = ExactTvmServerScheme()

            result = server.enhance_payment_requirements(
                _make_requirements(
                    asset="",
                    amount="1.5",
                    pay_to="EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
                    extra={},
                ),
                SupportedKind(
                    x402_version=2,
                    scheme="exact",
                    network=TVM_TESTNET,
                    extra={"areFeesSponsored": False},
                ),
                [],
            )

            assert result.asset == USDT_TESTNET_MINTER
            assert result.amount == "1500000"
            assert result.pay_to == "0:" + "0" * 64
            assert result.extra == {"areFeesSponsored": False}

        def test_should_preserve_existing_extra_fields_and_normalize_response_destination(self):
            server = ExactTvmServerScheme()

            result = server.enhance_payment_requirements(
                _make_requirements(
                    extra={
                        "custom": "value",
                        "areFeesSponsored": True,
                        "responseDestination": "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
                    }
                ),
                SupportedKind(x402_version=2, scheme="exact", network=TVM_TESTNET),
                [],
            )

            assert result.extra == {
                "custom": "value",
                "areFeesSponsored": True,
                "responseDestination": "0:" + "0" * 64,
            }

    class TestCustomAssets:
        def test_should_raise_when_custom_asset_decimal_amount_has_no_decimals_metadata(self):
            server = ExactTvmServerScheme()

            with pytest.raises(
                ValueError, match="provide amount in atomic units or extra.decimals"
            ):
                server.enhance_payment_requirements(
                    _make_requirements(
                        asset="0:" + "8" * 64,
                        amount="1.25",
                        extra={},
                    ),
                    SupportedKind(x402_version=2, scheme="exact", network=TVM_TESTNET),
                    [],
                )

        def test_should_use_extra_decimals_for_custom_assets(self):
            server = ExactTvmServerScheme()

            result = server.enhance_payment_requirements(
                _make_requirements(
                    asset="0:" + "8" * 64,
                    amount="1.25",
                    extra={"decimals": 9},
                ),
                SupportedKind(x402_version=2, scheme="exact", network=TVM_TESTNET),
                [],
            )

            assert result.amount == "1250000000"

    class TestInternalHelpers:
        def test_get_default_asset_should_raise_for_unknown_network(self):
            server = ExactTvmServerScheme()

            with pytest.raises(ValueError, match="No default stablecoin configured"):
                server._get_default_asset("tvm:123")

        def test_get_asset_decimals_should_return_default_for_usdt(self):
            server = ExactTvmServerScheme()

            assert server._get_asset_decimals(_make_requirements(network=TVM_TESTNET)) == 6


class TestRegisterMoneyParser:
    """Test register_money_parser."""

    def test_should_return_self_for_chaining(self):
        server = ExactTvmServerScheme()

        result = server.register_money_parser(lambda amount, network: None)

        assert result is server
