"""Unit tests for batch-settlement channel managers (sync and async)."""

from __future__ import annotations

import time

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.server.channel_manager import (
        BatchSettlementChannelManager,
        ChannelManagerConfig,
    )
    from x402.mechanisms.evm.batch_settlement.server.channel_manager_common import (
        ChannelManagerConfigSync,
        ClaimOptions,
        ClaimResult,
        RefundResult,
        SettleResult,
    )
    from x402.mechanisms.evm.batch_settlement.server.channel_manager_sync import (
        BatchSettlementChannelManagerSync,
    )
    from x402.mechanisms.evm.batch_settlement.server.scheme import (
        BatchSettlementEvmScheme,
        BatchSettlementEvmSchemeServerConfig,
    )
    from x402.mechanisms.evm.batch_settlement.server.storage import (
        Channel,
        InMemoryChannelStorage,
        PendingRequest,
    )
    from x402.mechanisms.evm.batch_settlement.types import ChannelConfig
    from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id
    from x402.schemas import (
        PaymentPayload,
        PaymentRequirements,
        SettleResponse,
        SupportedResponse,
        VerifyResponse,
    )
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


NETWORK = "eip155:8453"
RECEIVER = "0x3333333333333333333333333333333333333333"
TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


def _channel_config(
    payer_suffix: str = "01",
    salt: str = "0x" + "00" * 31 + "01",
) -> ChannelConfig:
    return ChannelConfig(
        payer="0x" + payer_suffix * 20,
        payer_authorizer="0x" + payer_suffix * 20,
        receiver=RECEIVER,
        receiver_authorizer="0x4444444444444444444444444444444444444444",
        token=TOKEN,
        withdraw_delay=900,
        salt=salt,
    )


def _channel(
    config: ChannelConfig,
    balance: str = "1000",
    charged: str = "0",
    claimed: str = "0",
    pending: PendingRequest | None = None,
) -> Channel:
    cid = compute_channel_id(config, NETWORK)
    return Channel(
        channel_id=cid,
        channel_config=config,
        charged_cumulative_amount=charged,
        signed_max_claimable=charged,
        signature="0x" + "11" * 65,
        balance=balance,
        total_claimed=claimed,
        last_request_timestamp=int(time.time() * 1000),
        pending_request=pending,
    )


class _FakeFacilitator:
    """Programmable sync facilitator client capturing every settle call."""

    def __init__(
        self,
        responses: list[SettleResponse] | SettleResponse | None = None,
    ) -> None:
        if responses is None:
            self._responses: list[SettleResponse] = []
        elif isinstance(responses, SettleResponse):
            self._responses = [responses]
        else:
            self._responses = list(responses)
        self.calls: list[tuple[PaymentPayload, PaymentRequirements]] = []

    def settle(self, payload: PaymentPayload, requirements: PaymentRequirements) -> SettleResponse:
        self.calls.append((payload, requirements))
        if not self._responses:
            return SettleResponse(success=True, transaction="0xdefault", network=NETWORK)
        if len(self._responses) == 1:
            return self._responses[0]
        return self._responses.pop(0)

    # FacilitatorClientSync protocol stubs (not exercised in these tests).
    def verify(
        self, payload: PaymentPayload, requirements: PaymentRequirements
    ) -> VerifyResponse:  # pragma: no cover
        return VerifyResponse(is_valid=True)

    def get_supported(self) -> SupportedResponse:  # pragma: no cover
        return SupportedResponse(kinds=[])


def _make_sync_manager(
    *,
    facilitator: _FakeFacilitator | None = None,
    seed_channels: list[Channel] | None = None,
) -> tuple[BatchSettlementChannelManagerSync, BatchSettlementEvmScheme, _FakeFacilitator]:
    scheme = BatchSettlementEvmScheme(
        RECEIVER,
        BatchSettlementEvmSchemeServerConfig(storage=InMemoryChannelStorage()),
    )
    if seed_channels:
        for ch in seed_channels:
            scheme.get_storage().update_channel(ch.channel_id, lambda _c, x=ch: x)
    fac = facilitator or _FakeFacilitator()
    cm = BatchSettlementChannelManagerSync(
        ChannelManagerConfigSync(
            scheme=scheme,
            facilitator=fac,
            receiver=RECEIVER,
            token=TOKEN,
            network=NETWORK,
        )
    )
    return cm, scheme, fac


