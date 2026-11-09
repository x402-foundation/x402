"""Unit tests for batch-settlement channel managers (sync and async)."""

from __future__ import annotations

import time
from dataclasses import dataclass

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.server.channel_manager import (
        BatchSettlementChannelManager,
        ChannelManagerConfig,
    )
    from x402.mechanisms.evm.batch_settlement.server.channel_manager_common import (
        AutoSettlementConfig,
        BatchClaimError,
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
OTHER_NETWORK = "eip155:84532"
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


def _bound_channel(network: str, salt: int, *, stamped: bool) -> Channel:
    """Claimable and refundable channel whose id is bound to `network`.

    An unstamped channel drops the persisted network, modelling a row written before
    channels carried one.
    """
    config = _channel_config(salt="0x" + f"{salt:064x}")
    return Channel(
        channel_id=compute_channel_id(config, network),
        channel_config=config,
        network=network if stamped else None,
        charged_cumulative_amount="1000",
        signed_max_claimable="1000",
        signature="0x" + "11" * 65,
        balance="5000",
        total_claimed="100",
        last_request_timestamp=int(time.time() * 1000) - 120_000,
    )


def _failure(reason: str) -> SettleResponse:
    return SettleResponse(success=False, error_reason=reason, transaction="", network=NETWORK)


def _success(transaction: str = "0xtx") -> SettleResponse:
    return SettleResponse(success=True, transaction=transaction, network=NETWORK)


def _claimed_salt(payload: PaymentPayload) -> str:
    (claim,) = payload.payload["claims"]
    return claim["voucher"]["channel"]["salt"]


def _selector_recording(seen: list[Channel], extra: list[Channel] | None = None):
    def select(channels, _ctx):
        seen.extend(channels)
        return [*channels, *(extra or [])]

    return select


@dataclass
class _NetworkFixture:
    scheme: BatchSettlementEvmScheme
    base: Channel
    sepolia: Channel
    base_fac: _FakeFacilitator | _FakeAsyncFacilitator
    sepolia_fac: _FakeFacilitator | _FakeAsyncFacilitator
    base_mgr: BatchSettlementChannelManagerSync | BatchSettlementChannelManager
    sepolia_mgr: BatchSettlementChannelManagerSync | BatchSettlementChannelManager

    def total_claimed(self, channel: Channel) -> str:
        stored = self.scheme.get_storage().get(channel.channel_id)
        assert stored is not None
        return stored.total_claimed

    def is_stored(self, channel: Channel) -> bool:
        return self.scheme.get_storage().get(channel.channel_id) is not None


def _network_fixture(*, stamped: bool, use_async: bool = False) -> _NetworkFixture:
    scheme = BatchSettlementEvmScheme(
        RECEIVER,
        BatchSettlementEvmSchemeServerConfig(storage=InMemoryChannelStorage()),
    )
    base = _bound_channel(NETWORK, 1, stamped=stamped)
    sepolia = _bound_channel(OTHER_NETWORK, 2, stamped=stamped)
    for ch in (base, sepolia):
        scheme.get_storage().update_channel(ch.channel_id, lambda _c, x=ch: x)

    def manager(network: str):
        if use_async:
            fac = _FakeAsyncFacilitator()
            return fac, BatchSettlementChannelManager(
                ChannelManagerConfig(
                    scheme=scheme, facilitator=fac, receiver=RECEIVER, token=TOKEN, network=network
                )
            )
        fac = _FakeFacilitator()
        return fac, BatchSettlementChannelManagerSync(
            ChannelManagerConfigSync(
                scheme=scheme, facilitator=fac, receiver=RECEIVER, token=TOKEN, network=network
            )
        )

    base_fac, base_mgr = manager(NETWORK)
    sepolia_fac, sepolia_mgr = manager(OTHER_NETWORK)
    return _NetworkFixture(scheme, base, sepolia, base_fac, sepolia_fac, base_mgr, sepolia_mgr)


def _two_claimable_channels(responses: list[SettleResponse], *, use_async: bool = False):
    channels = [_bound_channel(NETWORK, salt, stamped=True) for salt in (1, 2)]
    if use_async:
        cm, scheme, fac = _make_async_manager(
            seed_channels=channels, facilitator=_FakeAsyncFacilitator(responses)
        )
    else:
        cm, scheme, fac = _make_sync_manager(
            seed_channels=channels, facilitator=_FakeFacilitator(responses)
        )
    return cm, scheme, fac, channels


def _total_claimed(scheme: BatchSettlementEvmScheme, channel: Channel) -> str:
    stored = scheme.get_storage().get(channel.channel_id)
    assert stored is not None
    return stored.total_claimed


stamped_params = pytest.mark.parametrize(
    "stamped", [True, False], ids=["persisted network", "legacy row without network"]
)


class TestSyncNetworkScope:
    @stamped_params
    def test_claim_selects_only_own_network(self, stamped):
        fx = _network_fixture(stamped=stamped)

        for manager, own in ((fx.base_mgr, fx.base), (fx.sepolia_mgr, fx.sepolia)):
            claims = manager.get_claimable_vouchers()
            assert [c.channel.salt for c in claims] == [own.channel_config.salt]

        results = fx.base_mgr.claim()
        assert [r.vouchers for r in results] == [1]
        assert len(fx.base_fac.calls) == 1
        assert fx.sepolia_fac.calls == []
        assert fx.total_claimed(fx.base) == "1000"
        assert fx.total_claimed(fx.sepolia) == "100"

        assert len(fx.sepolia_mgr.claim()) == 1
        assert fx.total_claimed(fx.sepolia) == "1000"

    @stamped_params
    def test_claim_selector_receives_only_own_network_channels(self, stamped):
        fx = _network_fixture(stamped=stamped)
        seen: list[Channel] = []

        results = fx.base_mgr.claim(
            ClaimOptions(select_claim_channels=_selector_recording(seen, [fx.sepolia]))
        )

        submitted_salts = [
            claim["voucher"]["channel"]["salt"]
            for payload, _requirements in fx.base_fac.calls
            for claim in payload.payload["claims"]
        ]
        assert [c.channel_id for c in seen] == [fx.base.channel_id]
        assert fx.total_claimed(fx.sepolia) == "100"
        assert submitted_salts == [fx.base.channel_config.salt]
        assert [r.vouchers for r in results] == [1]

    @stamped_params
    def test_withdrawal_pending_sessions_are_network_scoped(self, stamped):
        fx = _network_fixture(stamped=stamped)
        for ch in (fx.base, fx.sepolia):
            ch.withdraw_requested_at = 12345
            fx.scheme.get_storage().update_channel(ch.channel_id, lambda _c, x=ch: x)

        pending = fx.base_mgr.get_withdrawal_pending_sessions()

        assert [c.channel_id for c in pending] == [fx.base.channel_id]

    def test_legacy_row_with_unbound_channel_id_is_excluded(self):
        unbound = _bound_channel(NETWORK, 1, stamped=False)
        unbound.channel_id = "0x" + "ab" * 32
        cm, _, fac = _make_sync_manager(seed_channels=[unbound])

        assert cm.get_claimable_vouchers() == []
        assert cm.claim() == []
        assert fac.calls == []

    def test_persisted_network_takes_precedence_over_channel_id_binding(self):
        fx = _network_fixture(stamped=True)
        fx.base.network = OTHER_NETWORK
        fx.scheme.get_storage().update_channel(fx.base.channel_id, lambda _c: fx.base)

        assert fx.base_mgr.get_claimable_vouchers() == []
        assert len(fx.sepolia_mgr.get_claimable_vouchers()) == 2

    def test_empty_persisted_network_falls_back_to_channel_id_binding(self):
        fx = _network_fixture(stamped=False)
        for ch in (fx.base, fx.sepolia):
            ch.network = ""
            fx.scheme.get_storage().update_channel(ch.channel_id, lambda _c, x=ch: x)

        assert len(fx.base_mgr.get_claimable_vouchers()) == 1
        assert [r.channel for r in fx.base_mgr.refund()] == [fx.base.channel_id]
        assert fx.is_stored(fx.sepolia)

    @stamped_params
    def test_refund_skips_foreign_network_channels(self, stamped):
        fx = _network_fixture(stamped=stamped)

        results = fx.sepolia_mgr.refund([fx.base.channel_id, fx.sepolia.channel_id])

        assert [r.channel for r in results] == [fx.sepolia.channel_id]
        assert fx.base_fac.calls == []
        assert fx.is_stored(fx.base)
        assert not fx.is_stored(fx.sepolia)

        fx.scheme.get_storage().update_channel(fx.sepolia.channel_id, lambda _c: fx.sepolia)
        results = fx.base_mgr.refund()
        assert [r.channel for r in results] == [fx.base.channel_id]
        assert len(fx.sepolia_fac.calls) == 1
        assert fx.is_stored(fx.sepolia)

    @stamped_params
    def test_idle_refund_is_network_scoped(self, stamped):
        fx = _network_fixture(stamped=stamped)

        results = fx.base_mgr.refund_idle_channels(60)

        assert [r.channel for r in results] == [fx.base.channel_id]
        assert fx.sepolia_fac.calls == []
        assert fx.is_stored(fx.sepolia)

    @stamped_params
    def test_refund_job_selector_only_sees_own_network_channels(self, stamped):
        fx = _network_fixture(stamped=stamped)
        seen: list[Channel] = []
        refunds: list[RefundResult] = []
        fx.base_mgr._auto_settle_config = AutoSettlementConfig(
            select_refund_channels=_selector_recording(seen, [fx.sepolia]),
            on_refund=refunds.append,
        )

        fx.base_mgr._run_refund_job()

        assert [c.channel_id for c in seen] == [fx.base.channel_id]
        assert [r.channel for r in refunds] == [fx.base.channel_id]
        assert fx.sepolia_fac.calls == []
        assert fx.is_stored(fx.sepolia)


class TestSyncPartialClaimBatches:
    def test_claim_continues_after_failed_batch(self):
        cm, scheme, fac, channels = _two_claimable_channels([_failure("boom"), _success()])

        with pytest.raises(BatchClaimError, match="Claim failed: boom") as exc:
            cm.claim(ClaimOptions(max_claims_per_batch=1))

        assert [r.vouchers for r in exc.value.results] == [1]
        assert len(fac.calls) == 2
        assert cm._pending_settle is True
        failed_salt = _claimed_salt(fac.calls[0][0])
        for ch in channels:
            expected = "100" if ch.channel_config.salt == failed_salt else "1000"
            assert _total_claimed(scheme, ch) == expected

        # The failed channel stays claimable and lands on the next pass.
        assert len(cm.claim(ClaimOptions(max_claims_per_batch=1))) == 1
        for ch in channels:
            assert _total_claimed(scheme, ch) == "1000"

    def test_claim_returns_every_batch_error(self):
        cm, scheme, _, channels = _two_claimable_channels([_failure("first"), _failure("second")])

        with pytest.raises(BatchClaimError) as exc:
            cm.claim(ClaimOptions(max_claims_per_batch=1))

        assert [str(e) for e in exc.value.errors] == [
            "Claim failed: first — ",
            "Claim failed: second — ",
        ]
        assert exc.value.results == []
        assert cm._pending_settle is False
        for ch in channels:
            assert _total_claimed(scheme, ch) == "100"

    def test_claim_and_settle_settles_after_partial_claim(self):
        cm, _, fac, _ = _two_claimable_channels(
            [_failure("boom"), _success("0xclaim"), _success("0xsettle")]
        )

        with pytest.raises(BatchClaimError, match="boom") as exc:
            cm.claim_and_settle(ClaimOptions(max_claims_per_batch=1))

        assert [r.transaction for r in exc.value.results] == ["0xclaim"]
        assert exc.value.settle is not None
        assert exc.value.settle.transaction == "0xsettle"
        assert [p.payload["type"] for p, _ in fac.calls] == ["claim", "claim", "settle"]

    def test_claim_and_settle_joins_claim_and_settle_errors(self):
        cm, _, _, _ = _two_claimable_channels(
            [_failure("claim failed"), _success(), _failure("settle failed")]
        )

        with pytest.raises(BatchClaimError) as exc:
            cm.claim_and_settle(ClaimOptions(max_claims_per_batch=1))

        assert [str(e) for e in exc.value.errors] == [
            "Claim failed: claim failed — ",
            "Settle failed: settle failed — ",
        ]
        assert len(exc.value.results) == 1
        assert exc.value.settle is None

    def test_claim_job_reports_failed_batch_and_keeps_successful_claims(self):
        cm, _, _, _ = _two_claimable_channels([_failure("boom"), _success()])
        errors: list[BaseException] = []
        claims: list[ClaimResult] = []
        cm._auto_settle_config = AutoSettlementConfig(
            max_claims_per_batch=1, on_error=errors.append, on_claim=claims.append
        )

        cm._run_claim_job()

        assert len(errors) == 1
        assert isinstance(errors[0], BatchClaimError)
        assert "boom" in str(errors[0])
        assert len(claims) == 1
        assert cm._last_claim_time > 0

    def test_claim_job_keeps_last_claim_time_when_all_batches_fail(self):
        cm, _, _, _ = _two_claimable_channels([_failure("boom")])
        errors: list[BaseException] = []
        claims: list[ClaimResult] = []
        cm._auto_settle_config = AutoSettlementConfig(
            max_claims_per_batch=1, on_error=errors.append, on_claim=claims.append
        )

        cm._run_claim_job()

        assert len(errors) == 1
        assert claims == []
        assert cm._last_claim_time == 0


class TestAsyncNetworkScope:
    @pytest.mark.asyncio
    @stamped_params
    async def test_claim_selects_only_own_network(self, stamped):
        fx = _network_fixture(stamped=stamped, use_async=True)

        for manager, own in ((fx.base_mgr, fx.base), (fx.sepolia_mgr, fx.sepolia)):
            claims = await manager.get_claimable_vouchers()
            assert [c.channel.salt for c in claims] == [own.channel_config.salt]

        results = await fx.base_mgr.claim()
        assert [r.vouchers for r in results] == [1]
        assert len(fx.base_fac.calls) == 1
        assert fx.sepolia_fac.calls == []
        assert fx.total_claimed(fx.base) == "1000"
        assert fx.total_claimed(fx.sepolia) == "100"

    @pytest.mark.asyncio
    @stamped_params
    async def test_claim_selector_receives_only_own_network_channels(self, stamped):
        fx = _network_fixture(stamped=stamped, use_async=True)
        seen: list[Channel] = []

        results = await fx.base_mgr.claim(
            ClaimOptions(select_claim_channels=_selector_recording(seen, [fx.sepolia]))
        )

        submitted_salts = [
            claim["voucher"]["channel"]["salt"]
            for payload, _requirements in fx.base_fac.calls
            for claim in payload.payload["claims"]
        ]
        assert [c.channel_id for c in seen] == [fx.base.channel_id]
        assert fx.total_claimed(fx.sepolia) == "100"
        assert submitted_salts == [fx.base.channel_config.salt]
        assert [r.vouchers for r in results] == [1]

    @pytest.mark.asyncio
    @stamped_params
    async def test_withdrawal_pending_sessions_are_network_scoped(self, stamped):
        fx = _network_fixture(stamped=stamped, use_async=True)
        for ch in (fx.base, fx.sepolia):
            ch.withdraw_requested_at = 12345
            fx.scheme.get_storage().update_channel(ch.channel_id, lambda _c, x=ch: x)

        pending = await fx.base_mgr.get_withdrawal_pending_sessions()

        assert [c.channel_id for c in pending] == [fx.base.channel_id]

    @pytest.mark.asyncio
    @stamped_params
    async def test_refund_skips_foreign_network_channels(self, stamped):
        fx = _network_fixture(stamped=stamped, use_async=True)

        results = await fx.sepolia_mgr.refund([fx.base.channel_id, fx.sepolia.channel_id])

        assert [r.channel for r in results] == [fx.sepolia.channel_id]
        assert fx.base_fac.calls == []
        assert fx.is_stored(fx.base)
        assert not fx.is_stored(fx.sepolia)

    @pytest.mark.asyncio
    @stamped_params
    async def test_idle_refund_is_network_scoped(self, stamped):
        fx = _network_fixture(stamped=stamped, use_async=True)

        results = await fx.base_mgr.refund_idle_channels(60)

        assert [r.channel for r in results] == [fx.base.channel_id]
        assert fx.sepolia_fac.calls == []
        assert fx.is_stored(fx.sepolia)

    @pytest.mark.asyncio
    @stamped_params
    async def test_refund_job_selector_only_sees_own_network_channels(self, stamped):
        fx = _network_fixture(stamped=stamped, use_async=True)
        seen: list[Channel] = []
        refunds: list[RefundResult] = []
        fx.base_mgr._auto_settle_config = AutoSettlementConfig(
            select_refund_channels=_selector_recording(seen, [fx.sepolia]),
            on_refund=refunds.append,
        )

        await fx.base_mgr._run_refund_job()

        assert [c.channel_id for c in seen] == [fx.base.channel_id]
        assert [r.channel for r in refunds] == [fx.base.channel_id]
        assert fx.sepolia_fac.calls == []
        assert fx.is_stored(fx.sepolia)


class TestAsyncPartialClaimBatches:
    @pytest.mark.asyncio
    async def test_claim_continues_after_failed_batch(self):
        cm, scheme, fac, channels = _two_claimable_channels(
            [_failure("boom"), _success()], use_async=True
        )

        with pytest.raises(BatchClaimError, match="Claim failed: boom") as exc:
            await cm.claim(ClaimOptions(max_claims_per_batch=1))

        assert [r.vouchers for r in exc.value.results] == [1]
        assert len(fac.calls) == 2
        assert cm._pending_settle is True
        failed_salt = _claimed_salt(fac.calls[0][0])
        for ch in channels:
            expected = "100" if ch.channel_config.salt == failed_salt else "1000"
            assert _total_claimed(scheme, ch) == expected

        assert len(await cm.claim(ClaimOptions(max_claims_per_batch=1))) == 1
        for ch in channels:
            assert _total_claimed(scheme, ch) == "1000"

    @pytest.mark.asyncio
    async def test_claim_returns_every_batch_error(self):
        cm, _, _, _ = _two_claimable_channels(
            [_failure("first"), _failure("second")], use_async=True
        )

        with pytest.raises(BatchClaimError) as exc:
            await cm.claim(ClaimOptions(max_claims_per_batch=1))

        assert len(exc.value.errors) == 2
        assert exc.value.results == []
        assert cm._pending_settle is False

    @pytest.mark.asyncio
    async def test_claim_and_settle_settles_after_partial_claim(self):
        cm, _, fac, _ = _two_claimable_channels(
            [_failure("boom"), _success("0xclaim"), _success("0xsettle")], use_async=True
        )

        with pytest.raises(BatchClaimError, match="boom") as exc:
            await cm.claim_and_settle(ClaimOptions(max_claims_per_batch=1))

        assert [r.transaction for r in exc.value.results] == ["0xclaim"]
        assert exc.value.settle is not None
        assert exc.value.settle.transaction == "0xsettle"
        assert [p.payload["type"] for p, _ in fac.calls] == ["claim", "claim", "settle"]

    @pytest.mark.asyncio
    async def test_claim_and_settle_joins_claim_and_settle_errors(self):
        cm, _, _, _ = _two_claimable_channels(
            [_failure("claim failed"), _success(), _failure("settle failed")], use_async=True
        )

        with pytest.raises(BatchClaimError) as exc:
            await cm.claim_and_settle(ClaimOptions(max_claims_per_batch=1))

        assert len(exc.value.errors) == 2
        assert len(exc.value.results) == 1
        assert exc.value.settle is None

    @pytest.mark.asyncio
    async def test_claim_job_reports_failed_batch_and_keeps_successful_claims(self):
        cm, _, _, _ = _two_claimable_channels([_failure("boom"), _success()], use_async=True)
        errors: list[BaseException] = []
        claims: list[ClaimResult] = []
        cm._auto_settle_config = AutoSettlementConfig(
            max_claims_per_batch=1, on_error=errors.append, on_claim=claims.append
        )

        await cm._run_claim_job()

        assert len(errors) == 1
        assert isinstance(errors[0], BatchClaimError)
        assert len(claims) == 1
        assert cm._last_claim_time > 0

    @pytest.mark.asyncio
    async def test_claim_job_keeps_last_claim_time_when_all_batches_fail(self):
        cm, _, _, _ = _two_claimable_channels([_failure("boom")], use_async=True)
        errors: list[BaseException] = []
        claims: list[ClaimResult] = []
        cm._auto_settle_config = AutoSettlementConfig(
            max_claims_per_batch=1, on_error=errors.append, on_claim=claims.append
        )

        await cm._run_claim_job()

        assert len(errors) == 1
        assert claims == []
        assert cm._last_claim_time == 0
