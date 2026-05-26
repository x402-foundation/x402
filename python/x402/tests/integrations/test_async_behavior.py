"""Async-specific behavior tests.

These tests verify behavior that is ONLY relevant to async implementations:
- Hooks that perform actual async work (await, sleep)
- Timeout handling for slow hooks
- Mixing sync and async hooks in the async class
- Concurrent operations

The core payment flow logic is tested in test_payment_flow.py and
test_http_integration.py against both sync and async implementations.
"""

import asyncio

import pytest

from x402 import x402Client, x402Facilitator, x402ResourceServer
from x402.http import (
    HTTPRequestContext,
    decode_payment_required_header,
    x402HTTPClient,
    x402HTTPResourceServer,
)
from x402.schemas import ResourceInfo

from ..mocks import (
    CashFacilitatorClient,
    CashSchemeNetworkClient,
    CashSchemeNetworkFacilitator,
    CashSchemeNetworkServer,
    build_cash_payment_requirements,
)


class MockHTTPAdapter:
    """Minimal mock HTTP adapter for async tests."""

    def __init__(
        self,
        path: str = "/",
        method: str = "GET",
        query_params: dict | None = None,
        headers: dict | None = None,
    ):
        self.path = path
        self.method = method
        self._query_params = query_params or {}
        self._headers = headers or {}

    def get_header(self, name: str) -> str | None:
        return self._headers.get(name.lower())

    def get_method(self) -> str:
        return self.method

    def get_path(self) -> str:
        return self.path

    def get_url(self) -> str:
        return f"https://example.com{self.path}"

    def get_accept_header(self) -> str:
        return "application/json"

    def get_user_agent(self) -> str:
        return "Test"

    def get_query_params(self) -> dict:
        return self._query_params

    def get_query_param(self, name: str) -> str | None:
        return self._query_params.get(name)

    def get_body(self):
        return None


# =============================================================================
# Async HTTP Hooks - Price Resolution and Timeouts
# =============================================================================


