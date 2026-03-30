"""HTTP integration tests - parameterized for both sync and async classes.

These tests verify HTTP client/server integration. The same test logic
runs against both sync and async implementations using pytest parameterization.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import pytest

from x402 import (
    x402Client,
    x402ClientSync,
    x402Facilitator,
    x402FacilitatorSync,
    x402ResourceServer,
    x402ResourceServerSync,
)
from x402.http import (
    HTTPRequestContext,
    ProcessSettleResult,
    decode_payment_required_header,
    x402HTTPClient,
    x402HTTPClientSync,
    x402HTTPResourceServer,
    x402HTTPResourceServerSync,
)
from x402.schemas import Price

from ..mocks import (
    CashFacilitatorClient,
    CashFacilitatorClientSync,
    CashSchemeNetworkClient,
    CashSchemeNetworkFacilitator,
    CashSchemeNetworkServer,
)

if TYPE_CHECKING:
    pass


# =============================================================================
# Mock HTTP Adapter
# =============================================================================


class MockHTTPAdapter:
    """Mock HTTP adapter for testing."""

    def __init__(
        self,
        path: str,
        method: str,
        headers: dict[str, str] | None = None,
        query_params: dict[str, str] | None = None,
        body: dict | None = None,
    ) -> None:
        self._path = path
        self._method = method
        self._headers = {k.lower(): v for k, v in (headers or {}).items()}
        self._query_params = query_params or {}
        self._body = body or {}

    def get_header(self, name: str) -> str | None:
        return self._headers.get(name.lower())

    def get_method(self) -> str:
        return self._method

    def get_path(self) -> str:
        return self._path

    def get_url(self) -> str:
        query_string = (
            "?" + "&".join(f"{k}={v}" for k, v in self._query_params.items())
            if self._query_params
            else ""
        )
        return f"https://example.com{self._path}{query_string}"

    def get_accept_header(self) -> str:
        return self._headers.get("accept", "application/json")

    def get_user_agent(self) -> str:
        return self._headers.get("user-agent", "TestClient/1.0")

    def get_query_params(self) -> dict[str, str]:
        return self._query_params

    def get_query_param(self, name: str) -> str | None:
        return self._query_params.get(name)

    def get_body(self) -> dict:
        return self._body


# =============================================================================
# Test Fixture Types
# =============================================================================


@dataclass
class HTTPComponentsFixture:
    """Container for HTTP test components (sync or async versions)."""

    http_client: x402HTTPClient | x402HTTPClientSync
    http_server: x402HTTPResourceServer | x402HTTPResourceServerSync
    resource_server: x402ResourceServer | x402ResourceServerSync
    is_async: bool

    def process_http_request(self, context: HTTPRequestContext) -> Any:
        """Process HTTP request, handling sync/async uniformly."""
        if self.is_async:
            return asyncio.run(
                self.http_server.process_http_request(context)  # type: ignore
            )
        return self.http_server.process_http_request(context)  # type: ignore


def _create_sync_http_components(routes: dict) -> HTTPComponentsFixture:
    """Create sync HTTP test components."""
    facilitator = x402FacilitatorSync().register(
        ["x402:cash"],
        CashSchemeNetworkFacilitator(),
    )
    facilitator_client = CashFacilitatorClientSync(facilitator)

    payment_client = x402ClientSync().register(
        "x402:cash",
        CashSchemeNetworkClient("John"),
    )
    http_client = x402HTTPClientSync(payment_client)

    resource_server = x402ResourceServerSync(facilitator_client)
    resource_server.register("x402:cash", CashSchemeNetworkServer())
    resource_server.initialize()

    http_server = x402HTTPResourceServerSync(resource_server, routes)

    return HTTPComponentsFixture(
        http_client=http_client,
        http_server=http_server,
        resource_server=resource_server,
        is_async=False,
    )


def _create_async_http_components(routes: dict) -> HTTPComponentsFixture:
    """Create async HTTP test components."""
    facilitator = x402Facilitator().register(
        ["x402:cash"],
        CashSchemeNetworkFacilitator(),
    )
    facilitator_client = CashFacilitatorClient(facilitator)

    payment_client = x402Client().register(
        "x402:cash",
        CashSchemeNetworkClient("John"),
    )
    http_client = x402HTTPClient(payment_client)

    resource_server = x402ResourceServer(facilitator_client)
    resource_server.register("x402:cash", CashSchemeNetworkServer())
    resource_server.initialize()

    http_server = x402HTTPResourceServer(resource_server, routes)

    return HTTPComponentsFixture(
        http_client=http_client,
        http_server=http_server,
        resource_server=resource_server,
        is_async=True,
    )


# =============================================================================
# HTTP Integration Tests
# =============================================================================


class TestHTTPIntegration:
    """HTTP integration tests - run against both sync and async implementations."""

    @pytest.fixture(params=["sync", "async"])
    def components(self, request: pytest.FixtureRequest) -> HTTPComponentsFixture:
        """Fixture that provides both sync and async HTTP component sets."""
        routes = {
            "/api/protected": {
                "accepts": {
                    "scheme": "cash",
                    "payTo": "merchant@example.com",
                    "price": "$0.10",
                    "network": "x402:cash",
                },
                "description": "Access to protected API",
                "mimeType": "application/json",
            },
        }
        if request.param == "sync":
            return _create_sync_http_components(routes)
        return _create_async_http_components(routes)

    def test_middleware_verify_and_settle_cash_payment(
        self,
        components: HTTPComponentsFixture,
    ) -> None:
        """Test the full HTTP flow: 402 response, payment creation, retry, settlement."""
        # Initial request - no payment
        mock_adapter = MockHTTPAdapter(
            path="/api/protected",
            method="GET",
        )
        context = HTTPRequestContext(
            adapter=mock_adapter,
            path="/api/protected",
            method="GET",
        )

        # Should return 402
        result = components.process_http_request(context)
        assert result.type == "payment-error"
        assert result.response is not None
        assert result.response.status == 402
        assert "PAYMENT-REQUIRED" in result.response.headers
        assert result.response.is_html is False
        assert result.response.body == {}

        # Client parses 402 and creates payment
        payment_required = components.http_client.get_payment_required_response(
            lambda name: result.response.headers.get(name),
            result.response.body,
        )

        if components.is_async:
            payment_payload = asyncio.run(
                components.http_client.create_payment_payload(payment_required)  # type: ignore
            )
        else:
            payment_payload = components.http_client.create_payment_payload(  # type: ignore
                payment_required
            )

        request_headers = components.http_client.encode_payment_signature_header(payment_payload)

        # Retry with payment
        mock_adapter_with_payment = MockHTTPAdapter(
            path="/api/protected",
            method="GET",
            headers=request_headers,
        )
        context_with_payment = HTTPRequestContext(
            adapter=mock_adapter_with_payment,
            path="/api/protected",
            method="GET",
        )

        result2 = components.process_http_request(context_with_payment)
        assert result2.type == "payment-verified"
        assert result2.payment_payload is not None
        assert result2.payment_requirements is not None

        # Process settlement
        if components.is_async:
            settlement = asyncio.run(
                components.http_server.process_settlement(  # type: ignore
                    result2.payment_payload,
                    result2.payment_requirements,
                )
            )
        else:
            settlement = components.http_server.process_settlement(  # type: ignore
                result2.payment_payload,
                result2.payment_requirements,
            )
        assert settlement.success is True
        assert "PAYMENT-RESPONSE" in settlement.headers

    def test_no_payment_required_for_unprotected_route(
        self,
        components: HTTPComponentsFixture,
    ) -> None:
        """Test that unprotected routes don't require payment."""
        mock_adapter = MockHTTPAdapter(
            path="/api/unprotected",
            method="GET",
        )
        context = HTTPRequestContext(
            adapter=mock_adapter,
            path="/api/unprotected",
            method="GET",
        )

        result = components.process_http_request(context)
        assert result.type == "no-payment-required"


