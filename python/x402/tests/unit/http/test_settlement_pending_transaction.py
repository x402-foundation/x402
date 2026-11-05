"""Tests that a settlement_pending failure (broadcast succeeded, receipt unconfirmed)
keeps its transaction hash over the wire so the caller can reconcile onchain.
"""

from __future__ import annotations

import pytest

from x402.http.types import PaymentOption, RouteConfig
from x402.http.utils import decode_payment_response_header
from x402.http.x402_http_server_base import x402HTTPServerBase
from x402.schemas import PaymentRequirements, SettleResponse
from x402.schemas.errors import SettleError


class _FakeResourceServer:
    def __init__(self, settle_result: SettleResponse | Exception) -> None:
        self._settle_result = settle_result

    def settle_payment(self, *args, **kwargs) -> SettleResponse:
        if isinstance(self._settle_result, Exception):
            raise self._settle_result
        return self._settle_result


def _requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x0000000000000000000000000000000000000001",
        amount="1000",
        pay_to="0x0000000000000000000000000000000000000002",
        max_timeout_seconds=60,
        extra={},
    )


def _route_config() -> RouteConfig:
    return RouteConfig(
        accepts=PaymentOption(
            scheme="exact",
            pay_to="0xpay",
            price="$0.01",
            network="eip155:8453",
        )
    )


def test_settlement_pending_keeps_transaction_from_direct_response():
    server = _FakeResourceServer(
        SettleResponse(
            success=False,
            error_reason="settlement_pending",
            transaction="0xpendingtx",
            network="eip155:8453",
        )
    )
    http_server = x402HTTPServerBase(server, {"*": _route_config()})  # type: ignore[arg-type]

    result = http_server.process_settlement(
        payment_payload=None,  # type: ignore[arg-type]
        requirements=_requirements(),
    )

    assert result.success is False
    assert result.transaction == "0xpendingtx"
    decoded = decode_payment_response_header(result.headers["PAYMENT-RESPONSE"])
    assert decoded.transaction == "0xpendingtx"


def test_settlement_pending_keeps_transaction_from_thrown_settle_error():
    server = _FakeResourceServer(
        SettleError(
            reason="settlement_pending",
            transaction="0xpendingtx",
        )
    )
    http_server = x402HTTPServerBase(server, {"*": _route_config()})  # type: ignore[arg-type]

    result = http_server.process_settlement(
        payment_payload=None,  # type: ignore[arg-type]
        requirements=_requirements(),
    )

    assert result.success is False
    assert result.transaction == "0xpendingtx"
    decoded = decode_payment_response_header(result.headers["PAYMENT-RESPONSE"])
    assert decoded.transaction == "0xpendingtx"


@pytest.mark.parametrize("as_error", [False, True], ids=["returned", "thrown"])
def test_settlement_failure_keeps_validated_response_fields(as_error):
    response = SettleResponse(
        success=False,
        error_reason="settlement_pending",
        error_message="Confirmation timed out",
        transaction="0xpendingtx",
        network="eip155:1",
        payer="0xpayer",
        amount="42",
        extensions={"terms": {"info": {"format": "uri"}}},
        extra={"status": "pending"},
        extension_responses={"bazaar": {"status": "processing"}},
    )
    error = SettleError(
        reason=response.error_reason, transaction=response.transaction, response=response
    )
    server = _FakeResourceServer(error if as_error else response)
    http_server = x402HTTPServerBase(server, {"*": _route_config()})  # type: ignore[arg-type]

    result = http_server.process_settlement(None, _requirements())  # type: ignore[arg-type]

    assert result.success is False
    assert result.network == response.network
    assert result.settle_response.model_dump() == response.model_dump()
    assert result.settle_response.extension_responses == response.extension_responses
    decoded = decode_payment_response_header(result.headers["PAYMENT-RESPONSE"])
    assert decoded.model_dump() == response.model_dump()
    assert decoded.extension_responses is None