class TestAsyncHTTPHooks:
    """Tests for async HTTP hooks - async-only behavior."""

    def setup_method(self) -> None:
        """Set up async test fixtures."""
        self.facilitator = x402Facilitator().register(["x402:cash"], CashSchemeNetworkFacilitator())
        facilitator_client = CashFacilitatorClient(self.facilitator)
        self.resource_server = x402ResourceServer(facilitator_client)
        self.resource_server.register("x402:cash", CashSchemeNetworkServer())
        self.resource_server.initialize()

    def test_async_price_hook_performs_actual_async_work(self) -> None:
        """Test that price hook can perform truly asynchronous operations."""

        async def slow_price(context: HTTPRequestContext) -> str:
            # Simulate async operation (e.g., fetch from external service)
            await asyncio.sleep(0.1)
            return "$5.00"

        routes = {
            "GET /test": {
                "accepts": {
                    "scheme": "cash",
                    "network": "x402:cash",
                    "payTo": "merchant@example.com",
                    "price": slow_price,
                }
            }
        }
        http_server = x402HTTPResourceServer(self.resource_server, routes)
        context = HTTPRequestContext(
            adapter=MockHTTPAdapter(path="/test"), path="/test", method="GET"
        )

        result = asyncio.run(http_server.process_http_request(context))
        assert result.type == "payment-error"
        payment_required = decode_payment_required_header(
            result.response.headers["PAYMENT-REQUIRED"]
        )
        assert payment_required.accepts[0].amount == "5.00"

    def test_hook_timeout_configured_per_route(self) -> None:
        """Test that slow hooks are timed out when timeout is configured."""

        async def infinite_loop_hook(context: HTTPRequestContext) -> str:
            await asyncio.sleep(10)  # Much longer than configured timeout
            return "$1.00"

        routes = {
            "GET /timeout": {
                "accepts": {
                    "scheme": "cash",
                    "network": "x402:cash",
                    "payTo": "m@e.com",
                    "price": infinite_loop_hook,
                },
                "hook_timeout_seconds": 0.5,  # Explicit timeout
            }
        }
        http_server = x402HTTPResourceServer(self.resource_server, routes)
        context = HTTPRequestContext(
            adapter=MockHTTPAdapter(path="/timeout"), path="/timeout", method="GET"
        )

        result = asyncio.run(http_server.process_http_request(context))
        assert result.type == "payment-error"
        assert result.response.status == 500
        assert "timed out" in result.response.body["error"].lower()

    def test_custom_timeout_shorter_than_hook(self) -> None:
        """Test custom timeout causes hook to fail when hook is slower."""

        async def slow_hook(context: HTTPRequestContext) -> str:
            await asyncio.sleep(0.5)  # 0.5 seconds
            return "$1.00"

        routes = {
            "GET /custom-timeout": {
                "accepts": {
                    "scheme": "cash",
                    "network": "x402:cash",
                    "payTo": "m@e.com",
                    "price": slow_hook,
                },
                "hook_timeout_seconds": 0.2,  # Shorter than hook duration
            }
        }
        http_server = x402HTTPResourceServer(self.resource_server, routes)
        context = HTTPRequestContext(
            adapter=MockHTTPAdapter(path="/custom-timeout"),
            path="/custom-timeout",
            method="GET",
        )

        result = asyncio.run(http_server.process_http_request(context))
        assert result.type == "payment-error"
        assert result.response.status == 500
        assert "timed out" in result.response.body["error"].lower()

    def test_sync_hook_in_async_server_backward_compatible(self) -> None:
        """Test that synchronous hooks still work in async server (backward compat)."""

        def sync_price(context: HTTPRequestContext) -> str:
            return "$3.00"

        def sync_pay_to(context: HTTPRequestContext) -> str:
            return "sync-merchant@example.com"

        routes = {
            "GET /sync": {
                "accepts": {
                    "scheme": "cash",
                    "network": "x402:cash",
                    "payTo": sync_pay_to,
                    "price": sync_price,
                }
            }
        }
        http_server = x402HTTPResourceServer(self.resource_server, routes)
        context = HTTPRequestContext(
            adapter=MockHTTPAdapter(path="/sync"), path="/sync", method="GET"
        )

        result = asyncio.run(http_server.process_http_request(context))
        assert result.type == "payment-error"
        payment_required = decode_payment_required_header(
            result.response.headers["PAYMENT-REQUIRED"]
        )
        assert payment_required.accepts[0].amount == "3.00"
        assert payment_required.accepts[0].pay_to == "sync-merchant@example.com"

    def test_mixed_sync_async_hooks_in_same_route(self) -> None:
        """Test mixing sync and async hooks in the same route."""

        async def async_price(context: HTTPRequestContext) -> str:
            await asyncio.sleep(0.05)
            return "$2.50"

        def sync_pay_to(context: HTTPRequestContext) -> str:
            return "mixed@example.com"

        routes = {
            "GET /mixed": {
                "accepts": {
                    "scheme": "cash",
                    "network": "x402:cash",
                    "payTo": sync_pay_to,
                    "price": async_price,
                }
            }
        }
        http_server = x402HTTPResourceServer(self.resource_server, routes)
        context = HTTPRequestContext(
            adapter=MockHTTPAdapter(path="/mixed"), path="/mixed", method="GET"
        )

        result = asyncio.run(http_server.process_http_request(context))
        assert result.type == "payment-error"
        payment_required = decode_payment_required_header(
            result.response.headers["PAYMENT-REQUIRED"]
        )
        assert payment_required.accepts[0].amount == "2.50"
        assert payment_required.accepts[0].pay_to == "mixed@example.com"

    def test_async_hook_exception_handled_gracefully(self) -> None:
        """Test that hooks raising exceptions are handled gracefully."""

        async def failing_hook(context: HTTPRequestContext) -> str:
            await asyncio.sleep(0.01)  # Some async work first
            raise ValueError("Intentional error for testing")

        routes = {
            "GET /error": {
                "accepts": {
                    "scheme": "cash",
                    "network": "x402:cash",
                    "payTo": "m@e.com",
                    "price": failing_hook,
                },
            }
        }
        http_server = x402HTTPResourceServer(self.resource_server, routes)
        context = HTTPRequestContext(
            adapter=MockHTTPAdapter(path="/error"), path="/error", method="GET"
        )

        result = asyncio.run(http_server.process_http_request(context))
        assert result.type == "payment-error"
        assert result.response.status == 500
        # Error message should be sanitized (not expose internal details)
        assert "Failed to process request" in result.response.body["error"]


# =============================================================================
# Async Core Client Hooks
# =============================================================================


