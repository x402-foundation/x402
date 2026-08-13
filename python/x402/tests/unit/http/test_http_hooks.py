"""Unit tests for HTTP protected-request hooks and middleware cancellation."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from x402 import x402ResourceServer
from x402.http.constants import PAYMENT_SIGNATURE_HEADER
from x402.http.types import (
    HTTPRequestContext,
    PaymentOption,
    RouteConfig,
)
from x402.http.utils import encode_payment_signature_header
from x402.http.x402_http_server import x402HTTPResourceServer
from x402.schemas import PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse
from x402.schemas.hooks import (
    AbortProtectedRequestResult,
    GrantAccessResult,
    SkipHandlerDirective,
    SkipHandlerResult,
)
from x402.schemas.payments import PaymentRequired
from x402.schemas.responses import SupportedKind, SupportedResponse


def make_requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x0000000000000000000000000000000000000000",
        amount="1000000",
        pay_to="0x1234567890123456789012345678901234567890",
        max_timeout_seconds=300,
    )


class MockHTTPAdapter:
    def get_header(self, name: str) -> str | None:
        return None

    def get_method(self) -> str:
        return "GET"

    def get_path(self) -> str:
        return "/api/protected"

    def get_url(self) -> str:
        return "https://example.com/api/protected"

    def get_accept_header(self) -> str:
        return "application/json"

    def get_user_agent(self) -> str:
        return "test-client"

    def get_query_params(self) -> dict[str, str]:
        return {}

    def get_query_param(self, name: str) -> str | None:
        return None

    def get_body(self):
        return None


@pytest.fixture
def protected_routes() -> dict[str, RouteConfig]:
    return {
        "GET /api/protected": RouteConfig(
            accepts=PaymentOption(
                scheme="exact",
                pay_to="0x1234567890123456789012345678901234567890",
                price="$0.01",
                network="eip155:8453",
            ),
        )
    }


class TestOnProtectedRequest:
    @pytest.mark.asyncio
    async def test_grant_access(self, protected_routes):
        server = MagicMock()
        http_server = x402HTTPResourceServer(server, protected_routes)
        http_server.on_protected_request(lambda _ctx, _cfg: GrantAccessResult())

        context = HTTPRequestContext(
            adapter=MockHTTPAdapter(),
            path="/api/protected",
            method="GET",
        )

        result = await http_server.process_http_request(context)

        assert result.type == "no-payment-required"

    @pytest.mark.asyncio
    async def test_abort(self, protected_routes):
        server = MagicMock()
        http_server = x402HTTPResourceServer(server, protected_routes)
        http_server.on_protected_request(
            lambda _ctx, _cfg: AbortProtectedRequestResult(reason="Access denied")
        )

        context = HTTPRequestContext(
            adapter=MockHTTPAdapter(),
            path="/api/protected",
            method="GET",
        )

        result = await http_server.process_http_request(context)

        assert result.type == "payment-error"
        assert result.response is not None
        assert result.response.status == 403
        assert result.response.body == {"error": "Access denied"}

    @pytest.mark.asyncio
    async def test_continue_to_payment_flow(self, protected_routes):
        server = MagicMock()
        server.enrich_extensions.side_effect = lambda declared, _ctx: declared
        requirements = [make_requirements()]

        async def mock_create_payment_required(
            _requirements, _resource, error, _extensions, **_kwargs
        ):
            return PaymentRequired(
                x402_version=2,
                error=error,
                accepts=requirements,
            )

        server.create_payment_required_response = AsyncMock(
            side_effect=mock_create_payment_required
        )
        http_server = x402HTTPResourceServer(server, protected_routes)
        http_server.on_protected_request(lambda _ctx, _cfg: None)

        context = HTTPRequestContext(
            adapter=MockHTTPAdapter(),
            path="/api/protected",
            method="GET",
        )

        with patch.object(
            x402HTTPResourceServer,
            "_build_payment_requirements_from_options",
            new=AsyncMock(return_value=[make_requirements()]),
        ):
            result = await http_server.process_http_request(context)

        assert result.type == "payment-error"
        assert result.response is not None
        assert result.response.status == 402


class MockFacilitatorClient:
    def __init__(self) -> None:
        self.verify_calls: list = []
        self.settle_calls: list = []

    def get_supported(self) -> SupportedResponse:
        return SupportedResponse(
            kinds=[
                SupportedKind(
                    x402_version=2,
                    scheme="exact",
                    network="eip155:8453",
                )
            ],
            extensions=[],
            signers={},
        )

    async def verify(self, payload, requirements) -> VerifyResponse:
        self.verify_calls.append((payload, requirements))
        return VerifyResponse(is_valid=True, payer="0xpayer")

    async def settle(self, payload, requirements) -> SettleResponse:
        self.settle_calls.append((payload, requirements))
        return SettleResponse(
            success=True,
            transaction="0xmock",
            network=requirements.network,
            payer="0xpayer",
        )


class TestSkipHandlerSettlement:
    @pytest.mark.asyncio
    async def test_settles_and_returns_skip_handler_response(self):
        client = MockFacilitatorClient()
        server = x402ResourceServer(client)
        server.initialize()
        server.on_after_verify(
            lambda _ctx: SkipHandlerResult(
                response=SkipHandlerDirective(
                    content_type="application/json",
                    body={"message": "Refund acknowledged"},
                )
            )
        )

        requirements = make_requirements()
        payload = PaymentPayload(payload={}, accepted=requirements)
        payment_header = encode_payment_signature_header(payload)

        routes = {
            "GET /api/refund": RouteConfig(
                accepts=PaymentOption(
                    scheme="exact",
                    pay_to="0x1234567890123456789012345678901234567890",
                    price="$0.01",
                    network="eip155:8453",
                ),
            )
        }
        http_server = x402HTTPResourceServer(server, routes)

        class RefundAdapter(MockHTTPAdapter):
            def get_path(self) -> str:
                return "/api/refund"

            def get_header(self, name: str) -> str | None:
                if name.lower() == PAYMENT_SIGNATURE_HEADER.lower():
                    return payment_header
                return None

        context = HTTPRequestContext(
            adapter=RefundAdapter(),
            path="/api/refund",
            method="GET",
        )

        with patch.object(
            x402HTTPResourceServer,
            "_build_payment_requirements_from_options",
            new=AsyncMock(return_value=[requirements]),
        ):
            result = await http_server.process_http_request(context)

        assert len(client.verify_calls) == 1
        assert len(client.settle_calls) == 1
        assert result.type == "payment-error"
        assert result.response is not None
        assert result.response.status == 200
        assert result.response.body == {"message": "Refund acknowledged"}
        assert "PAYMENT-RESPONSE" in result.response.headers