class _FakeAsyncFacilitator:
    def __init__(
        self,
        responses: list[SettleResponse] | SettleResponse | None = None,
    ) -> None:
        if responses is None:
            self._responses: list[SettleResponse] = []
        elif isinstance(responses, SettleResponse):
            self._responses = [responses]
        else:
            self._responses = list(responses)
        self.calls: list[tuple[PaymentPayload, PaymentRequirements]] = []

    async def settle(
        self, payload: PaymentPayload, requirements: PaymentRequirements
    ) -> SettleResponse:
        self.calls.append((payload, requirements))
        if not self._responses:
            return SettleResponse(success=True, transaction="0xdefault", network=NETWORK)
        if len(self._responses) == 1:
            return self._responses[0]
        return self._responses.pop(0)

    def get_supported(self) -> SupportedResponse:  # pragma: no cover
        return SupportedResponse(kinds=[])


def _make_async_manager(
    *,
    facilitator: _FakeAsyncFacilitator | None = None,
    seed_channels: list[Channel] | None = None,
) -> tuple[BatchSettlementChannelManager, BatchSettlementEvmScheme, _FakeAsyncFacilitator]:
    scheme = BatchSettlementEvmScheme(
        RECEIVER,
        BatchSettlementEvmSchemeServerConfig(storage=InMemoryChannelStorage()),
    )
    if seed_channels:
        for ch in seed_channels:
            scheme.get_storage().update_channel(ch.channel_id, lambda _c, x=ch: x)
    fac = facilitator or _FakeAsyncFacilitator()
    cm = BatchSettlementChannelManager(
        ChannelManagerConfig(
            scheme=scheme,
            facilitator=fac,
            receiver=RECEIVER,
            token=TOKEN,
            network=NETWORK,
        )
    )
    return cm, scheme, fac


class TestSyncClaim:
    def test_empty_storage_returns_no_claims(self):
        cm, _, fac = _make_sync_manager()
        assert cm.claim() == []
        assert fac.calls == []

    def test_skips_channels_with_no_charge_above_claimed(self):
        ch = _channel(_channel_config(), charged="100", claimed="100")
        cm, _, fac = _make_sync_manager(seed_channels=[ch])
        assert cm.claim() == []
        assert fac.calls == []

    def test_submits_single_claim(self):
        ch = _channel(_channel_config(), charged="500", claimed="0")
        fac = _FakeFacilitator(
            SettleResponse(success=True, transaction="0xclaim1", network=NETWORK)
        )
        cm, scheme, fac = _make_sync_manager(seed_channels=[ch], facilitator=fac)
        results = cm.claim()
        assert len(results) == 1
        assert isinstance(results[0], ClaimResult)
        assert results[0].vouchers == 1
        assert results[0].transaction == "0xclaim1"
        # total_claimed updated.
        updated = scheme.get_storage().get(ch.channel_id)
        assert updated is not None
        assert updated.total_claimed == "500"

    def test_batches_into_max_claims_per_batch(self):
        configs = [_channel_config(payer_suffix=f"{i:02x}") for i in range(1, 6)]
        channels = [_channel(c, charged="100", claimed="0") for c in configs]
        cm, _, fac = _make_sync_manager(seed_channels=channels)
        results = cm.claim(ClaimOptions(max_claims_per_batch=2))
        # 5 vouchers / batch of 2 → 3 batches (2,2,1).
        assert len(results) == 3
        assert [r.vouchers for r in results] == [2, 2, 1]

    def test_idle_filter(self):
        ch = _channel(_channel_config(), charged="100", claimed="0")
        # Pretend the request was 10s ago.
        ch.last_request_timestamp = int(time.time() * 1000) - 10_000
        cm, _, fac = _make_sync_manager(seed_channels=[ch])
        # idle_secs=60 → skip (only 10s idle).
        assert cm.claim(ClaimOptions(idle_secs=60)) == []
        # idle_secs=5 → include.
        assert cm.claim(ClaimOptions(idle_secs=5))

    def test_custom_selector_filters_targets(self):
        ch1 = _channel(_channel_config("01"), charged="100")
        ch2 = _channel(_channel_config("02"), charged="200")
        cm, _, fac = _make_sync_manager(seed_channels=[ch1, ch2])

        def select(channels, _ctx):
            return [c for c in channels if int(c.charged_cumulative_amount) > 150]

        results = cm.claim(ClaimOptions(select_claim_channels=select))
        assert len(results) == 1
        assert results[0].vouchers == 1

    def test_claim_failure_raises(self):
        ch = _channel(_channel_config(), charged="100")
        fac = _FakeFacilitator(
            SettleResponse(success=False, error_reason="oops", transaction="", network=NETWORK)
        )
        cm, _, _ = _make_sync_manager(seed_channels=[ch], facilitator=fac)
        with pytest.raises(RuntimeError, match="Claim failed"):
            cm.claim()


