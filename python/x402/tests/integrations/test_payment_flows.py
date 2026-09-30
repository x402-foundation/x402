"""Payment-flow HTTP integration tests (MockAuthorize / MockUpfront / MockEscrow)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

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
    decode_payment_response_header,
    x402HTTPClient,
    x402HTTPClientSync,
    x402HTTPResourceServer,
    x402HTTPResourceServerSync,
)
from x402.schemas.hooks import VerifiedPaymentCancelOptions

from ..mocks import (
    CashFacilitatorClient,
    CashFacilitatorClientSync,
    CashSchemeNetworkClient,
    CashSchemeNetworkFacilitator,
    MockAuthorizeSchemeNetworkServer,
    MockEscrowSchemeNetworkServer,
    MockUpfrontSchemeNetworkServer,
)
from .test_http_integration import MockHTTPAdapter

ROUTES = {
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


class CountingFacilitatorClient:
    """Wraps a facilitator client to count verify/settle calls."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.verify_calls = 0
        self.settle_calls = 0

    def get_supported(self):
        return self._inner.get_supported()

    async def verify(self, payload, requirements):
        self.verify_calls += 1
        return await self._inner.verify(payload, requirements)

    async def settle(self, payload, requirements):
        self.settle_calls += 1
        return await self._inner.settle(payload, requirements)


