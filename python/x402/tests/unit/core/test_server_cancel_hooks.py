"""Unit tests for onVerifiedPaymentCanceled and cancellation dispatcher."""

import asyncio

import pytest

from x402 import x402ResourceServer, x402ResourceServerSync
from x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
    SupportedKind,
    SupportedResponse,
    VerifyResponse,
)
from x402.schemas.hooks import VerifiedPaymentCancelOptions


class MockFacilitatorClient:
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
        return VerifyResponse(is_valid=True)

    async def settle(self, payload, requirements):
        raise NotImplementedError


class MockFacilitatorClientSync:
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

    def verify(self, payload, requirements) -> VerifyResponse:
        return VerifyResponse(is_valid=True)

    def settle(self, payload, requirements):
        raise NotImplementedError


def build_requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x0000000000000000000000000000000000000000",
        amount="1000000",
        pay_to="0x0000000000000000000000000000000000000001",
        max_timeout_seconds=300,
    )


def build_payload() -> PaymentPayload:
    return PaymentPayload(payload={}, accepted=build_requirements())


@pytest.fixture(params=["async", "sync"])
def server(request):
    if request.param == "async":
        resource_server = x402ResourceServer(MockFacilitatorClient())
    else:
        resource_server = x402ResourceServerSync(MockFacilitatorClientSync())
    resource_server.initialize()
    return resource_server


class TestOnVerifiedPaymentCanceled:
    def test_cancel_dispatcher_fires_once(self, server):
        calls: list[tuple[str, int | None]] = []

        def hook(context):
            calls.append((context.reason, context.response_status))

        server.on_verified_payment_canceled(hook)

        payload = build_payload()
        requirements = build_requirements()
        dispatcher = server.create_payment_cancellation_dispatcher(
            payload,
            requirements,
            {"ext": {}},
            {"request_id": "req-1"},
        )
        options = VerifiedPaymentCancelOptions(reason="handler_failed", response_status=500)

        if isinstance(server, x402ResourceServer):
            asyncio.run(dispatcher.cancel(options))
            asyncio.run(dispatcher.cancel(options))
        else:
            dispatcher.cancel_sync(options)
            dispatcher.cancel_sync(options)

        assert calls == [("handler_failed", 500)]
