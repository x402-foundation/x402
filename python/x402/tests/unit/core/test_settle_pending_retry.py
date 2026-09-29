"""Unit tests for the resource server's single automatic settle retry on settlement_pending.

Covers `is_retryable_settlement_pending`, `settle_with_pending_retry` (sync),
`settle_with_pending_retry_async`, and end-to-end `x402ResourceServer(Sync).settle_payment`
routing through the retry.
"""

from __future__ import annotations

import asyncio

from x402 import x402ResourceServer, x402ResourceServerSync
from x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
    ResourceInfo,
    SettleResponse,
    SupportedKind,
    SupportedResponse,
    VerifyResponse,
)
from x402.server_base import (
    is_retryable_settlement_pending,
    settle_with_pending_retry,
    settle_with_pending_retry_async,
)

NETWORK = "eip155:8453"


def _pending_response(transaction: str = "0xpending") -> SettleResponse:
    return SettleResponse(
        success=False,
        error_reason="settlement_pending",
        transaction=transaction,
        network=NETWORK,
    )


def _success_response(transaction: str = "0xsuccess") -> SettleResponse:
    return SettleResponse(success=True, transaction=transaction, network=NETWORK)


def _terminal_failure_response(reason: str = "invalid_signature") -> SettleResponse:
    return SettleResponse(success=False, error_reason=reason, transaction="", network=NETWORK)


class TestSettlementPendingReasonUnification:
    """Every mechanism must report the exact same `settlement_pending` reason string as
    the core `ERR_SETTLEMENT_PENDING` constant this module's retry logic checks against
    (`is_retryable_settlement_pending`). A mismatched mechanism-specific constant would
    silently disable the resource server's automatic single retry for that mechanism.
    """

    def test_evm_constant_matches_core_constant(self):
        from x402.mechanisms.evm.constants import ERR_SETTLEMENT_PENDING as EVM_REASON
        from x402.pending_settlement_store import ERR_SETTLEMENT_PENDING as CORE_REASON

        assert EVM_REASON == CORE_REASON == "settlement_pending"

    def test_svm_constant_matches_core_constant(self):
        from x402.mechanisms.svm.constants import ERR_SETTLEMENT_PENDING as SVM_REASON
        from x402.pending_settlement_store import ERR_SETTLEMENT_PENDING as CORE_REASON

        assert SVM_REASON == CORE_REASON == "settlement_pending"

    def test_svm_confirm_timeout_result_is_recognized_as_retryable(self):
        """Pins the actual behavior the constant unification exists for: an SVM
        confirm-timeout SettleResponse (using the SVM-scoped constant) must be recognized
        by the core, mechanism-agnostic retry check."""
        from x402.mechanisms.svm.constants import ERR_SETTLEMENT_PENDING as SVM_REASON

        svm_confirm_timeout_result = SettleResponse(
            success=False,
            error_reason=SVM_REASON,
            transaction="mockSignature123",
            network="solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        )

        assert is_retryable_settlement_pending(svm_confirm_timeout_result) is True


class TestIsRetryableSettlementPending:
    def test_true_for_settlement_pending_with_transaction(self):
        assert is_retryable_settlement_pending(_pending_response()) is True

    def test_false_for_success(self):
        assert is_retryable_settlement_pending(_success_response()) is False

    def test_false_for_other_failure_reason(self):
        assert is_retryable_settlement_pending(_terminal_failure_response()) is False

    def test_false_for_settlement_pending_without_transaction(self):
        result = SettleResponse(
            success=False, error_reason="settlement_pending", transaction="", network=NETWORK
        )
        assert is_retryable_settlement_pending(result) is False

    def test_false_for_none_error_reason(self):
        result = SettleResponse(
            success=False, error_reason=None, transaction="0xabc", network=NETWORK
        )
        assert is_retryable_settlement_pending(result) is False

    def test_false_for_empty_string_error_reason(self):
        result = SettleResponse(
            success=False, error_reason="", transaction="0xabc", network=NETWORK
        )
        assert is_retryable_settlement_pending(result) is False


class _StubSyncFacilitatorClient:
    def __init__(self, responses: list[SettleResponse]):
        self._responses = list(responses)
        self.calls: list[tuple] = []

    def settle(self, payload, requirements) -> SettleResponse:
        self.calls.append((payload, requirements))
        return self._responses.pop(0)


class _StubAsyncFacilitatorClient:
    def __init__(self, responses: list[SettleResponse]):
        self._responses = list(responses)
        self.calls: list[tuple] = []

    async def settle(self, payload, requirements) -> SettleResponse:
        self.calls.append((payload, requirements))
        return self._responses.pop(0)


class TestSettleWithPendingRetrySync:
    def test_no_retry_on_success(self):
        client = _StubSyncFacilitatorClient([_success_response("0x1")])

        result = settle_with_pending_retry(client, "payload", "requirements")

        assert result.success is True
        assert len(client.calls) == 1

    def test_no_retry_on_terminal_failure(self):
        client = _StubSyncFacilitatorClient([_terminal_failure_response()])

        result = settle_with_pending_retry(client, "payload", "requirements")

        assert result.success is False
        assert result.error_reason == "invalid_signature"
        assert len(client.calls) == 1

    def test_single_retry_on_settlement_pending_then_success(self):
        client = _StubSyncFacilitatorClient(
            [_pending_response("0xpending"), _success_response("0xconfirmed")]
        )

        result = settle_with_pending_retry(client, "payload", "requirements")

        assert result.success is True
        assert result.transaction == "0xconfirmed"
        assert len(client.calls) == 2

    def test_retry_uses_identical_payload_and_requirements(self):
        client = _StubSyncFacilitatorClient([_pending_response(), _success_response()])
        payload, requirements = object(), object()

        settle_with_pending_retry(client, payload, requirements)

        assert client.calls == [(payload, requirements), (payload, requirements)]

    def test_capped_at_one_retry_when_second_attempt_is_also_pending(self):
        client = _StubSyncFacilitatorClient(
            [_pending_response("0xfirst"), _pending_response("0xsecond")]
        )

        result = settle_with_pending_retry(client, "payload", "requirements")

        assert result.success is False
        assert result.error_reason == "settlement_pending"
        assert result.transaction == "0xsecond"
        assert len(client.calls) == 2  # never a third call


class TestSettleWithPendingRetryAsync:
    def test_no_retry_on_success(self):
        client = _StubAsyncFacilitatorClient([_success_response("0x1")])

        result = asyncio.run(settle_with_pending_retry_async(client, "payload", "requirements"))

        assert result.success is True
        assert len(client.calls) == 1

    def test_single_retry_on_settlement_pending_then_success(self):
        client = _StubAsyncFacilitatorClient(
            [_pending_response("0xpending"), _success_response("0xconfirmed")]
        )

        result = asyncio.run(settle_with_pending_retry_async(client, "payload", "requirements"))

        assert result.success is True
        assert result.transaction == "0xconfirmed"
        assert len(client.calls) == 2

    def test_capped_at_one_retry(self):
        client = _StubAsyncFacilitatorClient(
            [_pending_response("0xfirst"), _pending_response("0xsecond")]
        )

        result = asyncio.run(settle_with_pending_retry_async(client, "payload", "requirements"))

        assert result.success is False
        assert result.transaction == "0xsecond"
        assert len(client.calls) == 2


# =============================================================================
# End-to-end x402ResourceServer(Sync).settle_payment retry routing
# =============================================================================


class _RecordingSchemeServer:
    scheme = "mock"

    def get_payment_requirements(self, config):  # pragma: no cover - not exercised
        raise NotImplementedError


def _requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="mock",
        network=NETWORK,
        asset="0x0000000000000000000000000000000000000001",
        amount="100",
        pay_to="0x0000000000000000000000000000000000000002",
        max_timeout_seconds=60,
        extra={},
    )