class CountingFacilitatorClientSync:
    """Sync counterpart of CountingFacilitatorClient."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.verify_calls = 0
        self.settle_calls = 0

    def get_supported(self):
        return self._inner.get_supported()

    def verify(self, payload, requirements):
        self.verify_calls += 1
        return self._inner.verify(payload, requirements)

    def settle(self, payload, requirements):
        self.settle_calls += 1
        return self._inner.settle(payload, requirements)


@dataclass
class PaymentFlowFixture:
    http_client: x402HTTPClient | x402HTTPClientSync
    http_server: x402HTTPResourceServer | x402HTTPResourceServerSync
    resource_server: x402ResourceServer | x402ResourceServerSync
    facilitator_client: CountingFacilitatorClient | CountingFacilitatorClientSync
    payment_signature_header: str
    is_async: bool

    def process_http_request(self, context: HTTPRequestContext):
        if self.is_async:
            return asyncio.run(self.http_server.process_http_request(context))  # type: ignore[union-attr]
        return self.http_server.process_http_request(context)  # type: ignore[union-attr]

    def process_settlement(self, result):
        kwargs = {
            "declared_extensions": result.declared_extensions,
            "before_handler_settlement": result.before_handler_settlement,
        }
        if self.is_async:
            return asyncio.run(
                self.http_server.process_settlement(  # type: ignore[union-attr]
                    result.payment_payload,
                    result.payment_requirements,
                    **kwargs,
                )
            )
        return self.http_server.process_settlement(  # type: ignore[union-attr]
            result.payment_payload,
            result.payment_requirements,
            **kwargs,
        )

    def paid_adapter(self) -> MockHTTPAdapter:
        return MockHTTPAdapter(
            path="/api/protected",
            method="GET",
            headers={"PAYMENT-SIGNATURE": self.payment_signature_header},
        )


def _sign_unpaid(
    http_client: x402HTTPClient | x402HTTPClientSync,
    http_server: x402HTTPResourceServer | x402HTTPResourceServerSync,
    is_async: bool,
) -> str:
    unpaid_adapter = MockHTTPAdapter(path="/api/protected", method="GET")
    context = HTTPRequestContext(adapter=unpaid_adapter, path="/api/protected", method="GET")
    unpaid = (
        asyncio.run(http_server.process_http_request(context))  # type: ignore[union-attr]
        if is_async
        else http_server.process_http_request(context)  # type: ignore[union-attr]
    )
    assert unpaid.type == "payment-error"
    assert unpaid.response is not None
    payment_required = http_client.get_payment_required_response(
        lambda name: unpaid.response.headers.get(name),
        unpaid.response.body,
    )
    if is_async:
        payment_payload = asyncio.run(http_client.create_payment_payload(payment_required))  # type: ignore[union-attr]
    else:
        payment_payload = http_client.create_payment_payload(payment_required)  # type: ignore[union-attr]
    headers = http_client.encode_payment_signature_header(payment_payload)
    return headers["PAYMENT-SIGNATURE"]


def _create_async_fixture(scheme_server) -> PaymentFlowFixture:
    facilitator = x402Facilitator().register(["x402:cash"], CashSchemeNetworkFacilitator())
    facilitator_client = CountingFacilitatorClient(CashFacilitatorClient(facilitator))
    payment_client = (
        x402Client()
        .register("x402:cash", CashSchemeNetworkClient("John"))
        .set_spend_controls(False)
    )
    http_client = x402HTTPClient(payment_client)
    resource_server = x402ResourceServer(facilitator_client)
    resource_server.register("x402:cash", scheme_server)
    resource_server.initialize()
    http_server = x402HTTPResourceServer(resource_server, ROUTES)
    signature = _sign_unpaid(http_client, http_server, is_async=True)
    facilitator_client.verify_calls = 0
    facilitator_client.settle_calls = 0
    return PaymentFlowFixture(
        http_client=http_client,
        http_server=http_server,
        resource_server=resource_server,
        facilitator_client=facilitator_client,
        payment_signature_header=signature,
        is_async=True,
    )


def _create_sync_fixture(scheme_server) -> PaymentFlowFixture:
    facilitator = x402FacilitatorSync().register(["x402:cash"], CashSchemeNetworkFacilitator())
    facilitator_client = CountingFacilitatorClientSync(CashFacilitatorClientSync(facilitator))
    payment_client = (
        x402ClientSync()
        .register("x402:cash", CashSchemeNetworkClient("John"))
        .set_spend_controls(False)
    )
    http_client = x402HTTPClientSync(payment_client)
    resource_server = x402ResourceServerSync(facilitator_client)
    resource_server.register("x402:cash", scheme_server)
    resource_server.initialize()
    http_server = x402HTTPResourceServerSync(resource_server, ROUTES)
    signature = _sign_unpaid(http_client, http_server, is_async=False)
    facilitator_client.verify_calls = 0
    facilitator_client.settle_calls = 0
    return PaymentFlowFixture(
        http_client=http_client,
        http_server=http_server,
        resource_server=resource_server,
        facilitator_client=facilitator_client,
        payment_signature_header=signature,
        is_async=False,
    )


def _paid_context(components: PaymentFlowFixture) -> HTTPRequestContext:
    return HTTPRequestContext(
        adapter=components.paid_adapter(),
        path="/api/protected",
        method="GET",
    )


class TestMockAuthorize:
    @pytest.fixture(params=["sync", "async"])
    def components(self, request: pytest.FixtureRequest) -> PaymentFlowFixture:
        scheme = MockAuthorizeSchemeNetworkServer()
        if request.param == "sync":
            return _create_sync_fixture(scheme)
        return _create_async_fixture(scheme)

    def test_verifies_before_handler_and_settles_after(
        self, components: PaymentFlowFixture
    ) -> None:
        result = components.process_http_request(_paid_context(components))
        assert result.type == "payment-verified"
        assert result.before_handler_settlement is None
        assert components.facilitator_client.verify_calls == 1
        assert components.facilitator_client.settle_calls == 0

        settle = components.process_settlement(result)
        assert settle.success is True
        assert components.facilitator_client.verify_calls == 1
        assert components.facilitator_client.settle_calls == 1
        assert settle.headers.get("PAYMENT-RESPONSE")


class TestMockUpfront:
    @pytest.fixture(params=["sync", "async"])
    def components(self, request: pytest.FixtureRequest) -> PaymentFlowFixture:
        scheme = MockUpfrontSchemeNetworkServer()
        if request.param == "sync":
            return _create_sync_fixture(scheme)
        return _create_async_fixture(scheme)

    def test_settles_before_handler_and_echoes_without_second_settle(
        self, components: PaymentFlowFixture
    ) -> None:
        result = components.process_http_request(_paid_context(components))
        assert result.type == "payment-verified"
        assert result.before_handler_settlement is not None
        assert result.before_handler_settlement.phase == "before-handler"
        assert result.before_handler_settlement.flow == "upfront"
        assert components.facilitator_client.verify_calls == 0
        assert components.facilitator_client.settle_calls == 1

        settle = components.process_settlement(result)
        assert settle.success is True
        assert components.facilitator_client.settle_calls == 1
        assert settle.headers.get("PAYMENT-RESPONSE")
        assert settle.transaction == result.before_handler_settlement.result.transaction


class TestMockEscrow:
    @pytest.fixture(params=["sync", "async"])
    def components(self, request: pytest.FixtureRequest) -> PaymentFlowFixture:
        scheme = MockEscrowSchemeNetworkServer()
        if request.param == "sync":
            return _create_sync_fixture(scheme)
        return _create_async_fixture(scheme)

    def test_settles_before_and_after_handler(self, components: PaymentFlowFixture) -> None:
        result = components.process_http_request(_paid_context(components))
        assert result.type == "payment-verified"
        assert result.before_handler_settlement is not None
        assert result.before_handler_settlement.phase == "before-handler"
        assert result.before_handler_settlement.flow == "escrow"
        assert components.facilitator_client.verify_calls == 0
        assert components.facilitator_client.settle_calls == 1

        settle = components.process_settlement(result)
        assert settle.success is True
        assert components.facilitator_client.settle_calls == 2
        assert settle.headers.get("PAYMENT-RESPONSE")

    def test_cancels_after_deposit_with_settled_phases(
        self, components: PaymentFlowFixture
    ) -> None:
        settled: list[str] | None = None

        def on_cancel(ctx):
            nonlocal settled
            settled = list(ctx.settled_phases)
            assert ctx.phase == "cancel"
            assert ctx.reason == "handler_failed"

        components.resource_server.on_verified_payment_canceled(on_cancel)

        result = components.process_http_request(_paid_context(components))
        assert result.type == "payment-verified"
        assert result.before_handler_settlement is not None
        assert result.before_handler_settlement.phase == "before-handler"
        assert components.facilitator_client.settle_calls == 1

        assert result.cancellation_dispatcher is not None
        options = VerifiedPaymentCancelOptions(reason="handler_failed", response_status=500)
        if components.is_async:
            asyncio.run(result.cancellation_dispatcher.cancel(options))
        else:
            result.cancellation_dispatcher.cancel_sync(options)

        assert settled == ["before-handler"]
        assert components.facilitator_client.settle_calls == 1

        receipt_headers = components.http_server.create_completed_settlement_headers(
            result.before_handler_settlement
        )
        decoded = decode_payment_response_header(receipt_headers["PAYMENT-RESPONSE"])
        assert decoded.success is True
        assert decoded.transaction == result.before_handler_settlement.result.transaction
