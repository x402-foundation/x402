"""Unit tests for the PendingSettlementStore fast path in `settle_deposit`.

Mirrors the cache-miss/cache-hit shape already covered for the exact EIP-3009/Permit2
and upto Permit2 settle paths (see `test_facilitator.py::TestEip3009PendingSettlementStore`
and `test_upto_facilitator.py::TestUptoPermit2PendingSettlementStore`), but for the
batch-settlement deposit path (`deposit.py::settle_deposit` /
`deposit.py::_reconcile_pending_deposit`). Prior to this file, the deposit settle path's
pending-store integration (both the cache-miss population and the cache-hit
reconciliation/skip-verify behavior) had no dedicated coverage.

Heavy monkeypatching of `verify_deposit` / `_resolve_deposit_execution` /
`_resolve_deposit_transfer_method` / `read_channel_state` mirrors the pattern used by
`test_scheme.py::TestSettleReceiptWait` to isolate the pending-store bookkeeping from the
(separately tested) verify/execution-resolution logic.
"""

from __future__ import annotations

import pytest

try:
    from eth_utils import to_checksum_address  # noqa: F401  (import guards evm extras)

    from x402.mechanisms.evm.batch_settlement.facilitator import deposit as deposit_mod
    from x402.mechanisms.evm.batch_settlement.facilitator.deposit import (
        _deposit_settlement_cache_key,
        settle_deposit,
    )
    from x402.mechanisms.evm.batch_settlement.types import (
        ChannelConfig,
        ChannelState,
        DepositAuthorization,
        DepositFields,
        DepositPayload,
        Erc3009Authorization,
        VoucherFields,
    )
    from x402.mechanisms.evm.constants import ERR_SETTLEMENT_PENDING, TX_STATUS_SUCCESS
    from x402.pending_settlement_store import InMemoryPendingSettlementStore
    from x402.schemas import PaymentPayload, PaymentRequirements, VerifyResponse
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


NETWORK = "eip155:8453"
PAYER = "0x1111111111111111111111111111111111111111"
TOKEN = "0x5555555555555555555555555555555555555555"
CHANNEL_ID = "0x" + "ab" * 32
SIGNATURE = "0x" + "33" * 65
TX_HASH = "0x" + "cd" * 32


def _channel_config() -> ChannelConfig:
    return ChannelConfig(
        payer=PAYER,
        payer_authorizer=PAYER,
        receiver="0x3333333333333333333333333333333333333333",
        receiver_authorizer="0x4444444444444444444444444444444444444444",
        token=TOKEN,
        withdraw_delay=900,
        salt="0x" + "00" * 32,
    )


def _deposit_payload(signature: str = SIGNATURE) -> DepositPayload:
    p = DepositPayload()
    p.channel_config = _channel_config()
    p.voucher = VoucherFields(
        channel_id=CHANNEL_ID, max_claimable_amount="1000", signature="0x" + "11" * 65
    )
    p.deposit = DepositFields(
        amount="500",
        authorization=DepositAuthorization(
            erc3009_authorization=Erc3009Authorization(
                valid_after="0",
                valid_before="99999999999",
                salt="0x" + "22" * 32,
                signature=signature,
            )
        ),
    )
    return p


def _requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="batch-settlement",
        network=NETWORK,
        asset=TOKEN,
        amount="500",
        pay_to="0x3333333333333333333333333333333333333333",
        max_timeout_seconds=60,
        extra={},
    )


def _dummy_payment() -> PaymentPayload:
    return PaymentPayload(x402_version=2, payload={}, accepted=_requirements())


def _valid_verify_response() -> VerifyResponse:
    return VerifyResponse(
        is_valid=True,
        payer=PAYER,
        extra={
            "balance": "0",
            "totalClaimed": "0",
            "withdrawRequestedAt": 0,
            "refundNonce": "0",
        },
    )


def _channel_state() -> ChannelState:
    return ChannelState(balance=500, total_claimed=0, withdraw_requested_at=0, refund_nonce=0)


class _FakeReceipt:
    status = TX_STATUS_SUCCESS


