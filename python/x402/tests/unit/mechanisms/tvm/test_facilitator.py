"""Tests for the exact TVM facilitator scheme."""

from __future__ import annotations

import time
from dataclasses import dataclass

import pytest

pytest.importorskip("pytoniq_core")

from pytoniq_core import begin_cell

import x402.mechanisms.tvm.exact.facilitator as facilitator_module
from x402.mechanisms.tvm import (
    DEFAULT_SETTLEMENT_CONFIRMATION_WORKERS,
    TVM_TESTNET,
    SettlementCache,
    TvmAccountState,
)
from x402.mechanisms.tvm.constants import (
    DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT,
    DEFAULT_TVM_OUTER_GAS_BUFFER,
    ERR_EXACT_TVM_ACCOUNT_FROZEN,
    ERR_EXACT_TVM_DUPLICATE_SETTLEMENT,
    ERR_EXACT_TVM_FACILITATOR_INSUFFICIENT_BALANCE,
    ERR_EXACT_TVM_INVALID_AMOUNT,
    ERR_EXACT_TVM_INVALID_ASSET,
    ERR_EXACT_TVM_INVALID_JETTON_TRANSFER,
    ERR_EXACT_TVM_INVALID_PAYLOAD,
    ERR_EXACT_TVM_INVALID_RECIPIENT,
    ERR_EXACT_TVM_INVALID_SIGNATURE,
    ERR_EXACT_TVM_INVALID_UNTIL_EXPIRED,
    ERR_EXACT_TVM_NETWORK_MISMATCH,
    ERR_EXACT_TVM_SIMULATION_FAILED,
    ERR_EXACT_TVM_TON_AMOUNT_TOO_HIGH,
    ERR_EXACT_TVM_TRANSACTION_FAILED,
    ERR_EXACT_TVM_UNSUPPORTED_NETWORK,
    ERR_EXACT_TVM_UNSUPPORTED_SCHEME,
    ERR_EXACT_TVM_UNSUPPORTED_VERSION,
    ERR_EXACT_TVM_VALID_UNTIL_TOO_FAR,
)
from x402.mechanisms.tvm.exact import ExactTvmFacilitatorScheme
from x402.mechanisms.tvm.trace_utils import body_hash_to_base64

from .builders import (
    ASSET,
    FACILITATOR,
    PAYER,
    SOURCE_WALLET,
    SPONSORED_FORWARDING_EXTRA,
    make_tvm_payload,
    make_tvm_requirements,
    make_tvm_settlement,
)
from .fakes import FacilitatorSignerStub


class _FakeBatcher:
    def __init__(
        self,
        signer,
        settlement_cache,
        *,
        flush_interval_seconds: float,
        batch_flush_size: int,
        confirmation_workers: int,
        confirmation_timeout_seconds: float,
        settlement_verifier,
    ) -> None:
        _ = signer, settlement_cache, flush_interval_seconds, batch_flush_size
        _ = confirmation_timeout_seconds, settlement_verifier
        self.confirmation_workers = confirmation_workers
        self.enqueued: list[object] = []
        self.result = facilitator_module._BatchResult(success=True, transaction="trace-tx-hash")
        self.error: Exception | None = None

    def enqueue(self, queued_settlement):
        self.enqueued.append(queued_settlement)
        if self.error is not None:
            raise self.error
        return self.result


def _assert_invalid_verify(result, reason: str, *, message: str | None = None) -> None:
    assert result.is_valid is False
    assert result.invalid_reason == reason
    if message is not None:
        assert result.invalid_message == message


def _assert_failed_settlement(result, reason: str, *, message: str | None = None) -> None:
    assert result.success is False
    assert result.error_reason == reason
    assert result.transaction == ""
    assert result.network == TVM_TESTNET
    if message is not None:
        assert result.error_message == message


def _make_requirements(**overrides):
    return make_tvm_requirements(default_extra=SPONSORED_FORWARDING_EXTRA, **overrides)


def _make_payload(**overrides):
    return make_tvm_payload(default_accepted_extra=SPONSORED_FORWARDING_EXTRA, **overrides)


@dataclass
class _FacilitatorEnv:
    facilitator: ExactTvmFacilitatorScheme
    signer: FacilitatorSignerStub
    settlement: object
    batchers: list[_FakeBatcher]

    def batcher(self) -> _FakeBatcher:
        return self.batchers[-1]


