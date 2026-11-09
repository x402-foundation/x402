"""Unit tests for fatal vs retryable HTTP adapter initialize() handling."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from x402 import x402ResourceServer
from x402.http.background_init import (
    handle_background_init_error,
    is_fatal_startup_init_error,
)
from x402.http.types import (
    PaymentOption,
    RouteConfig,
    RouteConfigurationError,
    RouteValidationError,
)
from x402.http.x402_http_server import x402HTTPResourceServer
from x402.schemas import SupportedResponse
from x402.schemas.errors import FacilitatorCapabilityError


def test_is_fatal_startup_init_error_treats_capability_and_route_errors_as_fatal() -> None:
    assert is_fatal_startup_init_error(
        FacilitatorCapabilityError(["upto on solana:devnet: missing"])
    )
    assert is_fatal_startup_init_error(
        RouteConfigurationError(
            [
                RouteValidationError(
                    route_pattern="GET /api/generate",
                    scheme="upto",
                    network="solana:devnet",
                    reason="missing_facilitator",
                    message="missing facilitator",
                )
            ]
        )
    )


def test_is_fatal_startup_init_error_treats_timeouts_as_retryable() -> None:
    assert not is_fatal_startup_init_error(Exception("facilitator request timed out"))


def test_is_fatal_startup_init_error_treats_empty_supported_as_retryable() -> None:
    assert not is_fatal_startup_init_error(
        RuntimeError(
            "Failed to initialize: no supported payment kinds loaded from any facilitator."
        )
    )


def test_handle_background_init_error_exits_on_capability_mismatch() -> None:
    exit_code: int | None = None
    called = False

    def fake_exit(code: int) -> None:
        nonlocal called, exit_code
        called = True
        exit_code = code

    with patch("x402.http.background_init._process_exit", fake_exit):
        handle_background_init_error(FacilitatorCapabilityError(["upto on solana:devnet: missing"]))

    assert called, "expected process exit on capability mismatch"
    assert exit_code == 1, f"expected exit code 1, got {exit_code}"


def test_handle_background_init_error_does_not_exit_on_retryable_timeout() -> None:
    called = False

    def fake_exit(_code: int) -> None:
        nonlocal called
        called = True

    with patch("x402.http.background_init._process_exit", fake_exit):
        handle_background_init_error(Exception("facilitator request timed out"))

    assert not called, "expected no process exit on retryable facilitator timeout"


def test_handle_background_init_error_does_not_exit_on_empty_supported() -> None:
    called = False

    def fake_exit(_code: int) -> None:
        nonlocal called
        called = True

    with patch("x402.http.background_init._process_exit", fake_exit):
        handle_background_init_error(
            RuntimeError(
                "Failed to initialize: no supported payment kinds loaded from any facilitator."
            )
        )

    assert not called, "expected no process exit when facilitator returned no kinds"


class _EmptySupportedClient:
    def get_supported(self) -> SupportedResponse:
        return SupportedResponse(kinds=[], extensions=[], signers={})


class _ExactScheme:
    scheme = "exact"


def test_http_initialize_empty_supported_is_retryable_not_route_config_error() -> None:
    """A 200 /supported with no kinds must not become a fatal RouteConfigurationError."""
    resource_server = x402ResourceServer(_EmptySupportedClient())
    resource_server.register("eip155:8453", _ExactScheme())
    http_server = x402HTTPResourceServer(
        resource_server,
        {
            "GET /api/protected": RouteConfig(
                accepts=PaymentOption(
                    scheme="exact",
                    pay_to="0x1234567890123456789012345678901234567890",
                    price="$0.01",
                    network="eip155:8453",
                ),
            )
        },
    )

    with pytest.raises(RuntimeError, match="no supported payment kinds") as exc_info:
        http_server.initialize()

    assert not is_fatal_startup_init_error(exc_info.value)
    assert not isinstance(exc_info.value, RouteConfigurationError)