class _Signer:
    """Minimal signer stub covering only what the deposit settle path needs."""

    def __init__(self, receipt_error: Exception | None = None, tx_hash: str = TX_HASH) -> None:
        self.write_calls = 0
        self._receipt_error = receipt_error
        self._tx_hash = tx_hash

    def write_contract(self, *args, **kwargs) -> str:
        self.write_calls += 1
        return self._tx_hash

    def wait_for_transaction_receipt(self, tx_hash: str) -> _FakeReceipt:
        if self._receipt_error is not None:
            raise self._receipt_error
        return _FakeReceipt()


@pytest.fixture(autouse=True)
def _patch_transfer_method(monkeypatch):
    """Every fixture here uses the eip3009 transfer method (direct, no extension signer)."""
    monkeypatch.setattr(deposit_mod, "_resolve_deposit_transfer_method", lambda *a, **k: "eip3009")
    monkeypatch.setattr(
        deposit_mod, "_deploy_erc3009_counterfactual_if_needed", lambda *a, **k: None
    )


class TestDepositPendingSettlementStoreCacheMiss:
    def test_broadcast_success_leaves_store_empty(self, monkeypatch):
        payload = _deposit_payload()
        signer = _Signer()
        store = InMemoryPendingSettlementStore()
        monkeypatch.setattr(deposit_mod, "verify_deposit", lambda *a, **k: _valid_verify_response())
        monkeypatch.setattr(
            deposit_mod,
            "_resolve_deposit_execution",
            lambda *a, **k: deposit_mod._DepositExecution(
                kind="direct",
                collector="0x9999999999999999999999999999999999999999",
                collector_data=b"",
            ),
        )
        monkeypatch.setattr(deposit_mod, "read_channel_state", lambda *a, **k: _channel_state())

        out = settle_deposit(
            signer, _dummy_payment(), payload, _requirements(), pending_store=store
        )

        assert out.success is True
        assert out.transaction == TX_HASH
        assert store.get(_deposit_settlement_cache_key(payload, _requirements())) is None

    def test_receipt_wait_failure_populates_store_with_broadcast_hash(self, monkeypatch):
        payload = _deposit_payload()
        signer = _Signer(receipt_error=TimeoutError("rpc: timeout waiting for receipt"))
        store = InMemoryPendingSettlementStore()
        monkeypatch.setattr(deposit_mod, "verify_deposit", lambda *a, **k: _valid_verify_response())
        monkeypatch.setattr(
            deposit_mod,
            "_resolve_deposit_execution",
            lambda *a, **k: deposit_mod._DepositExecution(
                kind="direct",
                collector="0x9999999999999999999999999999999999999999",
                collector_data=b"",
            ),
        )

        out = settle_deposit(
            signer, _dummy_payment(), payload, _requirements(), pending_store=store
        )

        assert out.success is False
        assert out.error_reason == ERR_SETTLEMENT_PENDING
        assert out.transaction == TX_HASH
        assert store.get(_deposit_settlement_cache_key(payload, _requirements())) == TX_HASH
        assert signer.write_calls == 1


