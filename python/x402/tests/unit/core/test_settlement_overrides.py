"""Unit tests for settlement override amount resolution."""

from __future__ import annotations

from x402.http.x402_http_server_base import x402HTTPServerBase
from x402.schemas import PaymentRequirements


def _requirements(amount: str = "2000") -> PaymentRequirements:
    return PaymentRequirements(
        scheme="batch-settlement",
        network="eip155:8453",
        asset="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount=amount,
        pay_to="0x3333333333333333333333333333333333333333",
        max_timeout_seconds=60,
        extra={},
    )


class TestRawAtomicUnits:
    def test_passthrough(self):
        reqs = _requirements()
        assert x402HTTPServerBase.resolve_settlement_override_amount("1000", reqs) == "1000"

    def test_zero(self):
        reqs = _requirements()
        assert x402HTTPServerBase.resolve_settlement_override_amount("0", reqs) == "0"


class TestPercentFormat:
    def test_half(self):
        reqs = _requirements()
        assert x402HTTPServerBase.resolve_settlement_override_amount("50%", reqs) == "1000"

    def test_full(self):
        reqs = _requirements()
        assert x402HTTPServerBase.resolve_settlement_override_amount("100%", reqs) == "2000"

    def test_zero_percent(self):
        reqs = _requirements()
        assert x402HTTPServerBase.resolve_settlement_override_amount("0%", reqs) == "0"

    def test_quarter(self):
        reqs = _requirements()
        assert x402HTTPServerBase.resolve_settlement_override_amount("25%", reqs) == "500"

    def test_fractional_percent_floors(self):
        reqs = _requirements(amount="3000")
        assert x402HTTPServerBase.resolve_settlement_override_amount("33.33%", reqs) == "999"

    def test_single_decimal_percent(self):
        reqs = _requirements(amount="1000")
        assert x402HTTPServerBase.resolve_settlement_override_amount("10.5%", reqs) == "105"

    def test_seven_percent(self):
        reqs = _requirements(amount="10000")
        assert x402HTTPServerBase.resolve_settlement_override_amount("7%", reqs) == "700"


class TestDollarFormat:
    def test_one_dollar_default_decimals(self):
        reqs = _requirements()
        assert x402HTTPServerBase.resolve_settlement_override_amount("$1.00", reqs) == "1000000"

    def test_five_cents_default_decimals(self):
        reqs = _requirements()
        assert x402HTTPServerBase.resolve_settlement_override_amount("$0.05", reqs) == "50000"

    def test_five_cents_eight_decimals(self):
        reqs = _requirements()
        assert x402HTTPServerBase.resolve_settlement_override_amount("$0.05", reqs, 8) == "5000000"

    def test_fractional_dollar(self):
        reqs = _requirements()
        assert x402HTTPServerBase.resolve_settlement_override_amount("$0.001", reqs) == "1000"

    def test_zero_dollars(self):
        reqs = _requirements()
        assert x402HTTPServerBase.resolve_settlement_override_amount("$0", reqs) == "0"


class TestHttpSettlementOverrides:
    def test_apply_settlement_overrides_resolves_percent(self):
        from x402.http.types import PaymentOption, RouteConfig
        from x402.http.x402_http_server_base import x402HTTPServerBase
        from x402.mechanisms.evm.batch_settlement.server.scheme import BatchSettlementEvmScheme
        from x402.server import x402ResourceServerSync

        scheme = BatchSettlementEvmScheme("0x3333333333333333333333333333333333333333")
        server = x402ResourceServerSync()
        server.register("eip155:8453", scheme)
        http_server = x402HTTPServerBase(
            server,
            {
                "*": RouteConfig(
                    accepts=PaymentOption(
                        scheme="batch-settlement",
                        pay_to="0x3333333333333333333333333333333333333333",
                        price="10000",
                        network="eip155:8453",
                    )
                )
            },
        )
        requirements = _requirements(amount="10000")
        effective = http_server._apply_settlement_overrides(
            requirements,
            {"amount": "7%"},
        )
        assert effective.amount == "700"