@pytest.fixture
def facilitator_env(monkeypatch):
    batchers: list[_FakeBatcher] = []

    def _batcher_factory(*args, **kwargs):
        batcher = _FakeBatcher(*args, **kwargs)
        batchers.append(batcher)
        return batcher

    signer = FacilitatorSignerStub()
    settlement = make_tvm_settlement()
    monkeypatch.setattr(facilitator_module, "_SettlementBatcher", _batcher_factory)
    monkeypatch.setattr(facilitator_module, "parse_exact_tvm_payload", lambda boc: settlement)
    monkeypatch.setattr(
        facilitator_module,
        "parse_active_w5_account_state",
        lambda account: facilitator_module.W5InitData(
            signature_allowed=True,
            seqno=settlement.seqno,
            wallet_id=settlement.wallet_id,
            public_key=b"\x01" * 32,
            extensions_dict=None,
        ),
    )
    monkeypatch.setattr(facilitator_module, "verify_w5_signature", lambda *args: True)
    monkeypatch.setattr(
        facilitator_module,
        "trace_transaction_storage_fees",
        lambda tx: 10_000,
    )
    monkeypatch.setattr(
        facilitator_module,
        "trace_transaction_compute_fees",
        lambda tx: 20_000,
    )
    monkeypatch.setattr(
        facilitator_module,
        "trace_transaction_fwd_fees",
        lambda tx, **kwargs: 30_000,
    )
    monkeypatch.setattr(
        ExactTvmFacilitatorScheme,
        "_verify_finalized_trace_settlement",
        staticmethod(lambda *args, **kwargs: {"hash": "payer-tx"}),
    )

    facilitator = ExactTvmFacilitatorScheme(signer, SettlementCache())
    return _FacilitatorEnv(
        facilitator=facilitator,
        signer=signer,
        settlement=settlement,
        batchers=batchers,
    )


class TestExactTvmFacilitatorSchemeConstructor:
    def test_should_create_instance_with_correct_scheme(self, facilitator_env):
        facilitator = facilitator_env.facilitator

        assert facilitator.scheme == "exact"
        assert facilitator.caip_family == "tvm:*"

    def test_should_return_supported_extra_and_signers(self, facilitator_env):
        facilitator = facilitator_env.facilitator

        assert facilitator.get_extra(TVM_TESTNET) == {"areFeesSponsored": True}
        assert facilitator.get_extra("tvm:123") is None
        assert facilitator.get_signers(TVM_TESTNET) == [FACILITATOR]

    def test_should_use_default_confirmation_worker_count(self, facilitator_env):
        batcher = facilitator_env.batcher()

        assert batcher.confirmation_workers == DEFAULT_SETTLEMENT_CONFIRMATION_WORKERS