class TestSyncSettle:
    def test_settle_success(self):
        fac = _FakeFacilitator(
            SettleResponse(success=True, transaction="0xsettle", network=NETWORK)
        )
        cm, _, _ = _make_sync_manager(facilitator=fac)
        result = cm.settle()
        assert isinstance(result, SettleResult)
        assert result.transaction == "0xsettle"

    def test_settle_failure_raises(self):
        fac = _FakeFacilitator(
            SettleResponse(success=False, error_reason="x", transaction="", network=NETWORK)
        )
        cm, _, _ = _make_sync_manager(facilitator=fac)
        with pytest.raises(RuntimeError, match="Settle failed"):
            cm.settle()


class TestSyncRefund:
    def test_empty_returns_empty(self):
        cm, _, fac = _make_sync_manager()
        assert cm.refund() == []
        assert fac.calls == []

    def test_filters_channels_with_live_pending(self):
        future_ms = int(time.time() * 1000) + 10_000
        ch = _channel(
            _channel_config(),
            balance="500",
            charged="100",
            pending=PendingRequest(
                pending_id="p", signed_max_claimable="100", expires_at=future_ms
            ),
        )
        cm, _, fac = _make_sync_manager(seed_channels=[ch])
        assert cm.refund([ch.channel_id]) == []
        assert fac.calls == []

    def test_refund_executes_and_deletes_channel(self):
        ch = _channel(_channel_config(), balance="500", charged="100")
        fac = _FakeFacilitator(SettleResponse(success=True, transaction="0xref", network=NETWORK))
        cm, scheme, fac = _make_sync_manager(seed_channels=[ch], facilitator=fac)
        results = cm.refund([ch.channel_id])
        assert len(results) == 1
        assert isinstance(results[0], RefundResult)
        assert results[0].channel == ch.channel_id
        assert results[0].transaction == "0xref"
        # Channel deleted post-refund.
        assert scheme.get_storage().get(ch.channel_id) is None

    def test_refund_failure_raises(self):
        ch = _channel(_channel_config(), balance="500")
        fac = _FakeFacilitator(
            SettleResponse(success=False, error_reason="bad", transaction="", network=NETWORK)
        )
        cm, _, _ = _make_sync_manager(seed_channels=[ch], facilitator=fac)
        with pytest.raises(RuntimeError, match="Refund failed"):
            cm.refund([ch.channel_id])

    def test_refund_id_filter_case_insensitive(self):
        ch = _channel(_channel_config(), balance="500")
        cm, _, fac = _make_sync_manager(seed_channels=[ch])
        # Mixed-case request should still match storage's lowercased key.
        results = cm.refund([ch.channel_id.upper()])
        assert len(results) == 1


class TestSyncRefundIdleChannels:
    def test_skips_zero_balance_and_live_pending(self):
        ch_empty = _channel(_channel_config("01"), balance="0")
        future_ms = int(time.time() * 1000) + 10_000
        ch_pending = _channel(
            _channel_config("02"),
            balance="500",
            pending=PendingRequest("p", "0", future_ms),
        )
        ch_old = _channel(_channel_config("03"), balance="500")
        ch_old.last_request_timestamp = int(time.time() * 1000) - 120_000
        cm, _, fac = _make_sync_manager(seed_channels=[ch_empty, ch_pending, ch_old])
        results = cm.refund_idle_channels(60)
        assert len(results) == 1
        assert results[0].channel == ch_old.channel_id


class TestSyncClaimableAndPendingViews:
    def test_get_claimable_vouchers(self):
        ch1 = _channel(_channel_config("01"), charged="100")
        ch2 = _channel(_channel_config("02"), charged="0")  # nothing to claim
        cm, _, _ = _make_sync_manager(seed_channels=[ch1, ch2])
        out = cm.get_claimable_vouchers()
        assert len(out) == 1

    def test_get_withdrawal_pending_sessions(self):
        ch1 = _channel(_channel_config("01"))
        ch1.withdraw_requested_at = 12345
        ch2 = _channel(_channel_config("02"))
        cm, _, _ = _make_sync_manager(seed_channels=[ch1, ch2])
        out = cm.get_withdrawal_pending_sessions()
        assert len(out) == 1
        assert out[0].withdraw_requested_at == 12345