class TestAsyncClientHooks:
    """Tests for async hooks in x402Client."""

    def setup_method(self) -> None:
        """Set up async test fixtures."""
        self.facilitator = x402Facilitator().register(["x402:cash"], CashSchemeNetworkFacilitator())
        facilitator_client = CashFacilitatorClient(self.facilitator)
        self.server = x402ResourceServer(facilitator_client)
        self.server.register("x402:cash", CashSchemeNetworkServer())
        self.server.initialize()

    @pytest.mark.asyncio
    async def test_async_after_payment_creation_hook(self) -> None:
        """Test that truly async hooks work in client."""
        hook_called = False
        hook_delay_completed = False

        async def async_after_hook(context) -> None:
            nonlocal hook_called, hook_delay_completed
            hook_called = True
            await asyncio.sleep(0.1)  # Simulate async work
            hook_delay_completed = True

        client = (
            x402Client()
            .register("x402:cash", CashSchemeNetworkClient("HookTest"))
            .on_after_payment_creation(async_after_hook)
        )

        accepts = [build_cash_payment_requirements("Test", "USD", "1")]
        payment_required = await self.server.create_payment_required_response(accepts)

        await client.create_payment_payload(payment_required)

        assert hook_called is True
        assert hook_delay_completed is True

    @pytest.mark.asyncio
    async def test_sync_hook_works_in_async_client(self) -> None:
        """Test that sync hooks work in async client (backward compat)."""
        hook_called = False

        def sync_hook(context) -> None:
            nonlocal hook_called
            hook_called = True

        client = (
            x402Client()
            .register("x402:cash", CashSchemeNetworkClient("SyncHook"))
            .on_after_payment_creation(sync_hook)
        )

        accepts = [build_cash_payment_requirements("Test", "USD", "1")]
        payment_required = await self.server.create_payment_required_response(accepts)

        await client.create_payment_payload(payment_required)

        assert hook_called is True


# =============================================================================
# Async Payment Flow Tests
# =============================================================================


class TestAsyncPaymentFlow:
    """Tests for async payment flow using pytest.mark.asyncio."""

    def setup_method(self) -> None:
        """Set up async test fixtures."""
        self.client = x402Client().register(
            "x402:cash",
            CashSchemeNetworkClient("John"),
        )

        self.facilitator = x402Facilitator().register(
            ["x402:cash"],
            CashSchemeNetworkFacilitator(),
        )

        facilitator_client = CashFacilitatorClient(self.facilitator)

        self.server = x402ResourceServer(facilitator_client)
        self.server.register("x402:cash", CashSchemeNetworkServer())
        self.server.initialize()

    @pytest.mark.asyncio
    async def test_async_payment_flow_native_await(self) -> None:
        """Test complete async payment flow using native await."""
        accepts = [build_cash_payment_requirements("Async Corp", "USD", "5")]
        resource = ResourceInfo(
            url="https://async.example.com",
            description="Async resource",
            mime_type="application/json",
        )
        payment_required = await self.server.create_payment_required_response(accepts, resource)

        # Native async calls
        payment_payload = await self.client.create_payment_payload(payment_required)
        assert payment_payload.x402_version == 2
        assert payment_payload.accepted.pay_to == "Async Corp"

        verify_result = await self.server.verify_payment(payment_payload, accepts[0])
        assert verify_result.is_valid is True

        settle_result = await self.server.settle_payment(payment_payload, accepts[0])
        assert settle_result.success is True

    @pytest.mark.asyncio
    async def test_async_facilitator_direct_calls(self) -> None:
        """Test async facilitator verify and settle directly."""
        requirements = build_cash_payment_requirements("Direct", "EUR", "10")
        payment_required = await self.server.create_payment_required_response([requirements])

        payload = await self.client.create_payment_payload(payment_required)

        verify_result = await self.facilitator.verify(payload, requirements)
        assert verify_result.is_valid is True

        settle_result = await self.facilitator.settle(payload, requirements)
        assert settle_result.success is True

    @pytest.mark.asyncio
    async def test_async_http_client_flow(self) -> None:
        """Test async HTTP client creates payment correctly."""
        payment_client = x402Client().register(
            "x402:cash",
            CashSchemeNetworkClient("HTTPUser"),
        )
        http_client = x402HTTPClient(payment_client)

        accepts = [build_cash_payment_requirements("HTTP Merchant", "USD", "2")]
        payment_required = await self.server.create_payment_required_response(accepts)

        # Async create payment payload through HTTP client
        payload = await http_client.create_payment_payload(payment_required)
        assert payload.accepted.pay_to == "HTTP Merchant"

        # Encode header (sync operation)
        headers = http_client.encode_payment_signature_header(payload)
        assert "PAYMENT-SIGNATURE" in headers
