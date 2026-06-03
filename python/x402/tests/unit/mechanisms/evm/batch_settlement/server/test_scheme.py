"""Unit tests for the server-side `BatchSettlementEvmScheme`."""

from __future__ import annotations

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.constants import (
        MIN_WITHDRAW_DELAY,
        SCHEME_BATCH_SETTLEMENT,
    )
    from x402.mechanisms.evm.batch_settlement.server.scheme import (
        BatchSettlementEvmScheme,
        BatchSettlementEvmSchemeServerConfig,
        BatchSettlementRequestContext,
    )
    from x402.mechanisms.evm.batch_settlement.server.storage import (
        Channel,
        InMemoryChannelStorage,
    )
    from x402.mechanisms.evm.batch_settlement.types import ChannelConfig
    from x402.schemas import AssetAmount, PaymentPayload, PaymentRequirements, SupportedKind
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


RECEIVER = "0x3333333333333333333333333333333333333333"
USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
AUTHORIZER_ADDR = "0x4444444444444444444444444444444444444444"


class _MockSigner:
    """Minimal AuthorizerSigner stand-in."""

    def __init__(self, address: str) -> None:
        self.address = address


def _channel_config() -> ChannelConfig:
    return ChannelConfig(
        payer="0x1111111111111111111111111111111111111111",
        payer_authorizer="0x2222222222222222222222222222222222222222",
        receiver=RECEIVER,
        receiver_authorizer=AUTHORIZER_ADDR,
        token=USDC_BASE,
        withdraw_delay=900,
        salt="0x" + "00" * 31 + "01",
    )


def _payment_payload(channel_id: str = "0x" + "ab" * 32) -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        payload={
            "type": "voucher",
            "channelConfig": _channel_config().to_dict(),
            "voucher": {
                "channelId": channel_id,
                "maxClaimableAmount": "100",
                "signature": "0x" + "11" * 65,
            },
        },
        accepted=PaymentRequirements(
            scheme=SCHEME_BATCH_SETTLEMENT,
            network="eip155:8453",
            asset=USDC_BASE,
            amount="100",
            pay_to=RECEIVER,
            max_timeout_seconds=60,
            extra={},
        ),
    )