class TestDynamicPricing:
    """Tests for dynamic pricing - run against both sync and async implementations."""

    @pytest.fixture(params=["sync", "async"])
    def components_factory(self, request: pytest.FixtureRequest) -> type[HTTPComponentsFixture]:
        """Returns factory for creating components with custom routes."""

        class Factory:
            is_async = request.param == "async"

            @staticmethod
            def create(routes: dict) -> HTTPComponentsFixture:
                if request.param == "sync":
                    return _create_sync_http_components(routes)
                return _create_async_http_components(routes)

        return Factory  # type: ignore

    def test_route_option_extra_is_preserved(
        self,
        components_factory: Any,
    ) -> None:
        """Route-level extra should flow into built payment requirements."""
        routes = {
            "GET /api/permit2": {
                "accepts": {
                    "scheme": "cash",
                    "payTo": "merchant@example.com",
                    "price": "$0.10",
                    "network": "x402:cash",
                    "extra": {
                        "assetTransferMethod": "permit2",
                        "merchantNote": "route-level-extra",
                    },
                },
            },
        }

        components = components_factory.create(routes)
        adapter = MockHTTPAdapter(
            path="/api/permit2",
            method="GET",
        )
        context = HTTPRequestContext(
            adapter=adapter,
            path="/api/permit2",
            method="GET",
        )

        result = components.process_http_request(context)
        payment_required = decode_payment_required_header(
            result.response.headers["PAYMENT-REQUIRED"]
        )

        assert payment_required.accepts[0].extra is not None
        assert payment_required.accepts[0].extra["assetTransferMethod"] == "permit2"
        assert payment_required.accepts[0].extra["merchantNote"] == "route-level-extra"

    def test_dynamic_price_from_query_params(
        self,
        components_factory: Any,
    ) -> None:
        """Test that price can be dynamically computed from query params."""

        def dynamic_price(context: HTTPRequestContext) -> Price:
            tier = context.adapter.get_query_param("tier")
            if tier == "premium":
                return "$0.01"
            if tier == "business":
                return "$0.05"
            return "$0.10"

        routes = {
            "GET /api/data": {
                "accepts": {
                    "scheme": "cash",
                    "network": "x402:cash",
                    "payTo": "merchant@example.com",
                    "price": dynamic_price,
                },
                "description": "Tiered API access",
            },
        }

        components = components_factory.create(routes)

        # Test premium tier
        premium_adapter = MockHTTPAdapter(
            path="/api/data",
            method="GET",
            query_params={"tier": "premium"},
        )
        premium_context = HTTPRequestContext(
            adapter=premium_adapter,
            path="/api/data",
            method="GET",
        )
        result = components.process_http_request(premium_context)
        assert result.type == "payment-error"
        payment_required = decode_payment_required_header(
            result.response.headers["PAYMENT-REQUIRED"]
        )
        assert payment_required.accepts[0].amount == "0.01"

        # Test business tier
        business_adapter = MockHTTPAdapter(
            path="/api/data",
            method="GET",
            query_params={"tier": "business"},
        )
        business_context = HTTPRequestContext(
            adapter=business_adapter,
            path="/api/data",
            method="GET",
        )
        result2 = components.process_http_request(business_context)
        payment_required2 = decode_payment_required_header(
            result2.response.headers["PAYMENT-REQUIRED"]
        )
        assert payment_required2.accepts[0].amount == "0.05"

        # Test default tier
        default_adapter = MockHTTPAdapter(
            path="/api/data",
            method="GET",
        )
        default_context = HTTPRequestContext(
            adapter=default_adapter,
            path="/api/data",
            method="GET",
        )
        result3 = components.process_http_request(default_context)
        payment_required3 = decode_payment_required_header(
            result3.response.headers["PAYMENT-REQUIRED"]
        )
        assert payment_required3.accepts[0].amount == "0.10"

    def test_dynamic_pay_to_from_headers(
        self,
        components_factory: Any,
    ) -> None:
        """Test that payTo can be dynamically computed from headers."""

        def dynamic_pay_to(context: HTTPRequestContext) -> str:
            region = context.adapter.get_header("x-region")
            addresses = {
                "us": "merchant-us@example.com",
                "eu": "merchant-eu@example.com",
                "asia": "merchant-asia@example.com",
            }
            return addresses.get(region or "us", "merchant-default@example.com")

        routes = {
            "POST /api/process": {
                "accepts": {
                    "scheme": "cash",
                    "network": "x402:cash",
                    "price": "$0.50",
                    "payTo": dynamic_pay_to,
                },
                "description": "Regional payment routing",
            },
        }

        components = components_factory.create(routes)

        # Test US region
        us_adapter = MockHTTPAdapter(
            path="/api/process",
            method="POST",
            headers={"x-region": "us"},
        )
        us_context = HTTPRequestContext(
            adapter=us_adapter,
            path="/api/process",
            method="POST",
        )
        result = components.process_http_request(us_context)
        payment_required = decode_payment_required_header(
            result.response.headers["PAYMENT-REQUIRED"]
        )
        assert payment_required.accepts[0].pay_to == "merchant-us@example.com"

        # Test EU region
        eu_adapter = MockHTTPAdapter(
            path="/api/process",
            method="POST",
            headers={"x-region": "eu"},
        )
        eu_context = HTTPRequestContext(
            adapter=eu_adapter,
            path="/api/process",
            method="POST",
        )
        result2 = components.process_http_request(eu_context)
        payment_required2 = decode_payment_required_header(
            result2.response.headers["PAYMENT-REQUIRED"]
        )
        assert payment_required2.accepts[0].pay_to == "merchant-eu@example.com"

    def test_combined_dynamic_pricing_and_pay_to(
        self,
        components_factory: Any,
    ) -> None:
        """Test that both price and payTo can be dynamic."""

        def dynamic_pay_to(context: HTTPRequestContext) -> str:
            source = context.adapter.get_query_param("source")
            if source == "blockchain":
                return "blockchain-provider@example.com"
            if source == "market":
                return "market-data-provider@example.com"
            return "default-provider@example.com"

        def dynamic_price(context: HTTPRequestContext) -> Price:
            subscription = context.adapter.get_header("x-subscription")
            range_param = context.adapter.get_query_param("range") or "1d"

            base_price = 0.1 if subscription == "pro" else 0.5

            range_multipliers = {
                "1d": 1,
                "7d": 3,
                "30d": 10,
                "1y": 50,
            }

            multiplier = range_multipliers.get(range_param, 1)
            final_price = base_price * multiplier

            return f"${final_price:.2f}"

        routes = {
            "GET /api/premium-data": {
                "accepts": {
                    "scheme": "cash",
                    "network": "x402:cash",
                    "payTo": dynamic_pay_to,
                    "price": dynamic_price,
                },
                "description": "Premium data API with complex pricing",
            },
        }

        components = components_factory.create(routes)

        # Pro subscription, 30-day data, blockchain source
        adapter = MockHTTPAdapter(
            path="/api/premium-data",
            method="GET",
            headers={"x-subscription": "pro"},
            query_params={"source": "blockchain", "range": "30d"},
        )
        context = HTTPRequestContext(
            adapter=adapter,
            path="/api/premium-data",
            method="GET",
        )
        result = components.process_http_request(context)
        payment_required = decode_payment_required_header(
            result.response.headers["PAYMENT-REQUIRED"]
        )

        assert payment_required.accepts[0].pay_to == "blockchain-provider@example.com"
        assert payment_required.accepts[0].amount == "1.00"  # 0.1 * 10

        # Free subscription, 7-day data, market source
        free_adapter = MockHTTPAdapter(
            path="/api/premium-data",
            method="GET",
            headers={"x-subscription": "free"},
            query_params={"source": "market", "range": "7d"},
        )
        free_context = HTTPRequestContext(
            adapter=free_adapter,
            path="/api/premium-data",
            method="GET",
        )
        result2 = components.process_http_request(free_context)
        payment_required2 = decode_payment_required_header(
            result2.response.headers["PAYMENT-REQUIRED"]
        )

        assert payment_required2.accepts[0].pay_to == "market-data-provider@example.com"
        assert payment_required2.accepts[0].amount == "1.50"  # 0.5 * 3


