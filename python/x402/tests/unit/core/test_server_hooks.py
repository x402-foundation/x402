"""Unit tests for resource server hook skip, skipHandler, and after-verify abort."""

import asyncio

import pytest

from x402 import x402ResourceServer, x402ResourceServerSync
from x402.schemas import (
    AbortResult,
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    SkipHandlerDirective,
    SkipHandlerResult,
    SkipSettleResult,
    SkipVerifyResult,
    SupportedKind,
    SupportedResponse,
    VerifyResponse,
)


class MockFacilitatorClient:
    """Mock async facilitator client for hook tests."""

    def __init__(self) -> None:
        self.verify_calls: list = []
        self.settle_calls: list = []
        self.verify_raises: Exception | None = None
        self.verify_result: VerifyResponse | None = None

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
        if self.verify_raises is not None:
            raise self.verify_raises
        if self.verify_result is not None:
            return self.verify_result
        return VerifyResponse(is_valid=True, payer="0xfacilitator")

    async def settle(self, payload, requirements) -> SettleResponse:
        self.settle_calls.append((payload, requirements))
        return SettleResponse(
            success=True,
            transaction="0xmock",
            network=requirements.network,
        )


class MockFacilitatorClientSync:
    """Mock sync facilitator client for hook tests."""

    def __init__(self) -> None:
        self.verify_calls: list = []
        self.settle_calls: list = []
        self.verify_raises: Exception | None = None
        self.verify_result: VerifyResponse | None = None

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
        self.verify_calls.append((payload, requirements))
        if self.verify_raises is not None:
            raise self.verify_raises
        if self.verify_result is not None:
            return self.verify_result
        return VerifyResponse(is_valid=True, payer="0xfacilitator")

    def settle(self, payload, requirements) -> SettleResponse:
        self.settle_calls.append((payload, requirements))
        return SettleResponse(
            success=True,
            transaction="0xmock",
            network=requirements.network,
        )


def build_requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x0000000000000000000000000000000000000000",
        amount="1000000",
        pay_to="0x0000000000000000000000000000000000000001",
        max_timeout_seconds=300,
    )


def build_payload(requirements: PaymentRequirements | None = None) -> PaymentPayload:
    accepted = requirements or build_requirements()
    return PaymentPayload(
        payload={},
        accepted=accepted,
    )


@pytest.fixture(params=["async", "sync"])
def server(request):
    if request.param == "async":
        client = MockFacilitatorClient()
        resource_server = x402ResourceServer(client)
    else:
        client = MockFacilitatorClientSync()
        resource_server = x402ResourceServerSync(client)

    resource_server.initialize()
    return resource_server, client


def _verify(resource_server, payload, requirements):
    if isinstance(resource_server, x402ResourceServer):
        return asyncio.run(resource_server.verify_payment(payload, requirements))
    return resource_server.verify_payment(payload, requirements)


class TestBeforeVerifySkip:
    def test_skips_facilitator_verification(self, server):
        resource_server, client = server
        resource_server.on_before_verify(
            lambda _ctx: SkipVerifyResult(
                result=VerifyResponse(is_valid=True, payer="0xlocal"),
            )
        )

        result = _verify(resource_server, build_payload(), build_requirements())

        assert len(client.verify_calls) == 0
        assert result.is_valid is True
        assert result.payer == "0xlocal"

    def test_runs_after_verify_hooks(self, server):
        resource_server, client = server
        execution_order: list[str] = []

        def before_hook(_ctx):
            execution_order.append("before")
            return SkipVerifyResult(result=VerifyResponse(is_valid=True, payer="0xlocal"))

        def after_hook(ctx):
            execution_order.append("after")
            assert ctx.result.payer == "0xlocal"

        resource_server.on_before_verify(before_hook).on_after_verify(after_hook)

        _verify(resource_server, build_payload(), build_requirements())

        assert len(client.verify_calls) == 0
        assert execution_order == ["before", "after"]


