"""Generic test helpers for TVM mechanism unit tests."""

from __future__ import annotations

import threading
from dataclasses import dataclass


@dataclass
class ThreadCapture:
    thread: threading.Thread
    holder: dict[str, object]

    def join(self, timeout: float = 1.0) -> None:
        self.thread.join(timeout=timeout)
        assert self.thread.is_alive() is False

    @property
    def result(self) -> object:
        if "error" in self.holder:
            raise AssertionError(f"Thread raised unexpectedly: {self.holder['error']!r}")
        return self.holder["result"]

    @property
    def error(self) -> BaseException:
        error = self.holder.get("error")
        assert isinstance(error, BaseException)
        return error


def start_captured_thread(target, *, timeout: float | None = None) -> ThreadCapture:
    """Start a thread and capture either its return value or its terminal exception."""
    holder: dict[str, object] = {}

    def runner() -> None:
        try:
            holder["result"] = target()
        except BaseException as exc:  # pragma: no cover - exercised via tests
            holder["error"] = exc

    thread = threading.Thread(target=runner)
    thread.start()
    if timeout is not None:
        thread.join(timeout=timeout)
    return ThreadCapture(thread=thread, holder=holder)