class TestSettlementFailureWithContext:
    """Regression test: _build_settlement_failure_response must unpack the tuple
    from _get_route_config (which returns tuple[RouteConfig, str] | None).

    Before the fix, passing a context that matched a route would raise
    AttributeError because the code accessed .settlement_failed_response_body
    on the tuple instead of unpacking it first.
    """

    @pytest.fixture(params=["sync", "async"])
    def components_factory(self, request: pytest.FixtureRequest) -> type[HTTPComponentsFixture]:
        """Returns factory for creating components with custom routes."""

        class Factory:
            @staticmethod
            def create(routes: dict) -> HTTPComponentsFixture:
                if request.param == "sync":
                    return _create_sync_http_components(routes)
                return _create_async_http_components(routes)

        return Factory  # type: ignore

    def test_settlement_failure_with_route_context_does_not_raise(
        self,
        components_factory: Any,
    ) -> None:
        """_build_settlement_failure_response should not crash when context matches a route."""
        routes = {
            "GET /api/protected": {
                "accepts": {
                    "scheme": "cash",
                    "payTo": "merchant@example.com",
                    "price": "$0.10",
                    "network": "x402:cash",
                },
                "description": "Protected endpoint",
            },
        }
        components = components_factory.create(routes)

        adapter = MockHTTPAdapter(path="/api/protected", method="GET")
        context = HTTPRequestContext(adapter=adapter, path="/api/protected", method="GET")

        failure = ProcessSettleResult(
            success=False,
            error_reason="test failure",
            headers={"PAYMENT-RESPONSE": "encoded"},
        )

        # Directly call the internal method to exercise the tuple-unpacking fix.
        # Before the fix, this would raise AttributeError on the tuple.
        response = components.http_server._build_settlement_failure_response(failure, context)

        assert response.status == 402
        assert response.body == {}
        assert "PAYMENT-RESPONSE" in response.headers