class TestVerify:
    @pytest.mark.parametrize(
        ("payload_overrides", "requirements_overrides", "expected_reason"),
        [
            pytest.param(
                {"x402_version": 1},
                {},
                ERR_EXACT_TVM_UNSUPPORTED_VERSION,
                id="unsupported-x402-version",
            ),
            pytest.param(
                {"accepted_scheme": "wrong"},
                {},
                ERR_EXACT_TVM_UNSUPPORTED_SCHEME,
                id="wrong-scheme",
            ),
            pytest.param(
                {"accepted_network": "tvm:123"},
                {"network": "tvm:123"},
                ERR_EXACT_TVM_UNSUPPORTED_NETWORK,
                id="unsupported-network",
            ),
            pytest.param(
                {"accepted_network": "tvm:-239"},
                {"network": TVM_TESTNET},
                ERR_EXACT_TVM_NETWORK_MISMATCH,
                id="network-mismatch",
            ),
            pytest.param(
                {"accepted_amount": "101"},
                {"amount": "100"},
                ERR_EXACT_TVM_INVALID_AMOUNT,
                id="amount-mismatch",
            ),
            pytest.param(
                {"payload_asset": "0:" + "9" * 64},
                {},
                ERR_EXACT_TVM_INVALID_ASSET,
                id="asset-mismatch",
            ),
            pytest.param(
                {"accepted_pay_to": "0:" + "8" * 64},
                {},
                ERR_EXACT_TVM_INVALID_RECIPIENT,
                id="payee-mismatch",
            ),
            pytest.param(
                {"accepted_extra": {"forwardTonAmount": "1"}},
                {},
                ERR_EXACT_TVM_INVALID_JETTON_TRANSFER,
                id="forward-amount-mismatch",
            ),
        ],
    )
    def test_should_reject_invalid_payment_metadata(
        self,
        facilitator_env,
        payload_overrides,
        requirements_overrides,
        expected_reason,
    ):
        facilitator = facilitator_env.facilitator

        result = facilitator.verify(
            _make_payload(**payload_overrides),
            _make_requirements(**requirements_overrides),
        )

        _assert_invalid_verify(result, expected_reason)

    def test_should_reject_forward_payload_mismatch(self, facilitator_env, monkeypatch):
        facilitator = facilitator_env.facilitator
        monkeypatch.setattr(
            facilitator_module,
            "parse_exact_tvm_payload",
            lambda boc: make_tvm_settlement(
                forward_payload=begin_cell().store_uint(0xABCD, 16).end_cell()
            ),
        )

        result = facilitator.verify(_make_payload(), _make_requirements())

        _assert_invalid_verify(result, ERR_EXACT_TVM_INVALID_JETTON_TRANSFER)

    def test_should_reject_attached_ton_amount_above_reasonable_cap(
        self, facilitator_env, monkeypatch
    ):
        facilitator = facilitator_env.facilitator
        monkeypatch.setattr(
            facilitator_module,
            "parse_exact_tvm_payload",
            lambda boc: make_tvm_settlement(
                attached_ton_amount=DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT + 1,
            ),
        )

        result = facilitator.verify(_make_payload(), _make_requirements())

        _assert_invalid_verify(result, ERR_EXACT_TVM_TON_AMOUNT_TOO_HIGH)

    def test_should_reject_payload_missing_settlement_boc(self, facilitator_env):
        facilitator = facilitator_env.facilitator

        result = facilitator.verify(
            _make_payload(payload={"asset": ASSET}),
            _make_requirements(),
        )

        _assert_invalid_verify(
            result,
            ERR_EXACT_TVM_INVALID_PAYLOAD,
            message="Exact TVM payload field 'settlementBoc' is required",
        )

    def test_should_reject_expired_settlement(self, facilitator_env, monkeypatch):
        facilitator = facilitator_env.facilitator
        settlement = facilitator_env.settlement
        monkeypatch.setattr(
            facilitator_module,
            "parse_exact_tvm_payload",
            lambda boc: make_tvm_settlement(
                valid_until=int(time.time()) - 1,
                seqno=settlement.seqno,
            ),
        )

        result = facilitator.verify(_make_payload(), _make_requirements())

        _assert_invalid_verify(result, ERR_EXACT_TVM_INVALID_UNTIL_EXPIRED)

    def test_should_reject_valid_until_beyond_timeout(self, facilitator_env, monkeypatch):
        facilitator = facilitator_env.facilitator
        monkeypatch.setattr(
            facilitator_module,
            "parse_exact_tvm_payload",
            lambda boc: make_tvm_settlement(valid_until=int(time.time()) + 600),
        )

        result = facilitator.verify(_make_payload(), _make_requirements(max_timeout_seconds=300))

        _assert_invalid_verify(result, ERR_EXACT_TVM_VALID_UNTIL_TOO_FAR)

    def test_should_reject_invalid_signature(self, facilitator_env, monkeypatch):
        facilitator = facilitator_env.facilitator
        monkeypatch.setattr(facilitator_module, "verify_w5_signature", lambda *args: False)

        result = facilitator.verify(_make_payload(), _make_requirements())

        _assert_invalid_verify(result, ERR_EXACT_TVM_INVALID_SIGNATURE)

    def test_should_reject_frozen_account_state(self, facilitator_env):
        facilitator = facilitator_env.facilitator
        signer = facilitator_env.signer
        signer.account_state = TvmAccountState(
            address=PAYER,
            balance=0,
            is_active=False,
            is_frozen=True,
            is_uninitialized=False,
            state_init=None,
        )

        result = facilitator.verify(_make_payload(), _make_requirements())

        _assert_invalid_verify(result, ERR_EXACT_TVM_ACCOUNT_FROZEN)

    def test_should_reject_facilitator_with_insufficient_ton_balance(self, facilitator_env):
        facilitator = facilitator_env.facilitator
        signer = facilitator_env.signer
        signer.facilitator_account_state = TvmAccountState(
            address=signer.facilitator_account_state.address,
            balance=1_000_000_000,
            is_active=True,
            is_frozen=False,
            is_uninitialized=False,
            state_init=None,
        )

        result = facilitator.verify(_make_payload(), _make_requirements())

        _assert_invalid_verify(result, ERR_EXACT_TVM_FACILITATOR_INSUFFICIENT_BALANCE)

    def test_should_ignore_settlement_state_init_for_active_account(
        self, facilitator_env, monkeypatch
    ):
        facilitator = facilitator_env.facilitator
        signer = facilitator_env.signer
        parse_active_calls: list[TvmAccountState] = []

        def _parse_active(account: TvmAccountState) -> facilitator_module.W5InitData:
            parse_active_calls.append(account)
            return facilitator_module.W5InitData(
                signature_allowed=True,
                seqno=12,
                wallet_id=777,
                public_key=b"\x01" * 32,
                extensions_dict=None,
            )

        monkeypatch.setattr(facilitator_module, "parse_active_w5_account_state", _parse_active)
        monkeypatch.setattr(
            facilitator_module,
            "parse_w5_init_data",
            lambda state_init: pytest.fail("active accounts should use on-chain state"),
        )
        monkeypatch.setattr(
            facilitator_module,
            "parse_exact_tvm_payload",
            lambda boc: make_tvm_settlement(state_init=object()),
        )

        result = facilitator.verify(_make_payload(), _make_requirements())

        assert result.is_valid is True
        assert parse_active_calls == [signer.account_state]

    def test_should_return_valid_response_for_matching_payload(self, facilitator_env):
        facilitator = facilitator_env.facilitator

        result = facilitator.verify(_make_payload(), _make_requirements())

        assert result.is_valid is True
        assert result.payer == PAYER


