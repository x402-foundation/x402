"""Tests for TVM streaming trace confirmation."""

from __future__ import annotations

import base64
import queue
import threading
import time
from dataclasses import dataclass

import pytest

pytest.importorskip("pytoniq_core")

import x402.mechanisms.tvm as tvm_module
import x402.mechanisms.tvm.streaming as streaming_module
from x402.mechanisms.tvm import TVM_PROVIDER_TONAPI
from x402.mechanisms.tvm.streaming import (
    TvmStreamingSseClient,
    TvmStreamingWatcher,
    _account_stream_subscription,
    _iter_sse_json_events,
    _iter_sse_payloads,
)

from .helpers import start_captured_thread

TRACE_HASH = "trace-hash-1"
FACILITATOR_ADDRESS = "0:" + "1" * 64


@dataclass(frozen=True)
class _ConsumePlan:
    events: tuple[dict[str, object], ...] = ()
    error: Exception | None = None
    wait_on: threading.Event | None = None
    sleep_seconds: float = 0.0
    set_stop: bool = False


def _subscribed_event() -> dict[str, str]:
    return {"status": "subscribed"}


def _finalized_trace_event(trace_hash: str = TRACE_HASH) -> dict[str, object]:
    return {
        "type": "transactions",
        "finality": "finalized",
        "trace_external_hash_norm": trace_hash,
        "transactions": [],
    }


def _start_trace_waiter(
    client: TvmStreamingSseClient,
    *,
    trace_hash: str = TRACE_HASH,
    timeout_seconds: float = 1.0,
):
    return start_captured_thread(
        lambda: client.wait_for_trace_confirmation(
            trace_external_hash_norm=trace_hash,
            timeout_seconds=timeout_seconds,
        )
    )


def _planned_consumer(state: dict[str, int], plans: list[_ConsumePlan]):
    def fake_consume_stream(*, subscription, stop_event, on_event, resources=None):
        _ = subscription, resources
        state["calls"] += 1
        plan = plans[state["calls"] - 1]
        for event in plan.events:
            on_event(event)
        if plan.wait_on is not None:
            plan.wait_on.wait(timeout=1.0)
        if plan.sleep_seconds:
            time.sleep(plan.sleep_seconds)
        if plan.set_stop:
            stop_event.set()
        if plan.error is not None:
            raise plan.error

    return fake_consume_stream


def test_account_stream_subscription_uses_transactions_and_account_state_change():
    assert _account_stream_subscription(FACILITATOR_ADDRESS) == {
        "addresses": [FACILITATOR_ADDRESS],
        "types": ["account_state_change", "transactions"],
        "min_finality": "finalized",
    }


def test_iter_sse_payloads_ignores_trailing_partial_event_without_blank_line():
    lines = [
        'data: {"status":"subscribed"}',
        "",
        'data: {"type":"transactions"',
    ]

    assert list(_iter_sse_payloads(lines)) == ['{"status":"subscribed"}']


def test_iter_sse_json_events_ignores_trailing_partial_event_without_blank_line():
    lines = [
        'data: {"status":"subscribed"}',
        "",
        'data: {"type":"transactions"',
    ]

    assert list(_iter_sse_json_events(lines)) == [{"status": "subscribed"}]


def test_streaming_watcher_reports_whether_the_caller_is_the_watcher_thread():
    watcher = TvmStreamingWatcher(
        threading.current_thread(),
        threading.Event(),
        close_stream=lambda: None,
    )

    assert watcher.is_current_thread() is True

    result_holder: dict[str, bool] = {}

    def check_from_other_thread() -> None:
        result_holder["is_current_thread"] = watcher.is_current_thread()

    other_thread = start_captured_thread(check_from_other_thread)
    other_thread.join()
    assert result_holder["is_current_thread"] is False


def test_tonapi_streaming_client_uses_compatible_sse_route_and_bearer_auth():
    client = TvmStreamingSseClient(
        base_url="https://tonapi.io",
        api_key="tonapi-key",
        provider=" TonAPI ",
    )

    assert client._sse_path == "/streaming/v2/sse"
    assert client._headers["Authorization"] == "Bearer tonapi-key"


def test_streaming_sse_routes_are_internal_provider_details():
    tvm_client = TvmStreamingSseClient(base_url="https://toncenter.example")
    tonapi_client = TvmStreamingSseClient(
        base_url="https://tonapi.io",
        provider=TVM_PROVIDER_TONAPI,
    )

    assert tvm_client._sse_path == "/api/streaming/v2/sse"
    assert tonapi_client._sse_path == "/streaming/v2/sse"
    assert not hasattr(tvm_module, "TONAPI_STREAMING_SSE_PATH")
    assert not hasattr(tvm_module, "TONCENTER_STREAMING_SSE_PATH")


def test_trace_confirmation_should_match_hex_and_base64_hash_aliases():
    client = TvmStreamingSseClient(base_url="https://tonapi.io", provider=TVM_PROVIDER_TONAPI)
    client._watcher = object()  # type: ignore[assignment]
    raw_hash = b"\x11" * 32
    trace_hash_hex = raw_hash.hex()
    trace_hash_base64 = base64.b64encode(raw_hash).decode("ascii")
    payload = {
        "type": "transactions",
        "finality": "finalized",
        "trace_external_hash_norm": trace_hash_base64,
    }

    client._publish_trace_result(trace_hash_base64, payload, None)

    assert (
        client.wait_for_trace_confirmation(
            trace_external_hash_norm=trace_hash_hex,
            timeout_seconds=0.01,
        )
        == payload
    )