class TestColonParamRouteMatching:
    """Tests that :param (Express-style) route patterns match requests correctly."""

    @pytest.fixture(params=["sync", "async"])
    def components_factory(self, request: pytest.FixtureRequest) -> type[HTTPComponentsFixture]:
        class Factory:
            @staticmethod
            def create(routes: dict) -> HTTPComponentsFixture:
                if request.param == "sync":
                    return _create_sync_http_components(routes)
                return _create_async_http_components(routes)

        return Factory  # type: ignore

    def test_colon_param_route_matches_request(
        self,
        components_factory: Any,
    ) -> None:
        """Routes configured with :param syntax should match concrete requests."""
        routes = {
            "GET /api/users/:userId": {
                "accepts": {
                    "scheme": "cash",
                    "payTo": "merchant@example.com",
                    "price": "$0.10",
                    "network": "x402:cash",
                },
            },
        }
        components = components_factory.create(routes)

        adapter = MockHTTPAdapter(path="/api/users/123", method="GET")
        context = HTTPRequestContext(adapter=adapter, path="/api/users/123", method="GET")

        result = components.process_http_request(context)
        assert result.type == "payment-error"
        assert result.response.status == 402

    def test_colon_param_multiple_segments(
        self,
        components_factory: Any,
    ) -> None:
        """Multiple :param segments should all be matched."""
        routes = {
            "GET /api/users/:userId/posts/:postId": {
                "accepts": {
                    "scheme": "cash",
                    "payTo": "merchant@example.com",
                    "price": "$0.10",
                    "network": "x402:cash",
                },
            },
        }
        components = components_factory.create(routes)

        adapter = MockHTTPAdapter(path="/api/users/42/posts/7", method="GET")
        context = HTTPRequestContext(adapter=adapter, path="/api/users/42/posts/7", method="GET")

        result = components.process_http_request(context)
        assert result.type == "payment-error"
        assert result.response.status == 402

    def test_colon_param_no_match_for_different_path(
        self,
        components_factory: Any,
    ) -> None:
        """:param routes should not match structurally different paths."""
        routes = {
            "GET /api/users/:userId": {
                "accepts": {
                    "scheme": "cash",
                    "payTo": "merchant@example.com",
                    "price": "$0.10",
                    "network": "x402:cash",
                },
            },
        }
        components = components_factory.create(routes)

        adapter = MockHTTPAdapter(path="/api/posts/123", method="GET")
        context = HTTPRequestContext(adapter=adapter, path="/api/posts/123", method="GET")

        result = components.process_http_request(context)
        assert result.type == "no-payment-required"