class TestSettle:
    @pytest.mark.parametrize(
        ("payload_overrides", "requirements_overrides", "expected_reason"),
        [
            pytest.param(
                {"x402_version": 1},
                {},
                ERR_EXACT_TVM_UNSUPPORTED_VERSION,
                id="unsupported-x402-version",
            ),
            pytest.param(
                {"accepted_scheme": "wrong"},
                {},
                ERR_EXACT_TVM_UNSUPPORTED_SCHEME,
                id="verification-fails",
            ),
        ],
    )
    def test_should_fail_settlement_for_invalid_payment_metadata(
        self,
        facilitator_env,
        payload_overrides,
        requirements_overrides,
        expected_reason,
    ):
        facilitator = facilitator_env.facilitator

        result = facilitator.settle(
            _make_payload(**payload_overrides),
            _make_requirements(**requirements_overrides),
        )

        _assert_failed_settlement(result, expected_reason)

    def test_should_fail_settlement_when_payload_is_missing_required_field(self, facilitator_env):
        facilitator = facilitator_env.facilitator

        result = facilitator.settle(
            _make_payload(payload={"settlementBoc": "base64-boc=="}),
            _make_requirements(),
        )

        _assert_failed_settlement(
            result,
            ERR_EXACT_TVM_INVALID_PAYLOAD,
            message="Exact TVM payload field 'asset' is required",
        )

    def test_should_reject_duplicate_settlement(self, facilitator_env):
        facilitator = facilitator_env.facilitator

        first = facilitator.settle(_make_payload(), _make_requirements())
        second = facilitator.settle(_make_payload(), _make_requirements())

        assert first.success is True
        _assert_failed_settlement(second, ERR_EXACT_TVM_DUPLICATE_SETTLEMENT)
        assert second.payer == PAYER

    def test_should_return_successful_settlement_response(self, facilitator_env):
        facilitator = facilitator_env.facilitator
        batcher = facilitator_env.batcher()

        result = facilitator.settle(_make_payload(), _make_requirements())

        assert result.success is True
        assert result.transaction == "trace-tx-hash"
        assert result.payer == PAYER
        assert result.network == TVM_TESTNET
        assert len(batcher.enqueued) == 1
        queued = batcher.enqueued[0]
        assert queued.network == TVM_TESTNET
        assert queued.settlement_hash == "settlement-hash-1"
        assert queued.relay_request.destination == PAYER
        assert queued.relay_request.relay_amount == (
            500_000 + 10_000 + 20_000 + 30_000 + DEFAULT_TVM_OUTER_GAS_BUFFER
        )

    def test_should_convert_batcher_exceptions_into_transaction_failed(self, facilitator_env):
        facilitator = facilitator_env.facilitator
        batcher = facilitator_env.batcher()
        batcher.error = RuntimeError("boom")

        result = facilitator.settle(_make_payload(), _make_requirements())

        _assert_failed_settlement(result, ERR_EXACT_TVM_TRANSACTION_FAILED, message="boom")

    def test_should_map_unexpected_verification_exception_to_simulation_failed(
        self, facilitator_env, monkeypatch
    ):
        facilitator = facilitator_env.facilitator
        monkeypatch.setattr(
            facilitator_module,
            "parse_exact_tvm_payload",
            lambda boc: (_ for _ in ()).throw(RuntimeError("decode crashed")),
        )

        result = facilitator.settle(_make_payload(), _make_requirements())

        _assert_failed_settlement(
            result,
            ERR_EXACT_TVM_SIMULATION_FAILED,
            message="decode crashed",
        )