def _payload() -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        resource=ResourceInfo(url="http://example.com", description="", mime_type="text/plain"),
        accepted=_requirements(),
        payload={},
    )


class _E2ESyncFacilitatorClient:
    def __init__(self, responses: list[SettleResponse]):
        self._responses = list(responses)
        self.settle_calls = 0

    def get_supported(self) -> SupportedResponse:
        return SupportedResponse(
            kinds=[SupportedKind(x402_version=2, scheme="mock", network=NETWORK)],
            extensions=[],
            signers={},
        )

    def verify(self, payload, requirements) -> VerifyResponse:
        return VerifyResponse(is_valid=True)

    def settle(self, payload, requirements) -> SettleResponse:
        self.settle_calls += 1
        return self._responses.pop(0)


class _E2EAsyncFacilitatorClient:
    def __init__(self, responses: list[SettleResponse]):
        self._responses = list(responses)
        self.settle_calls = 0

    def get_supported(self) -> SupportedResponse:
        return SupportedResponse(
            kinds=[SupportedKind(x402_version=2, scheme="mock", network=NETWORK)],
            extensions=[],
            signers={},
        )

    async def verify(self, payload, requirements) -> VerifyResponse:
        return VerifyResponse(is_valid=True)

    async def settle(self, payload, requirements) -> SettleResponse:
        self.settle_calls += 1
        return self._responses.pop(0)