def test_wait_for_trace_confirmation_returns_finalized_trace_payload_from_transactions_event(
    monkeypatch,
):
    client = TvmStreamingSseClient(base_url="https://toncenter.example")
    client._watcher = object()  # type: ignore[assignment]

    waiter = start_captured_thread(
        lambda: client.wait_for_trace_confirmation(
            trace_external_hash_norm=TRACE_HASH,
            timeout_seconds=1.0,
        )
    )
    client._handle_stream_event(
        _finalized_trace_event(),
        normalized_address=FACILITATOR_ADDRESS,
        on_invalidate=lambda: None,
        on_subscribed=lambda: None,
    )
    waiter.join()

    assert waiter.result == _finalized_trace_event()


def test_start_account_state_watcher_retries_after_failed_start(monkeypatch):
    client = TvmStreamingSseClient(base_url="https://toncenter.example")
    state = {"calls": 0}

    def fake_consume_stream(*, subscription, stop_event, on_event, resources=None):
        _ = subscription, resources
        state["calls"] += 1
        if state["calls"] == 1:
            raise RuntimeError("boom")
        on_event(_subscribed_event())
        while not stop_event.wait(0.01):
            pass

    monkeypatch.setattr(client, "_consume_stream", fake_consume_stream)

    with pytest.raises(RuntimeError, match="failed to start"):
        client.start_account_state_watcher(
            address=FACILITATOR_ADDRESS,
            on_invalidate=lambda: None,
        )

    watcher = client.start_account_state_watcher(
        address=FACILITATOR_ADDRESS,
        on_invalidate=lambda: None,
    )
    try:
        assert watcher.is_alive() is True
        assert state["calls"] == 2
    finally:
        watcher.close()


def test_wait_for_trace_confirmation_survives_stream_reconnect(monkeypatch):
    client = TvmStreamingSseClient(base_url="https://toncenter.example")
    state = {"calls": 0}
    monkeypatch.setattr(streaming_module, "DEFAULT_STREAMING_RECONNECT_BACKOFF_SECONDS", 0.01)
    monkeypatch.setattr(
        client,
        "_consume_stream",
        _planned_consumer(
            state,
            [
                _ConsumePlan(
                    events=(_subscribed_event(),),
                    sleep_seconds=0.05,
                    error=RuntimeError("disconnect"),
                ),
                _ConsumePlan(
                    events=(_subscribed_event(), _finalized_trace_event()),
                    set_stop=True,
                ),
            ],
        ),
    )
    watcher = client.start_account_state_watcher(
        address=FACILITATOR_ADDRESS,
        on_invalidate=lambda: None,
    )
    try:
        waiter = _start_trace_waiter(client)
        waiter.join()

        assert waiter.result == _finalized_trace_event()
        assert state["calls"] >= 2
    finally:
        watcher.close()


def test_wait_for_trace_confirmation_fails_after_max_consecutive_stream_failures(monkeypatch):
    client = TvmStreamingSseClient(base_url="https://toncenter.example")
    state = {"calls": 0, "invalidations": 0}
    release_first_failure = threading.Event()

    monkeypatch.setattr(streaming_module, "DEFAULT_STREAMING_RECONNECT_BACKOFF_SECONDS", 0.01)
    monkeypatch.setattr(streaming_module, "DEFAULT_STREAMING_MAX_CONSECUTIVE_FAILURES", 2)

    monkeypatch.setattr(
        client,
        "_consume_stream",
        _planned_consumer(
            state,
            [
                _ConsumePlan(
                    events=(_subscribed_event(),),
                    wait_on=release_first_failure,
                    error=RuntimeError("disconnect-1"),
                ),
                _ConsumePlan(error=RuntimeError("disconnect-2")),
            ],
        ),
    )
    watcher = client.start_account_state_watcher(
        address=FACILITATOR_ADDRESS,
        on_invalidate=lambda: state.__setitem__("invalidations", state["invalidations"] + 1),
    )
    try:
        waiter = _start_trace_waiter(client)
        release_first_failure.set()
        waiter.join(timeout=0.5)
        error = waiter.error
        assert isinstance(error, RuntimeError)
        assert str(error) == (
            "Toncenter facilitator account stream failed before confirmation: disconnect-2"
        )
        assert state["calls"] == 2
        assert state["invalidations"] == 2
    finally:
        watcher.close()


def test_close_stops_watcher_and_fails_pending_waiters():
    client = TvmStreamingSseClient(base_url="https://toncenter.example")
    waiter: queue.Queue[dict[str, object] | Exception] = queue.Queue(maxsize=1)
    close_calls: list[str] = []

    class _Watcher:
        def close(self) -> None:
            close_calls.append("closed")

        def is_alive(self) -> bool:
            return True

    client._watcher = _Watcher()  # type: ignore[assignment]
    client._watched_address = FACILITATOR_ADDRESS
    client._pending_trace_waiters[TRACE_HASH] = [waiter]

    client.close()

    result = waiter.get_nowait()
    assert isinstance(result, RuntimeError)
    assert str(result) == "Toncenter facilitator account stream closed"
    assert close_calls == ["closed"]
    assert client._watcher is None
    assert client._watched_address is None