def _make_trace(
    *,
    include_payer_tx: bool = True,
    payer_tx_success: bool = True,
    include_matching_payer_out_msg: bool = True,
    include_source_wallet_tx: bool = True,
    payer_hash: str | None = "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=",
    payer_hash_norm: str | None = "payer-tx-hash-norm",
):
    settlement = make_tvm_settlement()
    transactions: dict[str, object] = {}
    if include_payer_tx:
        transactions["payer"] = {
            "hash": payer_hash,
            **({"hash_norm": payer_hash_norm} if payer_hash_norm is not None else {}),
            "account": PAYER,
            "description": {
                "aborted": not payer_tx_success,
                "compute_ph": {"success": payer_tx_success, "skipped": False},
                "action": {"success": payer_tx_success},
            },
            "in_msg": {
                "message_content": {"hash": body_hash_to_base64(settlement.body.hash)},
            },
            "out_msgs": (
                [
                    {
                        "hash": "payer-out-hash",
                        "destination": SOURCE_WALLET,
                        "message_content": {
                            "hash": body_hash_to_base64(settlement.transfer.body_hash or b""),
                        },
                    }
                ]
                if include_matching_payer_out_msg
                else []
            ),
        }
    if include_source_wallet_tx:
        transactions["source"] = {
            "hash": "source-tx-hash",
            "account": SOURCE_WALLET,
            "description": {
                "aborted": False,
                "compute_ph": {"success": True, "skipped": False},
                "action": {"success": True},
            },
            "in_msg": {
                "hash": "payer-out-hash",
            },
        }
    return settlement, {"transactions": transactions}


class TestVerifyFinalizedTraceSettlement:
    def test_should_fail_when_trace_has_no_matching_payer_wallet_transaction(self):
        settlement, trace = _make_trace(include_payer_tx=False)

        with pytest.raises(ValueError, match="expected payer wallet transaction"):
            ExactTvmFacilitatorScheme._verify_finalized_trace_settlement(
                trace,
                settlement=settlement,
            )

    def test_should_ignore_failed_payer_wallet_transactions(self):
        settlement, trace = _make_trace(payer_tx_success=False)

        with pytest.raises(ValueError, match="expected payer wallet transaction"):
            ExactTvmFacilitatorScheme._verify_finalized_trace_settlement(
                trace,
                settlement=settlement,
            )

    def test_should_fail_when_payer_wallet_transaction_has_no_matching_out_message(self):
        settlement, trace = _make_trace(include_matching_payer_out_msg=False)

        with pytest.raises(ValueError, match="missing out message hash"):
            ExactTvmFacilitatorScheme._verify_finalized_trace_settlement(
                trace,
                settlement=settlement,
            )

    def test_should_fail_when_trace_has_no_matching_source_wallet_transaction(self):
        settlement, trace = _make_trace(include_source_wallet_tx=False)

        with pytest.raises(ValueError, match="expected source jetton wallet transaction"):
            ExactTvmFacilitatorScheme._verify_finalized_trace_settlement(
                trace,
                settlement=settlement,
            )

    def test_should_fail_when_payer_wallet_transaction_has_no_hash(self):
        settlement, trace = _make_trace(payer_hash="", payer_hash_norm="")

        with pytest.raises(ValueError, match="missing transaction hash"):
            ExactTvmFacilitatorScheme._verify_finalized_trace_settlement(
                trace,
                settlement=settlement,
            )

    def test_should_return_payer_transaction_hash_for_valid_trace(self):
        settlement, trace = _make_trace(
            payer_hash="q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=",
            payer_hash_norm="q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=",
        )

        result = ExactTvmFacilitatorScheme._verify_finalized_trace_settlement(
            trace,
            settlement=settlement,
        )

        assert result == "ab" * 32

    def test_should_prefer_normalized_payer_transaction_hash_when_present(self):
        settlement, trace = _make_trace(
            payer_hash="q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=",
            payer_hash_norm="zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMw=",
        )

        result = ExactTvmFacilitatorScheme._verify_finalized_trace_settlement(
            trace,
            settlement=settlement,
        )

        assert result == "cc" * 32

    def test_should_return_payer_transaction_object_when_requested(self):
        settlement, trace = _make_trace(payer_hash_norm=None)

        result = ExactTvmFacilitatorScheme._verify_finalized_trace_settlement(
            trace,
            settlement=settlement,
            return_transaction=True,
        )

        assert result["hash"] == "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s="
