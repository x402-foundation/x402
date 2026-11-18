"""Internal batching helpers for TVM exact settlement relay."""

from __future__ import annotations

import queue
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from ..constants import (
    DEFAULT_SETTLEMENT_BATCH_MAX_SIZE,
    DEFAULT_SETTLEMENT_CONFIRMATION_WORKERS,
    ERR_EXACT_TVM_SIMULATION_FAILED,
    ERR_EXACT_TVM_TRANSACTION_FAILED,
)
from ..settlement_cache import SettlementCache
from ..signer import FacilitatorTvmSigner
from ..types import ParsedTvmSettlement, TvmRelayRequest


@dataclass
class _BatchResult:
    success: bool
    transaction: str = ""
    error_reason: str | None = None
    error_message: str | None = None


@dataclass
class _QueuedSettlement:
    network: str
    settlement_hash: str
    settlement: ParsedTvmSettlement
    relay_request: TvmRelayRequest
    completed: threading.Event = field(default_factory=threading.Event)
    result: _BatchResult | None = None


@dataclass
class _PendingConfirmation:
    network: str
    batch: list[_QueuedSettlement]
    trace_external_hash_norm: str


class _SettlementBatcher:
    def __init__(
        self,
        signer: FacilitatorTvmSigner,
        settlement_cache: SettlementCache,
        *,
        flush_interval_seconds: float,
        batch_flush_size: int,
        confirmation_workers: int = DEFAULT_SETTLEMENT_CONFIRMATION_WORKERS,
        confirmation_timeout_seconds: float,
        settlement_verifier: Callable[[dict[str, object], ParsedTvmSettlement], str],
    ) -> None:
        self._signer = signer
        self._settlement_cache = settlement_cache
        self._flush_interval_seconds = flush_interval_seconds
        self._batch_flush_size = batch_flush_size
        self._max_batch_size = DEFAULT_SETTLEMENT_BATCH_MAX_SIZE
        self._confirmation_timeout_seconds = confirmation_timeout_seconds
        self._settlement_verifier = settlement_verifier
        if confirmation_workers < 1:
            raise ValueError("confirmation_workers must be at least 1")
        self._lock = threading.Lock()
        self._condition = threading.Condition(self._lock)
        self._confirmation_queue: queue.SimpleQueue[_PendingConfirmation] = queue.SimpleQueue()
        self._queues: dict[str, list[_QueuedSettlement]] = {}
        self._deadlines: dict[str, float] = {}
        self._worker = threading.Thread(
            target=self._run, name="tvm-settlement-batcher", daemon=True
        )
        self._worker.start()
        self._confirmation_workers = [
            threading.Thread(
                target=self._run_confirmation_worker,
                name=f"tvm-settlement-confirmation-{idx}",
                daemon=True,
            )
            for idx in range(confirmation_workers)
        ]
        for worker in self._confirmation_workers:
            worker.start()

    def enqueue(self, queued_settlement: _QueuedSettlement) -> _BatchResult:
        with self._condition:
            queue = self._queues.setdefault(queued_settlement.network, [])
            queue.append(queued_settlement)
            if len(queue) == 1:
                self._deadlines[queued_settlement.network] = (
                    time.monotonic() + self._flush_interval_seconds
                )
            elif len(queue) >= self._batch_flush_size:
                self._deadlines[queued_settlement.network] = time.monotonic()
            self._condition.notify_all()

        queued_settlement.completed.wait()
        assert queued_settlement.result is not None
        return queued_settlement.result

    def _run(self) -> None:
        while True:
            with self._condition:
                network, batch = self._wait_for_ready_batch_locked()
            self._flush_batch(network, batch)

    def _wait_for_ready_batch_locked(self) -> tuple[str, list[_QueuedSettlement]]:
        while True:
            now = time.monotonic()
            for network, deadline in list(self._deadlines.items()):
                queue = self._queues.get(network)
                if queue and deadline <= now:
                    batch_size = min(len(queue), self._max_batch_size)
                    batch = queue[:batch_size]
                    del queue[:batch_size]
                    if queue:
                        self._deadlines[network] = (
                            now
                            if len(queue) >= self._batch_flush_size
                            else now + self._flush_interval_seconds
                        )
                        self._condition.notify_all()
                    else:
                        self._queues.pop(network, None)
                        self._deadlines.pop(network, None)
                    return network, batch
            self._condition.wait(timeout=self._next_wait_timeout_locked())

    def _next_wait_timeout_locked(self) -> float | None:
        if not self._deadlines:
            return None
        return max(0.0, min(self._deadlines.values()) - time.monotonic())

    def _flush_batch(self, network: str, batch: list[_QueuedSettlement]) -> None:
        try:
            external_boc = self._signer.build_relay_external_boc_batch(
                network,
                [queued.relay_request for queued in batch],
            )
            trace_external_hash_norm = self._signer.send_external_message(network, external_boc)
        except Exception as exc:
            for queued in batch:
                self._fail_queued_settlement(
                    queued,
                    error_reason=(
                        ERR_EXACT_TVM_SIMULATION_FAILED
                        if isinstance(exc, ValueError)
                        else ERR_EXACT_TVM_TRANSACTION_FAILED
                    ),
                    error_message=str(exc),
                )
            return

        self._confirmation_queue.put(
            _PendingConfirmation(
                network=network,
                batch=batch,
                trace_external_hash_norm=trace_external_hash_norm,
            )
        )

    def _run_confirmation_worker(self) -> None:
        while True:
            pending = self._confirmation_queue.get()
            try:
                finalized_trace = self._signer.wait_for_trace_confirmation(
                    pending.network,
                    pending.trace_external_hash_norm,
                    timeout_seconds=self._confirmation_timeout_seconds,
                )
            except Exception as exc:
                for queued in pending.batch:
                    self._fail_queued_settlement(
                        queued,
                        error_reason=(
                            ERR_EXACT_TVM_SIMULATION_FAILED
                            if isinstance(exc, ValueError)
                            else ERR_EXACT_TVM_TRANSACTION_FAILED
                        ),
                        error_message=str(exc),
                    )
                continue

            for queued in pending.batch:
                try:
                    transaction_hash = self._settlement_verifier(
                        finalized_trace,
                        queued.settlement,
                    )
                    queued.result = _BatchResult(
                        success=True,
                        transaction=transaction_hash,
                    )
                except Exception as exc:
                    self._fail_queued_settlement(
                        queued,
                        error_reason=ERR_EXACT_TVM_TRANSACTION_FAILED,
                        error_message=str(exc),
                    )
                    continue
                queued.completed.set()
                # On-chain seqno already advanced; further retries fail at verify
                self._settlement_cache.release(queued.settlement_hash)

    def _fail_queued_settlement(
        self,
        queued: _QueuedSettlement,
        *,
        error_reason: str,
        error_message: str,
    ) -> None:
        queued.result = _BatchResult(
            success=False,
            transaction="",
            error_reason=error_reason,
            error_message=error_message,
        )
        queued.completed.set()
        self._settlement_cache.release(queued.settlement_hash)