class TestResourceServerSyncSettleRetry:
    def _make_server(self, responses: list[SettleResponse]) -> tuple:
        client = _E2ESyncFacilitatorClient(responses)
        server = x402ResourceServerSync(client)
        server.register(NETWORK, _RecordingSchemeServer())
        server.initialize()
        return server, client

    def test_single_retry_on_settlement_pending_resolves_to_success(self):
        server, client = self._make_server(
            [_pending_response("0xpending"), _success_response("0xconfirmed")]
        )

        result = server.settle_payment(_payload(), _requirements())

        assert result.success is True
        assert result.transaction == "0xconfirmed"
        assert client.settle_calls == 2

    def test_no_retry_on_success(self):
        server, client = self._make_server([_success_response("0x1")])

        result = server.settle_payment(_payload(), _requirements())

        assert result.success is True
        assert client.settle_calls == 1

    def test_no_retry_on_non_pending_failure(self):
        server, client = self._make_server([_terminal_failure_response("balance_too_low")])

        result = server.settle_payment(_payload(), _requirements())

        assert result.success is False
        assert result.error_reason == "balance_too_low"
        assert client.settle_calls == 1

    def test_capped_at_one_retry_on_second_settlement_pending(self):
        server, client = self._make_server(
            [_pending_response("0xfirst"), _pending_response("0xsecond")]
        )

        result = server.settle_payment(_payload(), _requirements())

        assert result.success is False
        assert result.error_reason == "settlement_pending"
        assert result.transaction == "0xsecond"
        assert client.settle_calls == 2

    def test_recovery_hook_still_runs_after_a_non_recovered_retry(self):
        """A final settlement_pending (after the capped retry) is still success=False, so
        it must route through on_settle_failure like any other failure — and a hook that
        recovers must short-circuit to its recovered result."""
        from x402.schemas import RecoveredSettleResult

        server, client = self._make_server(
            [_pending_response("0xfirst"), _pending_response("0xsecond")]
        )
        recovered = _success_response("0xrecovered")
        server.on_settle_failure(lambda ctx: RecoveredSettleResult(result=recovered))

        result = server.settle_payment(_payload(), _requirements())

        assert result.success is True
        assert result.transaction == "0xrecovered"
        assert client.settle_calls == 2


class TestResourceServerAsyncSettleRetry:
    def _make_server(self, responses: list[SettleResponse]) -> tuple:
        client = _E2EAsyncFacilitatorClient(responses)
        server = x402ResourceServer(client)
        server.register(NETWORK, _RecordingSchemeServer())
        server.initialize()
        return server, client

    def test_single_retry_on_settlement_pending_resolves_to_success(self):
        server, client = self._make_server(
            [_pending_response("0xpending"), _success_response("0xconfirmed")]
        )

        result = asyncio.run(server.settle_payment(_payload(), _requirements()))

        assert result.success is True
        assert result.transaction == "0xconfirmed"
        assert client.settle_calls == 2

    def test_no_retry_on_success(self):
        server, client = self._make_server([_success_response("0x1")])

        result = asyncio.run(server.settle_payment(_payload(), _requirements()))

        assert result.success is True
        assert client.settle_calls == 1

    def test_no_retry_on_non_pending_failure(self):
        server, client = self._make_server([_terminal_failure_response("balance_too_low")])

        result = asyncio.run(server.settle_payment(_payload(), _requirements()))

        assert result.success is False
        assert result.error_reason == "balance_too_low"
        assert client.settle_calls == 1

    def test_capped_at_one_retry_on_second_settlement_pending(self):
        server, client = self._make_server(
            [_pending_response("0xfirst"), _pending_response("0xsecond")]
        )

        result = asyncio.run(server.settle_payment(_payload(), _requirements()))

        assert result.success is False
        assert result.error_reason == "settlement_pending"
        assert result.transaction == "0xsecond"
        assert client.settle_calls == 2

    def test_recovery_hook_still_runs_after_a_non_recovered_retry(self):
        """Async counterpart of the sync test above: a final settlement_pending (after
        the capped retry) must still route through an async on_settle_failure hook, which
        must be able to recover it via an awaited RecoveredSettleResult."""
        from x402.schemas import RecoveredSettleResult

        server, client = self._make_server(
            [_pending_response("0xfirst"), _pending_response("0xsecond")]
        )
        recovered = _success_response("0xrecovered")

        async def _recover(ctx):
            return RecoveredSettleResult(result=recovered)

        server.on_settle_failure(_recover)

        result = asyncio.run(server.settle_payment(_payload(), _requirements()))

        assert result.success is True
        assert result.transaction == "0xrecovered"
        assert client.settle_calls == 2
