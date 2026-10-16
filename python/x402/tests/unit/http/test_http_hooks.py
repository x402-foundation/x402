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
from x402.http.x402_http_server import x402HTTPResourceServer, x402HTTPResourceServerSync
from x402.schemas import PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse
from x402.schemas.hooks import (
    AbortProtectedRequestResult,
    GrantAccessResult,
    SkipHandlerDirective,
    SkipHandlerResult,
    SkipVerifyResult,
)
from x402.schemas.payments import PaymentRequired
from x402.schemas.responses import SupportedKind, SupportedResponse
from x402.server import x402ResourceServerSync


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
        class ExactScheme:
            scheme = "exact"
            default_asset_transfer_method = "default"
            payment_flows = {
                "default": {"supported": ("authorization",), "default": "authorization"},
            }

        client = MockFacilitatorClient()
        server = x402ResourceServer(client)
        server.register("eip155:8453", ExactScheme())
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


class SingleFlowExactScheme:
    scheme = "exact"
    default_asset_transfer_method = "default"

    def __init__(self, flow: str) -> None:
        self.payment_flows = {"default": {"supported": (flow,), "default": flow}}


class UnfundedFacilitatorClient(MockFacilitatorClient):
    async def settle(self, payload, requirements) -> SettleResponse:
        self.settle_calls.append((payload, requirements))
        return SettleResponse(
            success=False,
            error_reason="insufficient_funds",
            transaction="",
            network=requirements.network,
        )


class SyncMockFacilitatorClient(MockFacilitatorClient):
    def verify(self, payload, requirements) -> VerifyResponse:  # type: ignore[override]
        self.verify_calls.append((payload, requirements))
        return VerifyResponse(is_valid=True, payer="0xpayer")

    def settle(self, payload, requirements) -> SettleResponse:  # type: ignore[override]
        self.settle_calls.append((payload, requirements))
        return SettleResponse(
            success=True,
            transaction="0xmock",
            network=requirements.network,
            payer="0xpayer",
        )


class TestSkipHandlerBeforeHandlerSettlement:
    """`skipHandler` must settle like a normal request when the flow settles before the handler."""

    @staticmethod
    def _setup(server, flow: str):
        """Register hooks that skip verification and the handler; return routes, context, phases."""
        server.register("eip155:8453", SingleFlowExactScheme(flow))
        server.initialize()
        # Without verify-before-handler, afterVerify hooks only run after a beforeVerify skip.
        server.on_before_verify(
            lambda _ctx: SkipVerifyResult(result=VerifyResponse(is_valid=True, payer="0xpayer"))
        )
        server.on_after_verify(
            lambda _ctx: SkipHandlerResult(
                response=SkipHandlerDirective(body={"message": "skipped"})
            )
        )
        settle_phases: list[str] = []
        server.on_before_settle(lambda ctx: settle_phases.append(ctx.phase))

        requirements = make_requirements()
        payment_header = encode_payment_signature_header(
            PaymentPayload(payload={}, accepted=requirements)
        )

        class PaidAdapter(MockHTTPAdapter):
            def get_header(self, name: str) -> str | None:
                if name.lower() == PAYMENT_SIGNATURE_HEADER.lower():
                    return payment_header
                return None

        routes = {
            "GET /api/protected": RouteConfig(
                accepts=PaymentOption(
                    scheme="exact",
                    pay_to="0x1234567890123456789012345678901234567890",
                    price="$0.01",
                    network="eip155:8453",
                ),
            )
        }
        context = HTTPRequestContext(adapter=PaidAdapter(), path="/api/protected", method="GET")
        return requirements, routes, context, settle_phases

    async def _process(self, client: MockFacilitatorClient, flow: str = "upfront"):
        server = x402ResourceServer(client)
        requirements, routes, context, settle_phases = self._setup(server, flow)
        with patch.object(
            x402HTTPResourceServer,
            "_build_payment_requirements_from_options",
            new=AsyncMock(return_value=[requirements]),
        ):
            result = await x402HTTPResourceServer(server, routes).process_http_request(context)
        return result, settle_phases

    @pytest.mark.asyncio
    async def test_settles_upfront_before_returning_skip_response(self):
        client = MockFacilitatorClient()

        result, settle_phases = await self._process(client)

        assert len(client.settle_calls) == 1
        assert settle_phases == ["before-handler"]
        assert result.response is not None
        assert result.response.status == 200
        assert result.response.body == {"message": "skipped"}
        assert "PAYMENT-RESPONSE" in result.response.headers

    @pytest.mark.asyncio
    async def test_settles_both_escrow_phases_before_returning_skip_response(self):
        client = MockFacilitatorClient()

        result, settle_phases = await self._process(client, flow="escrow")

        assert len(client.settle_calls) == 2
        assert settle_phases == ["before-handler", "after-handler"]
        assert result.response is not None
        assert result.response.status == 200
        assert result.response.body == {"message": "skipped"}
        assert "PAYMENT-RESPONSE" in result.response.headers

    @pytest.mark.asyncio
    async def test_failed_settlement_does_not_release_skip_response(self):
        client = UnfundedFacilitatorClient()

        result, _ = await self._process(client)

        assert len(client.settle_calls) == 1
        assert result.response is not None
        assert result.response.status == 402
        assert result.response.body != {"message": "skipped"}

    def test_sync_server_settles_both_escrow_phases(self):
        client = SyncMockFacilitatorClient()
        server = x402ResourceServerSync(client)
        requirements, routes, context, settle_phases = self._setup(server, "escrow")

        with patch.object(
            x402HTTPResourceServerSync,
            "_build_payment_requirements_from_options_sync",
            return_value=[requirements],
        ):
            result = x402HTTPResourceServerSync(server, routes).process_http_request(context)

        assert len(client.settle_calls) == 2
        assert settle_phases == ["before-handler", "after-handler"]
        assert result.response is not None
        assert result.response.status == 200
        assert result.response.body == {"message": "skipped"}