class TestConstruction:
    def test_defaults(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        assert s.get_receiver_address() == RECEIVER
        assert s.get_withdraw_delay() == MIN_WITHDRAW_DELAY
        assert s.get_receiver_authorizer_signer() is None
        assert isinstance(s.get_storage(), InMemoryChannelStorage)
        assert s.scheme == SCHEME_BATCH_SETTLEMENT

    def test_overrides_applied(self):
        storage = InMemoryChannelStorage()
        signer = _MockSigner(AUTHORIZER_ADDR)
        s = BatchSettlementEvmScheme(
            RECEIVER,
            BatchSettlementEvmSchemeServerConfig(
                storage=storage,
                receiver_authorizer_signer=signer,
                withdraw_delay=1800,
            ),
        )
        assert s.get_withdraw_delay() == 1800
        assert s.get_receiver_authorizer_signer() is signer
        assert s.get_storage() is storage

    def test_onchain_state_ttl_defaults_from_withdraw_delay(self):
        s = BatchSettlementEvmScheme(
            RECEIVER,
            BatchSettlementEvmSchemeServerConfig(withdraw_delay=3600),
        )
        # ttl = clamp(delay*1000 // 3, 30_000, 300_000) → 1_200_000 → clamped to 300_000
        assert s.get_onchain_state_ttl_ms() == 300_000

    def test_explicit_onchain_state_ttl(self):
        s = BatchSettlementEvmScheme(
            RECEIVER,
            BatchSettlementEvmSchemeServerConfig(onchain_state_ttl_ms=12345),
        )
        assert s.get_onchain_state_ttl_ms() == 12345


class TestParsePrice:
    def test_asset_amount_dict(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        out = s.parse_price(
            {"amount": "1000", "asset": "0xtoken", "extra": {"name": "USDC"}},
            "eip155:8453",
        )
        assert isinstance(out, AssetAmount)
        assert out.amount == "1000"
        assert out.asset == "0xtoken"
        assert out.extra["name"] == "USDC"

    def test_asset_amount_dict_missing_asset(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        with pytest.raises(ValueError):
            s.parse_price({"amount": "1000"}, "eip155:8453")

    def test_asset_amount_passthrough(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        aa = AssetAmount(amount="500", asset="0xabc", extra={})
        assert s.parse_price(aa, "eip155:8453") is aa

    def test_asset_amount_empty_asset_rejected(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        with pytest.raises(ValueError):
            s.parse_price(AssetAmount(amount="500", asset="", extra={}), "eip155:8453")

    def test_string_money_uses_default_asset(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        out = s.parse_price("$0.01", "eip155:8453")
        assert out.asset.lower() == USDC_BASE.lower()
        assert int(out.amount) > 0

    def test_register_money_parser_wins(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        called = {"flag": False}

        def parser(amount: float, network: str) -> AssetAmount:
            called["flag"] = True
            return AssetAmount(amount="777", asset="0xcustom", extra={})

        s.register_money_parser(parser)
        out = s.parse_price("0.50", "eip155:8453")
        assert called["flag"]
        assert out.amount == "777"
        assert out.asset == "0xcustom"


class TestEnhancePaymentRequirements:
    def _req(self, **kwargs) -> PaymentRequirements:
        defaults = {
            "scheme": SCHEME_BATCH_SETTLEMENT,
            "network": "eip155:8453",
            "asset": USDC_BASE,
            "amount": "1000",
            "pay_to": RECEIVER,
            "max_timeout_seconds": 60,
            "extra": {},
        }
        defaults.update(kwargs)
        return PaymentRequirements(**defaults)

    def _kind(self, extra: dict | None = None) -> SupportedKind:
        return SupportedKind(
            x402_version=2,
            scheme=SCHEME_BATCH_SETTLEMENT,
            network="eip155:8453",
            extra=extra,
        )

    def test_local_signer_sets_receiver_authorizer(self):
        signer = _MockSigner(AUTHORIZER_ADDR)
        s = BatchSettlementEvmScheme(
            RECEIVER,
            BatchSettlementEvmSchemeServerConfig(
                receiver_authorizer_signer=signer, withdraw_delay=1800
            ),
        )
        out = s.enhance_payment_requirements(self._req(), self._kind(), [])
        assert out.extra["receiverAuthorizer"] == AUTHORIZER_ADDR
        assert out.extra["withdrawDelay"] == 1800

    def test_falls_back_to_facilitator_authorizer(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        kind = self._kind(extra={"receiverAuthorizer": AUTHORIZER_ADDR})
        out = s.enhance_payment_requirements(self._req(), kind, [])
        assert out.extra["receiverAuthorizer"] == AUTHORIZER_ADDR

    def test_local_signer_wins_over_facilitator(self):
        signer = _MockSigner("0x9999999999999999999999999999999999999999")
        s = BatchSettlementEvmScheme(
            RECEIVER,
            BatchSettlementEvmSchemeServerConfig(receiver_authorizer_signer=signer),
        )
        kind = self._kind(extra={"receiverAuthorizer": AUTHORIZER_ADDR})
        out = s.enhance_payment_requirements(self._req(), kind, [])
        assert out.extra["receiverAuthorizer"] == "0x9999999999999999999999999999999999999999"

    def test_passes_through_asset_transfer_method(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        req = self._req(extra={"assetTransferMethod": "permit2"})
        kind = self._kind(extra={"receiverAuthorizer": AUTHORIZER_ADDR})
        out = s.enhance_payment_requirements(req, kind, [])
        assert out.extra["assetTransferMethod"] == "permit2"

    def test_decimal_amount_normalized(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        req = self._req(amount="1.5")
        kind = self._kind(extra={"receiverAuthorizer": AUTHORIZER_ADDR})
        out = s.enhance_payment_requirements(req, kind, [])
        # 1.5 USDC at 6 decimals = 1_500_000
        assert out.amount == "1500000"

    def test_missing_asset_uses_default(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        req = self._req(asset="dummy")
        req.asset = ""
        kind = self._kind(extra={"receiverAuthorizer": AUTHORIZER_ADDR})
        out = s.enhance_payment_requirements(req, kind, [])
        assert out.asset == USDC_BASE

    def test_rejects_missing_receiver_authorizer(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        with pytest.raises(ValueError, match="receiverAuthorizer"):
            s.enhance_payment_requirements(self._req(), self._kind(), [])

    def test_rejects_zero_receiver_authorizer(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        kind = self._kind(extra={"receiverAuthorizer": "0x" + "00" * 20})
        with pytest.raises(ValueError, match="receiverAuthorizer"):
            s.enhance_payment_requirements(self._req(), kind, [])


class TestRequestContext:
    def test_merge_and_take_round_trip(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        pp = _payment_payload()
        s.merge_request_context(
            pp,
            BatchSettlementRequestContext(channel_id="0xabc", pending_id="p1"),
        )
        got = s.take_request_context(pp)
        assert got is not None
        assert got.channel_id == "0xabc"
        assert got.pending_id == "p1"
        # Second take returns None.
        assert s.take_request_context(pp) is None

    def test_merge_combines_fields(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        pp = _payment_payload()
        s.merge_request_context(pp, BatchSettlementRequestContext(channel_id="0xabc"))
        s.merge_request_context(pp, BatchSettlementRequestContext(pending_id="p1"))
        s.merge_request_context(pp, BatchSettlementRequestContext(local_verify=True))
        got = s.read_request_context(pp)
        assert got is not None
        assert got.channel_id == "0xabc"
        assert got.pending_id == "p1"
        assert got.local_verify is True

    def test_read_does_not_consume(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        pp = _payment_payload()
        s.merge_request_context(pp, BatchSettlementRequestContext(channel_id="x"))
        assert s.read_request_context(pp) is not None
        assert s.read_request_context(pp) is not None

    def test_remember_and_take_channel_snapshot(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        pp = _payment_payload()
        channel = Channel(channel_id="0xabc", channel_config=_channel_config())
        s.remember_channel_snapshot(pp, channel)
        got = s.take_channel_snapshot(pp)
        assert got is channel
        # Snapshot is consumed via take_request_context.
        assert s.read_request_context(pp) is None


class TestClearPendingRequest:
    def test_no_context_is_noop(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        pp = _payment_payload()
        s.clear_pending_request(pp)  # should not raise

    def test_missing_channel_id_or_pending_is_noop(self):
        s = BatchSettlementEvmScheme(RECEIVER)
        pp = _payment_payload()
        s.merge_request_context(pp, BatchSettlementRequestContext(channel_id="0xabc"))
        s.clear_pending_request(pp)  # no pending_id → noop


class TestCreateChannelManager:
    def test_async_returns_manager(self):
        class _AsyncFac:
            async def settle(self, _p, _r):
                return None

        s = BatchSettlementEvmScheme(RECEIVER)
        cm = s.create_channel_manager(facilitator=_AsyncFac(), network="eip155:8453")
        assert cm is not None

    def test_sync_returns_manager(self):
        class _SyncFac:
            def settle(self, _p, _r):
                return None

        s = BatchSettlementEvmScheme(RECEIVER)
        cm = s.create_channel_manager_sync(facilitator=_SyncFac(), network="eip155:8453")
        assert cm is not None

    def test_async_rejects_sync_facilitator(self):
        class _SyncFac:
            def settle(self, _p, _r):
                return None

        s = BatchSettlementEvmScheme(RECEIVER)
        with pytest.raises(TypeError, match="async facilitator"):
            s.create_channel_manager(facilitator=_SyncFac(), network="eip155:8453")

    def test_sync_rejects_async_facilitator(self):
        class _AsyncFac:
            async def settle(self, _p, _r):
                return None

        s = BatchSettlementEvmScheme(RECEIVER)
        with pytest.raises(TypeError, match="sync facilitator"):
            s.create_channel_manager_sync(facilitator=_AsyncFac(), network="eip155:8453")

    def test_unknown_network_raises(self):
        s = BatchSettlementEvmScheme(RECEIVER)

        class _AsyncFac:
            async def settle(self, _p, _r):
                return None

        with pytest.raises(ValueError):
            s.create_channel_manager(facilitator=_AsyncFac(), network="eip155:99999999")