class TestSyncClaimAndSettle:
    def test_no_claims_skips_settle(self):
        cm, _, fac = _make_sync_manager()
        out = cm.claim_and_settle()
        assert out["claims"] == []
        assert out["settle"] is None
        assert fac.calls == []

    def test_runs_settle_when_claims_present(self):
        ch = _channel(_channel_config(), charged="100")
        fac = _FakeFacilitator(
            [
                SettleResponse(success=True, transaction="0xc", network=NETWORK),
                SettleResponse(success=True, transaction="0xs", network=NETWORK),
            ]
        )
        cm, _, fac = _make_sync_manager(seed_channels=[ch], facilitator=fac)
        out = cm.claim_and_settle()
        assert len(out["claims"]) == 1
        assert out["settle"].transaction == "0xs"
        assert len(fac.calls) == 2


class TestSyncAutoLoopLifecycle:
    def test_start_stop_no_intervals_no_threads(self):
        cm, _, _ = _make_sync_manager()
        cm.start()  # all intervals None
        assert cm._running
        cm.stop()
        assert not cm._running
        # No threads spawned.
        for t in cm._timer_threads.values():
            assert not t.is_alive()

    def test_double_start_is_idempotent(self):
        cm, _, _ = _make_sync_manager()
        cm.start()
        cm.start()  # should not raise / leak threads
        assert cm._running
        cm.stop()

    def test_stop_with_flush_runs_claim_and_settle(self):
        ch = _channel(_channel_config(), charged="100")
        fac = _FakeFacilitator(
            [
                SettleResponse(success=True, transaction="0xc", network=NETWORK),
                SettleResponse(success=True, transaction="0xs", network=NETWORK),
            ]
        )
        cm, _, fac = _make_sync_manager(seed_channels=[ch], facilitator=fac)
        cm.start()
        cm.stop(flush=True)
        # Both claim and settle should have been called during flush.
        assert len(fac.calls) == 2


class TestAsyncClaim:
    @pytest.mark.asyncio
    async def test_submits_single_claim(self):
        ch = _channel(_channel_config(), charged="500", claimed="0")
        fac = _FakeAsyncFacilitator(
            SettleResponse(success=True, transaction="0xclaim1", network=NETWORK)
        )
        cm, scheme, _ = _make_async_manager(seed_channels=[ch], facilitator=fac)
        results = await cm.claim()
        assert len(results) == 1
        assert results[0].vouchers == 1
        assert results[0].transaction == "0xclaim1"
        updated = scheme.get_storage().get(ch.channel_id)
        assert updated is not None
        assert updated.total_claimed == "500"

    @pytest.mark.asyncio
    async def test_claim_failure_raises(self):
        ch = _channel(_channel_config(), charged="100")
        fac = _FakeAsyncFacilitator(
            SettleResponse(success=False, error_reason="oops", transaction="", network=NETWORK)
        )
        cm, _, _ = _make_async_manager(seed_channels=[ch], facilitator=fac)
        with pytest.raises(RuntimeError, match="Claim failed"):
            await cm.claim()


class TestAsyncSettle:
    @pytest.mark.asyncio
    async def test_settle_success(self):
        fac = _FakeAsyncFacilitator(
            SettleResponse(success=True, transaction="0xsettle", network=NETWORK)
        )
        cm, _, _ = _make_async_manager(facilitator=fac)
        result = await cm.settle()
        assert result.transaction == "0xsettle"


class TestAsyncClaimAndSettle:
    @pytest.mark.asyncio
    async def test_runs_settle_when_claims_present(self):
        ch = _channel(_channel_config(), charged="100")
        fac = _FakeAsyncFacilitator(
            [
                SettleResponse(success=True, transaction="0xc", network=NETWORK),
                SettleResponse(success=True, transaction="0xs", network=NETWORK),
            ]
        )
        cm, _, fac = _make_async_manager(seed_channels=[ch], facilitator=fac)
        out = await cm.claim_and_settle()
        assert len(out["claims"]) == 1
        assert out["settle"].transaction == "0xs"
        assert len(fac.calls) == 2


class TestAsyncAutoLoopLifecycle:
    @pytest.mark.asyncio
    async def test_stop_with_flush_runs_claim_and_settle(self):
        ch = _channel(_channel_config(), charged="100")
        fac = _FakeAsyncFacilitator(
            [
                SettleResponse(success=True, transaction="0xc", network=NETWORK),
                SettleResponse(success=True, transaction="0xs", network=NETWORK),
            ]
        )
        cm, _, fac = _make_async_manager(seed_channels=[ch], facilitator=fac)
        cm.start()
        await cm.stop(flush=True)
        assert len(fac.calls) == 2
