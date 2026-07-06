"""Tests for the TRACE API Trust Provider Extension."""

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import Response

from x402.extensions.trace_trust import TraceTrustExtension
from x402.schemas.errors import PaymentAbortedError


class MockVerifyResult:
    def __init__(self, is_valid: bool, payer: str | None = None) -> None:
        self.is_valid = is_valid
        self.payer = payer


class MockVerifyResultContext:
    def __init__(self, is_valid: bool, payer: str | None = None) -> None:
        self.result = MockVerifyResult(is_valid, payer)


@pytest.mark.asyncio
@patch("httpx.AsyncClient.post", new_callable=AsyncMock)
async def test_trace_trust_extension_success(mock_post: Any) -> None:
    """Test that a high trust score allows the payment to proceed."""
    mock_post.return_value = Response(200, json={"score": 0.95, "routing_decision": "PASS"})

    ext = TraceTrustExtension(api_url="https://api.trace.io", api_key="test_key", min_score=0.35)
    context = MockVerifyResultContext(is_valid=True, payer="0x123")

    # Should not raise an exception
    await ext.hooks.on_after_verify({"capability": "test"}, context)  # type: ignore
    mock_post.assert_called_once()


@pytest.mark.asyncio
@patch("httpx.AsyncClient.post", new_callable=AsyncMock)
async def test_trace_trust_extension_low_score(mock_post: Any) -> None:
    """Test that a low trust score aborts the payment."""
    mock_post.return_value = Response(200, json={"score": 0.20, "routing_decision": "HOLD"})

    ext = TraceTrustExtension(api_url="https://api.trace.io", api_key="test_key", min_score=0.35)
    context = MockVerifyResultContext(is_valid=True, payer="0x123")

    with pytest.raises(PaymentAbortedError, match="Payment rejected: Payer trust score too low"):
        await ext.hooks.on_after_verify({"capability": "test"}, context)  # type: ignore
    mock_post.assert_called_once()


@pytest.mark.asyncio
@patch("httpx.AsyncClient.post", new_callable=AsyncMock)
async def test_trace_trust_extension_api_error_fail_closed(mock_post: Any) -> None:
    """Test that an API error aborts the payment when fail_closed is True."""
    mock_post.return_value = Response(500, json={"error": "Internal Server Error"}, request=MagicMock())

    ext = TraceTrustExtension(
        api_url="https://api.trace.io", api_key="test_key", min_score=0.35, fail_closed=True
    )
    context = MockVerifyResultContext(is_valid=True, payer="0x123")

    with pytest.raises(PaymentAbortedError, match="TRACE API error: 500"):
        await ext.hooks.on_after_verify({"capability": "test"}, context)  # type: ignore
    mock_post.assert_called_once()


@pytest.mark.asyncio
@patch("httpx.AsyncClient.post", new_callable=AsyncMock)
async def test_trace_trust_extension_api_error_fail_open(mock_post: Any) -> None:
    """Test that an API error allows the payment when fail_closed is False."""
    mock_post.return_value = Response(500, json={"error": "Internal Server Error"}, request=MagicMock())

    ext = TraceTrustExtension(
        api_url="https://api.trace.io", api_key="test_key", min_score=0.35, fail_closed=False
    )
    context = MockVerifyResultContext(is_valid=True, payer="0x123")

    # Should not raise an exception
    await ext.hooks.on_after_verify({"capability": "test"}, context)  # type: ignore
    mock_post.assert_called_once()