class TestDepositPendingSettlementStoreCacheHit:
    def test_skips_verify_and_broadcast_then_reconciles_success(self, monkeypatch):
        payload = _deposit_payload()
        store = InMemoryPendingSettlementStore()
        cache_key = _deposit_settlement_cache_key(payload, _requirements())
        store.set(cache_key, TX_HASH)
        signer = _Signer()
        monkeypatch.setattr(
            deposit_mod,
            "verify_deposit",
            lambda *a, **k: (_ for _ in ()).throw(
                AssertionError("verify_deposit must be skipped on a pending-store hit")
            ),
        )
        monkeypatch.setattr(
            deposit_mod,
            "_resolve_deposit_execution",
            lambda *a, **k: (_ for _ in ()).throw(
                AssertionError("_resolve_deposit_execution must be skipped on a pending-store hit")
            ),
        )
        monkeypatch.setattr(deposit_mod, "read_channel_state", lambda *a, **k: _channel_state())

        out = settle_deposit(
            signer, _dummy_payment(), payload, _requirements(), pending_store=store
        )

        assert out.success is True
        assert out.transaction == TX_HASH
        assert signer.write_calls == 0  # no second broadcast
        assert store.get(cache_key) is None  # cleared once confirmed
        assert out.extra is not None
        assert out.extra["channelState"]["balance"] == "500"

    def test_still_unconfirmed_returns_settlement_pending_again(self, monkeypatch):
        payload = _deposit_payload()
        store = InMemoryPendingSettlementStore()
        cache_key = _deposit_settlement_cache_key(payload, _requirements())
        store.set(cache_key, TX_HASH)
        signer = _Signer(receipt_error=TimeoutError("rpc: timeout waiting for receipt"))
        monkeypatch.setattr(
            deposit_mod,
            "verify_deposit",
            lambda *a, **k: (_ for _ in ()).throw(
                AssertionError("verify_deposit must be skipped on a pending-store hit")
            ),
        )

        out = settle_deposit(
            signer, _dummy_payment(), payload, _requirements(), pending_store=store
        )

        assert out.success is False
        assert out.error_reason == ERR_SETTLEMENT_PENDING
        assert out.transaction == TX_HASH
        assert store.get(cache_key) == TX_HASH  # re-marked pending, not lost
        assert signer.write_calls == 0  # never re-broadcast


class TestDepositPendingSettlementStoreTerminalVerifyFailure:
    def test_verify_failure_is_terminal_and_never_touches_store(self, monkeypatch):
        payload = _deposit_payload()
        signer = _Signer()
        store = InMemoryPendingSettlementStore()
        monkeypatch.setattr(
            deposit_mod,
            "verify_deposit",
            lambda *a, **k: VerifyResponse(
                is_valid=False, invalid_reason="insufficient_balance", payer=PAYER
            ),
        )

        out = settle_deposit(
            signer, _dummy_payment(), payload, _requirements(), pending_store=store
        )

        assert out.success is False
        assert out.error_reason == "insufficient_balance"
        assert store.get(_deposit_settlement_cache_key(payload, _requirements())) is None
        assert signer.write_calls == 0


class TestDepositSettlementCacheKey:
    def test_uses_erc3009_signature_when_present(self):
        payload = _deposit_payload(signature="0x" + "77" * 65)
        assert _deposit_settlement_cache_key(payload, _requirements()) == "0x" + "77" * 65

    def test_empty_when_no_authorization_signature_available(self):
        payload = _deposit_payload()
        payload.deposit.authorization.erc3009_authorization = None
        assert _deposit_settlement_cache_key(payload, _requirements()) == ""

    def test_uses_permit2_signature_when_transfer_method_resolves_to_permit2(self, monkeypatch):
        """The cache key must key on the authorization for the transfer method
        `requirements` actually resolves to, not just whichever authorization field
        happens to be populated — a payload carrying both shapes (or the wrong one for
        the resolved method) must not accidentally key on the unused erc3009 signature.
        Mirrors Go/TS.
        """
        # This test needs the real resolver, not the file's autouse eip3009-only stub.
        monkeypatch.undo()

        from x402.mechanisms.evm.batch_settlement.types import (
            Permit2Authorization,
            Permit2DepositWitness,
            Permit2TokenPermissions,
        )

        payload = _deposit_payload(signature="0x" + "77" * 65)
        payload.deposit.authorization.permit2_authorization = Permit2Authorization(
            from_address=PAYER,
            permitted=Permit2TokenPermissions(token=TOKEN, amount="500"),
            spender="0x000000000022D473030F116dDEE9F6B43aC78BA3",
            nonce="1",
            deadline="99999999999",
            witness=Permit2DepositWitness(channel_id=CHANNEL_ID),
            signature="0x" + "88" * 65,
        )
        requirements = PaymentRequirements(
            scheme="batch-settlement",
            network=NETWORK,
            asset=TOKEN,
            amount="500",
            pay_to="0x3333333333333333333333333333333333333333",
            max_timeout_seconds=60,
            extra={"assetTransferMethod": "permit2"},
        )

        assert _deposit_settlement_cache_key(payload, requirements) == "0x" + "88" * 65