class TestAfterVerifySkipHandler:
    def test_attaches_skip_handler_directive(self, server):
        resource_server, _client = server
        resource_server.on_after_verify(
            lambda _ctx: SkipHandlerResult(
                response=SkipHandlerDirective(
                    content_type="application/json",
                    body={"refunded": True},
                )
            )
        )

        result = _verify(resource_server, build_payload(), build_requirements())

        assert result.is_valid is True
        assert result.skip_handler is not None
        assert result.skip_handler.content_type == "application/json"
        assert result.skip_handler.body == {"refunded": True}

    def test_last_skip_handler_wins(self, server):
        resource_server, _client = server
        resource_server.on_after_verify(
            lambda _ctx: SkipHandlerResult(
                response=SkipHandlerDirective(content_type="text/plain", body="first"),
            )
        )
        resource_server.on_after_verify(
            lambda _ctx: SkipHandlerResult(
                response=SkipHandlerDirective(content_type="application/json", body="second"),
            )
        )

        result = _verify(resource_server, build_payload(), build_requirements())

        assert result.skip_handler is not None
        assert result.skip_handler.content_type == "application/json"
        assert result.skip_handler.body == "second"


class TestAfterVerifyAbort:
    def test_returns_invalid_and_stops_later_hooks(self, server):
        resource_server, _client = server
        cancel_reasons: list[str] = []
        later_called = False

        resource_server.on_after_verify(
            lambda _ctx: AbortResult(reason="reservation_lost", message="channel busy")
        )

        def later_hook(_ctx):
            nonlocal later_called
            later_called = True

        resource_server.on_after_verify(later_hook)
        resource_server.on_verified_payment_canceled(lambda ctx: cancel_reasons.append(ctx.reason))

        result = _verify(resource_server, build_payload(), build_requirements())

        assert result.is_valid is False
        assert result.invalid_reason == "reservation_lost"
        assert result.invalid_message == "channel busy"
        assert later_called is False
        assert cancel_reasons == ["after_verify_aborted"]

    def test_keeps_abort_when_cancel_cleanup_throws(self, server):
        resource_server, _client = server

        resource_server.on_after_verify(
            lambda _ctx: AbortResult(reason="reservation_lost", message="channel busy")
        )
        resource_server.on_verified_payment_canceled(
            lambda _ctx: (_ for _ in ()).throw(RuntimeError("cleanup boom"))
        )

        result = _verify(resource_server, build_payload(), build_requirements())

        assert result.is_valid is False
        assert result.invalid_reason == "reservation_lost"


class TestOnVerifyFailureRecovery:
    def test_runs_after_verify_hooks_when_exception_recovers(self, server):
        from x402.schemas import RecoveredVerifyResult

        resource_server, client = server
        client.verify_raises = RuntimeError("facilitator down")
        after_called = False

        resource_server.on_verify_failure(
            lambda _ctx: RecoveredVerifyResult(
                result=VerifyResponse(is_valid=True, payer="0xrecovered")
            )
        )

        def after_hook(ctx):
            nonlocal after_called
            after_called = True
            assert ctx.result.payer == "0xrecovered"

        resource_server.on_after_verify(after_hook)

        result = _verify(resource_server, build_payload(), build_requirements())

        assert result.is_valid is True
        assert result.payer == "0xrecovered"
        assert after_called is True

    def test_fails_closed_when_after_verify_aborts_recovered_verify(self, server):
        from x402.schemas import RecoveredVerifyResult

        resource_server, client = server
        client.verify_raises = RuntimeError("facilitator down")
        cancel_reasons: list[str] = []

        resource_server.on_verify_failure(
            lambda _ctx: RecoveredVerifyResult(
                result=VerifyResponse(is_valid=True, payer="0xrecovered")
            )
        )
        resource_server.on_after_verify(
            lambda _ctx: AbortResult(reason="reservation_lost", message="channel busy")
        )
        resource_server.on_verified_payment_canceled(lambda ctx: cancel_reasons.append(ctx.reason))

        result = _verify(resource_server, build_payload(), build_requirements())

        assert result.is_valid is False
        assert result.invalid_reason == "reservation_lost"
        assert cancel_reasons == ["after_verify_aborted"]


class TestBeforeSettleSkip:
    def test_skips_facilitator_settlement(self, server):
        resource_server, client = server
        execution_order: list[str] = []

        def before_hook(_ctx):
            execution_order.append("before")
            return SkipSettleResult(
                result=SettleResponse(
                    success=True,
                    transaction="0xlocal",
                    network="eip155:8453",
                )
            )

        def after_hook(_ctx):
            execution_order.append("after")

        resource_server.on_before_settle(before_hook).on_after_settle(after_hook)

        payload = build_payload()
        requirements = build_requirements()

        if isinstance(resource_server, x402ResourceServer):
            result = asyncio.run(resource_server.settle_payment(payload, requirements))
        else:
            result = resource_server.settle_payment(payload, requirements)

        assert len(client.settle_calls) == 0
        assert result.success is True
        assert result.transaction == "0xlocal"
        assert execution_order == ["before", "after"]
