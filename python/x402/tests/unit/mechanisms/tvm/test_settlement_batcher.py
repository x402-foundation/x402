"""Tests for TVM settlement batching failure paths."""

from __future__ import annotations

import pytest

from x402.mechanisms.tvm.constants import (
    ERR_EXACT_TVM_SIMULATION_FAILED,
    ERR_EXACT_TVM_TRANSACTION_FAILED,
)
from x402.mechanisms.tvm.exact.settlement_batcher import (
    _PendingConfirmation,
    _QueuedSettlement,
    _SettlementBatcher,
)

TVM_TESTNET = "tvm:-3"


class _StopWorker(Exception):
    pass


class _ReleaseSpyCache:
    def __init__(self) -> None:
        self._queued_by_key: dict[str, _QueuedSettlement] = {}
        self.release_checks: list[dict[str, object]] = []

    def register(self, queued: _QueuedSettlement) -> None:
        self._queued_by_key[queued.settlement_hash] = queued

    def release(self, key: str) -> None:
        queued = self._queued_by_key[key]
        self.release_checks.append(
            {
                "key": key,
                "completed": queued.completed.is_set(),
                "error_reason": None if queued.result is None else queued.result.error_reason,
                "success": None if queued.result is None else queued.result.success,
            }
        )


class _SinglePendingQueue:
    def __init__(self, pending: _PendingConfirmation) -> None:
        self._pending = pending
        self._consumed = False

    def get(self) -> _PendingConfirmation:
        if self._consumed:
            raise _StopWorker()
        self._consumed = True
        return self._pending


class _BuildFailureSigner:
    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def build_relay_external_boc_batch(self, network: str, requests: list[object]) -> bytes:
        _ = network, requests
        raise self._exc


class _ConfirmationFailureSigner:
    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    def wait_for_trace_confirmation(
        self,
        network: str,
        trace_external_hash_norm: str,
        *,
        timeout_seconds: float,
    ) -> dict[str, object]:
        _ = network, trace_external_hash_norm, timeout_seconds
        raise self._exc


class _ConfirmedSigner:
    def wait_for_trace_confirmation(
        self,
        network: str,
        trace_external_hash_norm: str,
        *,
        timeout_seconds: float,
    ) -> dict[str, object]:
        _ = network, trace_external_hash_norm, timeout_seconds
        return {"transactions": {}}


def _make_batcher(
    *,
    signer: object,
    settlement_cache: _ReleaseSpyCache,
    settlement_verifier,
) -> _SettlementBatcher:
    batcher = object.__new__(_SettlementBatcher)
    batcher._signer = signer
    batcher._settlement_cache = settlement_cache
    batcher._confirmation_timeout_seconds = 30.0
    batcher._settlement_verifier = settlement_verifier
    return batcher


def _make_queued_settlement(settlement_hash: str = "settlement-hash") -> _QueuedSettlement:
    return _QueuedSettlement(
        network=TVM_TESTNET,
        settlement_hash=settlement_hash,
        settlement=object(),
        relay_request=object(),
    )


def test_flush_batch_releases_only_after_result_and_completion_on_send_failure():
    queued = _make_queued_settlement()
    cache = _ReleaseSpyCache()
    cache.register(queued)
    batcher = _make_batcher(
        signer=_BuildFailureSigner(RuntimeError("send failed")),
        settlement_cache=cache,
        settlement_verifier=lambda trace_data, settlement: "unused",
    )

    batcher._flush_batch(TVM_TESTNET, [queued])

    assert queued.completed.is_set() is True
    assert queued.result is not None
    assert queued.result.error_reason == ERR_EXACT_TVM_TRANSACTION_FAILED
    assert cache.release_checks == [
        {
            "key": queued.settlement_hash,
            "completed": True,
            "error_reason": ERR_EXACT_TVM_TRANSACTION_FAILED,
            "success": False,
        }
    ]


def test_confirmation_worker_releases_only_after_result_and_completion_on_wait_failure():
    queued = _make_queued_settlement()
    cache = _ReleaseSpyCache()
    cache.register(queued)
    batcher = _make_batcher(
        signer=_ConfirmationFailureSigner(ValueError("trace wait failed")),
        settlement_cache=cache,
        settlement_verifier=lambda trace_data, settlement: "unused",
    )
    batcher._confirmation_queue = _SinglePendingQueue(
        _PendingConfirmation(
            network=TVM_TESTNET,
            batch=[queued],
            trace_external_hash_norm="trace-hash",
        )
    )

    with pytest.raises(_StopWorker):
        batcher._run_confirmation_worker()

    assert queued.completed.is_set() is True
    assert queued.result is not None
    assert queued.result.error_reason == ERR_EXACT_TVM_SIMULATION_FAILED
    assert cache.release_checks == [
        {
            "key": queued.settlement_hash,
            "completed": True,
            "error_reason": ERR_EXACT_TVM_SIMULATION_FAILED,
            "success": False,
        }
    ]


def test_confirmation_worker_releases_after_completion_on_success():
    queued = _make_queued_settlement()
    cache = _ReleaseSpyCache()
    cache.register(queued)
    batcher = _make_batcher(
        signer=_ConfirmedSigner(),
        settlement_cache=cache,
        settlement_verifier=lambda trace_data, settlement: "tx-hash",
    )
    batcher._confirmation_queue = _SinglePendingQueue(
        _PendingConfirmation(
            network=TVM_TESTNET,
            batch=[queued],
            trace_external_hash_norm="trace-hash",
        )
    )

    with pytest.raises(_StopWorker):
        batcher._run_confirmation_worker()

    assert queued.completed.is_set() is True
    assert queued.result is not None
    assert queued.result.success is True
    assert queued.result.transaction == "tx-hash"
    assert cache.release_checks == [
        {
            "key": queued.settlement_hash,
            "completed": True,
            "error_reason": None,
            "success": True,
        }
    ]


def test_confirmation_worker_releases_only_after_result_and_completion_on_verify_failure():
    queued = _make_queued_settlement()
    cache = _ReleaseSpyCache()
    cache.register(queued)
    batcher = _make_batcher(
        signer=_ConfirmedSigner(),
        settlement_cache=cache,
        settlement_verifier=lambda trace_data, settlement: (_ for _ in ()).throw(
            RuntimeError("verification failed")
        ),
    )
    batcher._confirmation_queue = _SinglePendingQueue(
        _PendingConfirmation(
            network=TVM_TESTNET,
            batch=[queued],
            trace_external_hash_norm="trace-hash",
        )
    )

    with pytest.raises(_StopWorker):
        batcher._run_confirmation_worker()

    assert queued.completed.is_set() is True
    assert queued.result is not None
    assert queued.result.error_reason == ERR_EXACT_TVM_TRANSACTION_FAILED
    assert cache.release_checks == [
        {
            "key": queued.settlement_hash,
            "completed": True,
            "error_reason": ERR_EXACT_TVM_TRANSACTION_FAILED,
            "success": False,
        }
    ]
