"""Tests for the BIP-122 Lightning server scheme."""

import pytest

from x402.mechanisms.bip122 import (
    BTC_ASSET,
    BTC_MAINNET_CAIP2,
    PAY_TO_ANONYMOUS,
    PAYMENT_METHOD_LIGHTNING,
)
from x402.mechanisms.bip122.exact import ExactBip122ServerScheme
from x402.schemas import AssetAmount, PaymentRequirements, SupportedKind

from .helpers import InMemoryLightningReceiver


class TestParsePrice:
    """Test server-side price parsing."""

    def test_should_parse_sats_into_msats(self) -> None:
        server = ExactBip122ServerScheme(InMemoryLightningReceiver())

        result = server.parse_price("21 sat", BTC_MAINNET_CAIP2)

        assert result.amount == "21000"
        assert result.asset == BTC_ASSET
        assert result.extra == {}

    def test_should_support_fractional_sats(self) -> None:
        server = ExactBip122ServerScheme(InMemoryLightningReceiver())

        result = server.parse_price("0.5 sats", BTC_MAINNET_CAIP2)

        assert result.amount == "500"
        assert result.asset == BTC_ASSET

    def test_should_pass_through_btc_asset_amount(self) -> None:
        server = ExactBip122ServerScheme(InMemoryLightningReceiver())
        price = AssetAmount(amount="1234", asset=BTC_ASSET, extra={"unit": "msat"})

        result = server.parse_price(price, BTC_MAINNET_CAIP2)

        assert result == price

    def test_should_reject_non_btc_asset_amounts(self) -> None:
        server = ExactBip122ServerScheme(InMemoryLightningReceiver())

        with pytest.raises(ValueError, match="Lightning AssetAmount must use BTC"):
            server.parse_price({"amount": "1234", "asset": "USD"}, BTC_MAINNET_CAIP2)

    def test_should_use_custom_money_parser_before_default(self) -> None:
        server = ExactBip122ServerScheme(InMemoryLightningReceiver())

        def parser(amount: str | int | float, network: str) -> AssetAmount | None:
            assert network == BTC_MAINNET_CAIP2
            if amount == "$1":
                return AssetAmount(
                    amount="42000",
                    asset=BTC_ASSET,
                    extra={"source": "custom-parser"},
                )
            return None

        server.register_money_parser(parser)
        result = server.parse_price("$1", BTC_MAINNET_CAIP2)

        assert result.amount == "42000"
        assert result.extra == {"source": "custom-parser"}


class TestEnhancePaymentRequirements:
    """Test invoice generation and requirement normalization."""

    def test_should_generate_invoice_and_normalize_fields(self) -> None:
        receiver = InMemoryLightningReceiver()
        server = ExactBip122ServerScheme(receiver)
        requirements = PaymentRequirements(
            scheme="exact",
            network=BTC_MAINNET_CAIP2,
            asset="SHOULD_BE_OVERRIDDEN",
            amount="21000",
            pay_to="merchant-node-id",
            max_timeout_seconds=300,
            extra={"description": "premium endpoint", "trace": "abc123"},
        )
        supported_kind = SupportedKind(
            x402_version=2,
            scheme="exact",
            network=BTC_MAINNET_CAIP2,
            extra={"paymentMethod": PAYMENT_METHOD_LIGHTNING},
        )

        result = server.enhance_payment_requirements(requirements, supported_kind, [])

        assert result.asset == BTC_ASSET
        assert result.pay_to == PAY_TO_ANONYMOUS
        assert result.extra["paymentMethod"] == PAYMENT_METHOD_LIGHTNING
        assert "invoice" in result.extra
        assert result.extra["trace"] == "abc123"

        status = receiver.lookup_invoice(result.extra["invoice"], BTC_MAINNET_CAIP2)
        assert status is not None
        assert status.amount_msat == 21000
        assert status.status == "unpaid"

    def test_should_raise_if_receiver_returns_wrong_amount(self) -> None:
        class BadReceiver(InMemoryLightningReceiver):
            def create_invoice(
                self,
                amount_msat: int,
                memo: str,
                expiry_seconds: int,
                network: str,
            ) -> str:
                return super().create_invoice(
                    amount_msat=amount_msat + 1,
                    memo=memo,
                    expiry_seconds=expiry_seconds,
                    network=network,
                )

        server = ExactBip122ServerScheme(BadReceiver())
        requirements = PaymentRequirements(
            scheme="exact",
            network=BTC_MAINNET_CAIP2,
            asset=BTC_ASSET,
            amount="1000",
            pay_to="ignored",
            max_timeout_seconds=300,
            extra={},
        )
        supported_kind = SupportedKind(
            x402_version=2,
            scheme="exact",
            network=BTC_MAINNET_CAIP2,
            extra={},
        )

        with pytest.raises(ValueError, match="Receiver returned invoice with mismatched amount"):
            server.enhance_payment_requirements(requirements, supported_kind, [])
