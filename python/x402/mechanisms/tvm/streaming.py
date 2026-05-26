"""TVM provider streaming helpers."""

from __future__ import annotations

import base64
import binascii
import json
import queue
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any

from .codecs.common import normalize_address
from .constants import (
    SUPPORTED_TVM_PROVIDERS,
    TVM_PROVIDER_TONAPI,
    TVM_PROVIDER_TONCENTER,
)

try:
    import httpx
except ImportError as e:
    raise ImportError(
        "TVM mechanism requires httpx. Install with: pip install x402[tvm,httpx]"
    ) from e


DEFAULT_STREAMING_READ_TIMEOUT_SECONDS = 20.0
DEFAULT_STREAMING_RECONNECT_BACKOFF_SECONDS = 1.0
DEFAULT_STREAMING_MAX_CONSECUTIVE_FAILURES = 3
DEFAULT_RECENT_TRACE_RESULT_TTL_SECONDS = 60.0
DEFAULT_STREAMING_START_TIMEOUT_SECONDS = 2.0
_TONAPI_STREAMING_SSE_PATH = "/streaming/v2/sse"
_TONCENTER_STREAMING_SSE_PATH = "/api/streaming/v2/sse"


def _account_stream_subscription(normalized_address: str) -> dict[str, object]:
    return {
        "addresses": [normalized_address],
        "types": ["account_state_change", "transactions"],
        "min_finality": "finalized",
    }


def _iter_sse_payloads(lines: Iterable[str]) -> Iterator[str]:
    """Yield SSE event payloads from an iterable of text lines."""
    data_lines: list[str] = []

    for line in lines:
        if line == "":
            if data_lines:
                yield "\n".join(data_lines)
                data_lines = []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
            continue
        if line.startswith(("event:", "id:", "retry:")):
            continue
        data_lines.append(line)


def _iter_sse_json_events(lines: Iterable[str]) -> Iterator[dict[str, Any]]:
    """Parse SSE JSON object payloads from text lines."""
    for payload in _iter_sse_payloads(lines):
        try:
            event = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Toncenter SSE emitted malformed JSON") from exc
        if not isinstance(event, dict):
            raise RuntimeError("Toncenter SSE emitted a non-object event")
        yield event


@dataclass
class _StreamResources:
    lock: threading.Lock
    client: httpx.Client | None = None
    response: httpx.Response | None = None

    def attach(self, client: httpx.Client, response: httpx.Response) -> None:
        with self.lock:
            self.client = client
            self.response = response

    def detach(self, client: httpx.Client, response: httpx.Response | None) -> None:
        with self.lock:
            if self.response is response:
                self.response = None
            if self.client is client:
                self.client = None

    def close(self) -> None:
        with self.lock:
            response = self.response
            client = self.client
            self.response = None
            self.client = None

        if response is not None:
            try:
                response.close()
            except Exception:
                pass
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


@dataclass
class _RecentTraceResult:
    completed_at: float
    payload: dict[str, Any] | None
    error: Exception | None


@dataclass
class _StartupState:
    ready_event: threading.Event = field(default_factory=threading.Event)
    error: Exception | None = None

    def mark_ready(self) -> None:
        self.ready_event.set()

    def fail(self, exc: Exception) -> None:
        self.error = exc
        self.ready_event.set()


class TvmStreamingWatcher:
    """Handle for a long-lived facilitator-account streaming watcher."""

    def __init__(
        self,
        thread: threading.Thread,
        stop_event: threading.Event,
        close_stream: Callable[[], None],
    ) -> None:
        self._thread = thread
        self._stop_event = stop_event
        self._close_stream = close_stream

    def close(self) -> None:
        self._stop_event.set()
        self._close_stream()
        self._thread.join(timeout=1.0)

    def is_alive(self) -> bool:
        """Report whether the watcher thread is still running."""
        return self._thread.is_alive()

    def is_current_thread(self) -> bool:
        """Report whether the caller runs on the watcher thread."""
        return self._thread is threading.current_thread()


class TvmStreamingSseClient:
    """Shared SSE client for provider account streams."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str | None = None,
        provider: str = TVM_PROVIDER_TONCENTER,
        sse_path: str | None = None,
    ) -> None:
        self._provider = provider.strip().lower()
        if self._provider not in SUPPORTED_TVM_PROVIDERS:
            raise ValueError(f"Unsupported TVM streaming provider: {self._provider}")
        self._provider_label = "TonAPI" if self._provider == TVM_PROVIDER_TONAPI else "Toncenter"
        self._base_url = base_url.rstrip("/")
        self._sse_path = sse_path or (
            _TONAPI_STREAMING_SSE_PATH
            if self._provider == TVM_PROVIDER_TONAPI
            else _TONCENTER_STREAMING_SSE_PATH
        )
        self._headers = {
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        }
        if api_key:
            if self._provider == TVM_PROVIDER_TONAPI:
                self._headers["Authorization"] = f"Bearer {api_key}"
            else:
                self._headers["X-Api-Key"] = api_key

        self._lock = threading.Lock()
        self._stream_resources = _StreamResources(lock=threading.Lock())
        self._watcher: TvmStreamingWatcher | None = None
        self._watched_address: str | None = None
        self._pending_trace_waiters: dict[str, list[queue.Queue[dict[str, Any] | Exception]]] = {}
        self._recent_trace_results: dict[str, _RecentTraceResult] = {}

    def close(self) -> None:
        """Close the watcher and any underlying stream resources."""
        with self._lock:
            watcher = self._watcher
            self._watcher = None
            self._watched_address = None
            pending_waiters = self._pending_trace_waiters
            self._pending_trace_waiters = {}
            self._recent_trace_results = {}

        self._stream_resources.close()
        if watcher is not None:
            watcher.close()

        error = RuntimeError(f"{self._provider_label} facilitator account stream closed")
        for waiters in pending_waiters.values():
            self._notify_waiters(waiters, error)

    def start_account_state_watcher(
        self,
        *,
        address: str,
        on_invalidate: Callable[[], None],
    ) -> TvmStreamingWatcher:
        """Start one shared stream on the facilitator address."""
        normalized_address = normalize_address(address)
        with self._lock:
            if self._watcher is not None and not self._watcher.is_alive():
                self._watcher = None
                self._watched_address = None
            if self._watcher is not None:
                if self._watched_address != normalized_address:
                    raise RuntimeError("TvmStreamingSseClient already watches a different address")
                return self._watcher

            stop_event = threading.Event()
            startup_state = _StartupState()
            thread = threading.Thread(
                target=self._run_account_stream,
                args=(stop_event, normalized_address, on_invalidate, startup_state),
                name=f"{self._provider}-account-stream",
                daemon=True,
            )
            watcher = TvmStreamingWatcher(
                thread,
                stop_event,
                close_stream=self._stream_resources.close,
            )
            self._watcher = watcher
            self._watched_address = normalized_address

        thread.start()
        if not startup_state.ready_event.wait(timeout=DEFAULT_STREAMING_START_TIMEOUT_SECONDS):
            watcher.close()
            with self._lock:
                if self._watcher is watcher:
                    self._watcher = None
                    self._watched_address = None
            raise RuntimeError(
                f"{self._provider_label} facilitator account stream did not become ready in time"
            )
        if startup_state.error is not None:
            watcher.close()
            with self._lock:
                if self._watcher is watcher:
                    self._watcher = None
                    self._watched_address = None
            raise RuntimeError(
                f"{self._provider_label} facilitator account stream failed to start"
            ) from startup_state.error
        return watcher

    def wait_for_trace_confirmation(
        self,
        *,
        trace_external_hash_norm: str,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        """Block until the shared account stream observes the finalized trace."""
        trace_waiter: queue.Queue[dict[str, Any] | Exception] | None = None
        recent_result: _RecentTraceResult | None = None
        trace_hash_aliases = _trace_hash_aliases(trace_external_hash_norm)

        with self._lock:
            self._prune_recent_trace_results_locked()
            if self._watcher is None:
                raise RuntimeError(
                    f"{self._provider_label} facilitator account stream has not been started"
                )
            for trace_hash_alias in trace_hash_aliases:
                recent_result = self._recent_trace_results.get(trace_hash_alias)
                if recent_result is not None:
                    break
            if recent_result is None:
                trace_waiter = queue.Queue(maxsize=1)
                for trace_hash_alias in trace_hash_aliases:
                    self._pending_trace_waiters.setdefault(trace_hash_alias, []).append(
                        trace_waiter
                    )

        if recent_result is not None:
            if recent_result.error is not None:
                raise recent_result.error
            if recent_result.payload is None:
                raise RuntimeError(
                    f"{self._provider_label} did not cache finalized trace payload for "
                    f"{trace_external_hash_norm}"
                )
            return recent_result.payload

        assert trace_waiter is not None
        try:
            result = trace_waiter.get(timeout=timeout_seconds)
        except queue.Empty as exc:
            self._remove_pending_waiter(trace_external_hash_norm, trace_waiter)
            raise RuntimeError(
                f"Timed out waiting for finalized trace {trace_external_hash_norm}"
            ) from exc

        if isinstance(result, Exception):
            raise result
        return result

    def _run_account_stream(
        self,
        stop_event: threading.Event,
        normalized_address: str,
        on_invalidate: Callable[[], None],
        startup_state: _StartupState,
    ) -> None:
        consecutive_failures = 0

        def on_subscribed() -> None:
            nonlocal consecutive_failures
            consecutive_failures = 0
            startup_state.mark_ready()

        try:
            while not stop_event.is_set():
                try:
                    self._consume_stream(
                        subscription=_account_stream_subscription(normalized_address),
                        stop_event=stop_event,
                        on_event=lambda event: self._handle_stream_event(
                            event,
                            normalized_address=normalized_address,
                            on_invalidate=on_invalidate,
                            on_subscribed=on_subscribed,
                        ),
                        resources=self._stream_resources,
                    )
                except Exception as exc:
                    if not startup_state.ready_event.is_set():
                        startup_state.fail(exc)
                        break
                    if stop_event.is_set():
                        break

                    on_invalidate()
                    consecutive_failures += 1
                    if consecutive_failures >= DEFAULT_STREAMING_MAX_CONSECUTIVE_FAILURES:
                        self._fail_pending_waiters(exc)
                        break

                    stop_event.wait(DEFAULT_STREAMING_RECONNECT_BACKOFF_SECONDS)
        finally:
            with self._lock:
                if self._watcher is not None and self._watcher.is_current_thread():
                    self._watcher = None
                    self._watched_address = None

    def _consume_stream(
        self,
        *,
        subscription: dict[str, object],
        stop_event: threading.Event,
        on_event: Callable[[dict[str, Any]], None],
        resources: _StreamResources | None = None,
    ) -> None:
        client = httpx.Client(
            base_url=self._base_url,
            headers=self._headers,
            timeout=httpx.Timeout(
                connect=DEFAULT_STREAMING_READ_TIMEOUT_SECONDS,
                write=DEFAULT_STREAMING_READ_TIMEOUT_SECONDS,
                pool=DEFAULT_STREAMING_READ_TIMEOUT_SECONDS,
                read=DEFAULT_STREAMING_READ_TIMEOUT_SECONDS,
            ),
        )
        response: httpx.Response | None = None
        try:
            with client:
                with client.stream("POST", self._sse_path, json=subscription) as response:
                    response.raise_for_status()
                    if resources is not None:
                        resources.attach(client, response)

                    for event in _iter_sse_json_events(response.iter_lines()):
                        if stop_event.is_set():
                            return
                        on_event(event)
                        if stop_event.is_set():
                            return

            if stop_event.is_set():
                return
            raise RuntimeError(f"{self._provider_label} SSE stream terminated unexpectedly")
        finally:
            if resources is not None:
                resources.detach(client, response)

    def _handle_stream_event(
        self,
        event: dict[str, Any],
        *,
        normalized_address: str,
        on_invalidate: Callable[[], None],
        on_subscribed: Callable[[], None],
    ) -> None:
        if event.get("status") == "subscribed":
            on_subscribed()
            return

        if event.get("type") == "account_state_change":
            account = event.get("account")
            if isinstance(account, str) and normalize_address(account) == normalized_address:
                on_invalidate()
            return

        trace_result = self._trace_result_from_event(event)
        if trace_result is None:
            return

        self._publish_trace_result(*trace_result)

    def _publish_trace_result(
        self,
        trace_external_hash_norm: str,
        payload: dict[str, Any] | None,
        error: Exception | None,
    ) -> None:
        with self._lock:
            self._prune_recent_trace_results_locked()
            recent_result = _RecentTraceResult(
                completed_at=time.monotonic(), payload=payload, error=error
            )
            waiters_by_id: dict[int, queue.Queue[dict[str, Any] | Exception]] = {}
            for trace_hash_alias in _trace_hash_aliases(trace_external_hash_norm):
                self._recent_trace_results[trace_hash_alias] = recent_result
                for waiter in self._pending_trace_waiters.pop(trace_hash_alias, []):
                    waiters_by_id[id(waiter)] = waiter
            waiters = list(waiters_by_id.values())

        self._notify_waiters(waiters, error if error is not None else payload)

    def _fail_pending_waiters(self, exc: Exception) -> None:
        error = RuntimeError(
            f"{self._provider_label} facilitator account stream failed before confirmation: {exc}"
        )
        with self._lock:
            pending_trace_waiters = self._pending_trace_waiters
            self._pending_trace_waiters = {}

        for waiters in pending_trace_waiters.values():
            self._notify_waiters(waiters, error)

    def _remove_pending_waiter(
        self,
        trace_external_hash_norm: str,
        trace_waiter: queue.Queue[dict[str, Any] | Exception],
    ) -> None:
        with self._lock:
            for trace_hash_alias in _trace_hash_aliases(trace_external_hash_norm):
                waiters = self._pending_trace_waiters.get(trace_hash_alias)
                if waiters is None:
                    continue
                self._pending_trace_waiters[trace_hash_alias] = [
                    waiter for waiter in waiters if waiter is not trace_waiter
                ]
                if not self._pending_trace_waiters[trace_hash_alias]:
                    self._pending_trace_waiters.pop(trace_hash_alias, None)

    def _prune_recent_trace_results_locked(self) -> None:
        cutoff = time.monotonic() - DEFAULT_RECENT_TRACE_RESULT_TTL_SECONDS
        stale_hashes = [
            trace_external_hash_norm
            for trace_external_hash_norm, recent_result in self._recent_trace_results.items()
            if recent_result.completed_at < cutoff
        ]
        for trace_external_hash_norm in stale_hashes:
            self._recent_trace_results.pop(trace_external_hash_norm, None)

    def _notify_waiters(
        self,
        waiters: Iterable[queue.Queue[dict[str, Any] | Exception]],
        result: dict[str, Any] | Exception | None,
    ) -> None:
        for trace_waiter in waiters:
            try:
                if result is None:
                    continue
                trace_waiter.put_nowait(result)
            except queue.Full:
                continue

    def _trace_result_from_event(
        self,
        event: dict[str, Any],
    ) -> tuple[str, dict[str, Any] | None, Exception | None] | None:
        event_type = event.get("type")
        if event_type not in {"trace", "transactions"}:
            return None

        trace_external_hash_norm = event.get("trace_external_hash_norm")
        if not isinstance(trace_external_hash_norm, str):
            return None
        if event.get("finality") != "finalized":
            return None
        return trace_external_hash_norm, event, None


def _trace_hash_aliases(trace_hash: str) -> list[str]:
    aliases = [trace_hash]
    normalized = trace_hash.strip()

    raw_hash: bytes | None = None
    if len(normalized) == 64:
        try:
            raw_hash = bytes.fromhex(normalized)
        except ValueError:
            raw_hash = None
    if raw_hash is None:
        padded = normalized + "=" * (-len(normalized) % 4)
        for decoder in (base64.b64decode, base64.urlsafe_b64decode):
            try:
                candidate = decoder(padded)
            except (ValueError, binascii.Error):
                continue
            if len(candidate) == 32:
                raw_hash = candidate
                break

    if raw_hash is not None:
        aliases.extend(
            [
                raw_hash.hex(),
                base64.b64encode(raw_hash).decode("ascii"),
                base64.urlsafe_b64encode(raw_hash).decode("ascii").rstrip("="),
            ]
        )

    deduped: list[str] = []
    seen: set[str] = set()
    for alias in aliases:
        if alias in seen:
            continue
        seen.add(alias)
        deduped.append(alias)
    return deduped
