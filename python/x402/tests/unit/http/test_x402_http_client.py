"""Unit tests for x402.http.x402_http_client - HTTP client classes."""

import json

import pytest

from x402.http.constants import (
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_RESPONSE_HEADER,
    PAYMENT_SIGNATURE_HEADER,
    X_PAYMENT_HEADER,
    X_PAYMENT_RESPONSE_HEADER,
)
from x402.http.utils import (
    encode_payment_required_header,
    encode_payment_response_header,
)
from x402.http.x402_http_client import (
    PaymentRoundTripper,
    x402HTTPClient,
    x402HTTPClientSync,
)
from x402.http.x402_http_client_base import x402HTTPClientBase
from x402.schemas import (
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    SettleResponse,
)
from x402.schemas.hooks import RecoveredResponseResult
from x402.schemas.v1 import PaymentPayloadV1, PaymentRequiredV1

# =============================================================================
# Mock Clients for Testing
# =============================================================================


def make_payment_requirements() -> PaymentRequirements:
    """Helper to create valid PaymentRequirements."""
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x0000000000000000000000000000000000000000",
        amount="1000000",
        pay_to="0x1234567890123456789012345678901234567890",
        max_timeout_seconds=300,
    )


def make_v2_payload(signature: str = "0xmock") -> PaymentPayload:
    """Helper to create valid V2 PaymentPayload."""
    return PaymentPayload(
        x402_version=2,
        payload={"signature": signature},
        accepted=make_payment_requirements(),
    )


class MockX402Client:
    """Mock async x402Client for testing."""

    def __init__(self, payload_to_return: PaymentPayload | PaymentPayloadV1 | None = None):
        self.payload_to_return = payload_to_return or make_v2_payload()
        self.create_payment_calls: list = []
        self.handle_payment_response_calls: list = []

    async def create_payment_payload(self, payment_required):
        self.create_payment_calls.append(payment_required)
        return self.payload_to_return

    async def handle_payment_response(self, ctx):
        self.handle_payment_response_calls.append(ctx)
        return None


class MockX402ClientSync:
    """Mock sync x402ClientSync for testing."""

    def __init__(self, payload_to_return: PaymentPayload | PaymentPayloadV1 | None = None):
        self.payload_to_return = payload_to_return or make_v2_payload()
        self.create_payment_calls: list = []
        self.handle_payment_response_calls: list = []

    def create_payment_payload(self, payment_required):
        self.create_payment_calls.append(payment_required)
        return self.payload_to_return

    def handle_payment_response(self, ctx):
        self.handle_payment_response_calls.append(ctx)
        return None


# =============================================================================
# Base Class Tests (Shared Logic)
# =============================================================================


class TestX402HTTPClientBase:
    """Tests for x402HTTPClientBase shared logic."""

    def test_encode_v2_payment_header(self):
        """Test encoding V2 payment payload returns PAYMENT-SIGNATURE header."""
        base = x402HTTPClientBase()
        payload = make_v2_payload()

        headers = base.encode_payment_signature_header(payload)

        assert PAYMENT_SIGNATURE_HEADER in headers
        assert X_PAYMENT_HEADER not in headers

    def test_encode_v1_payment_header(self):
        """Test encoding V1 payment payload returns X-PAYMENT header."""
        base = x402HTTPClientBase()
        payload = PaymentPayloadV1(
            x402_version=1,
            scheme="exact",
            network="base-sepolia",
            payload={"signature": "0xabc"},
        )

        headers = base.encode_payment_signature_header(payload)

        assert X_PAYMENT_HEADER in headers
        assert PAYMENT_SIGNATURE_HEADER not in headers

    def test_encode_unsupported_version_raises(self):
        """Test encoding unsupported version raises ValueError."""
        base = x402HTTPClientBase()
        # Create valid payload then modify version
        payload = make_v2_payload()
        # Manually set invalid version (bypassing validation)
        object.__setattr__(payload, "x402_version", 99)

        with pytest.raises(ValueError, match="Unsupported x402 version"):
            base.encode_payment_signature_header(payload)

    def test_get_payment_required_from_v2_header(self):
        """Test extracting PaymentRequired from V2 header."""
        base = x402HTTPClientBase()
        requirements = make_payment_requirements()
        payment_required = PaymentRequired(x402_version=2, accepts=[requirements])
        encoded = encode_payment_required_header(payment_required)

        def get_header(name: str) -> str | None:
            if name == PAYMENT_REQUIRED_HEADER:
                return encoded
            return None

        result = base.get_payment_required_response(get_header)

        assert isinstance(result, PaymentRequired)
        assert result.x402_version == 2
        assert len(result.accepts) == 1

    def test_get_payment_required_from_v1_body(self):
        """Test extracting PaymentRequired from V1 body."""
        base = x402HTTPClientBase()
        body = {
            "x402Version": 1,
            "accepts": [
                {
                    "scheme": "exact",
                    "network": "base-sepolia",
                    "maxAmountRequired": "500000",
                    "resource": "https://example.com",
                    "description": "Test",
                    "mimeType": "application/json",
                    "payTo": "0x1234567890123456789012345678901234567890",
                    "maxTimeoutSeconds": 300,
                    "asset": "0x0000000000000000000000000000000000000000",
                    "extra": {},
                }
            ],
        }

        def get_header(name: str) -> str | None:
            return None

        result = base.get_payment_required_response(get_header, body)

        assert isinstance(result, PaymentRequiredV1)
        assert result.x402_version == 1

    def test_get_payment_required_from_v1_bytes_body(self):
        """Test extracting PaymentRequired from V1 body as bytes."""
        base = x402HTTPClientBase()
        body = {
            "x402Version": 1,
            "accepts": [
                {
                    "scheme": "exact",
                    "network": "base-sepolia",
                    "maxAmountRequired": "500000",
                    "resource": "https://example.com",
                    "description": "Test",
                    "mimeType": "application/json",
                    "payTo": "0x1234567890123456789012345678901234567890",
                    "maxTimeoutSeconds": 300,
                    "asset": "0x0000000000000000000000000000000000000000",
                    "extra": {},
                }
            ],
        }
        body_bytes = json.dumps(body).encode("utf-8")

        def get_header(name: str) -> str | None:
            return None

        result = base.get_payment_required_response(get_header, body_bytes)

        assert isinstance(result, PaymentRequiredV1)

    def test_get_payment_required_raises_on_missing(self):
        """Test that ValueError is raised when no payment required info found."""
        base = x402HTTPClientBase()

        def get_header(name: str) -> str | None:
            return None

        with pytest.raises(ValueError, match="Invalid payment required response"):
            base.get_payment_required_response(get_header)

    def test_get_settle_response_from_v2_header(self):
        """Test extracting SettleResponse from V2 header."""
        base = x402HTTPClientBase()
        settle = SettleResponse(
            success=True,
            transaction="0xabc123",
            network="eip155:8453",
            payer="0x1234567890123456789012345678901234567890",
        )
        encoded = encode_payment_response_header(settle)

        def get_header(name: str) -> str | None:
            if name == PAYMENT_RESPONSE_HEADER:
                return encoded
            return None

        result = base.get_payment_settle_response(get_header)

        assert result.success is True
        assert result.transaction == "0xabc123"

    def test_get_settle_response_from_v1_header(self):
        """Test extracting SettleResponse from V1 X-PAYMENT-RESPONSE header."""
        base = x402HTTPClientBase()
        settle = SettleResponse(
            success=True,
            transaction="0xdef456",
            network="eip155:8453",
        )
        encoded = encode_payment_response_header(settle)

        def get_header(name: str) -> str | None:
            if name == X_PAYMENT_RESPONSE_HEADER:
                return encoded
            return None

        result = base.get_payment_settle_response(get_header)

        assert result.success is True

    def test_get_settle_response_raises_on_missing(self):
        """Test that ValueError is raised when no payment response header found."""
        base = x402HTTPClientBase()

        def get_header(name: str) -> str | None:
            return None

        with pytest.raises(ValueError, match="Payment response header not found"):
            base.get_payment_settle_response(get_header)


# =============================================================================
# Async HTTP Client Tests
# =============================================================================


class TestX402HTTPClient:
    """Tests for async x402HTTPClient."""

    @pytest.mark.asyncio
    async def test_create_payment_payload_delegates(self):
        """Test that create_payment_payload delegates to underlying client."""
        mock_client = MockX402Client()
        http_client = x402HTTPClient(mock_client)

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )

        result = await http_client.create_payment_payload(payment_required)

        assert len(mock_client.create_payment_calls) == 1
        assert mock_client.create_payment_calls[0] == payment_required
        assert result == mock_client.payload_to_return

    @pytest.mark.asyncio
    async def test_handle_402_response(self):
        """Test handle_402_response convenience method."""
        mock_client = MockX402Client()
        http_client = x402HTTPClient(mock_client)

        # Create encoded payment required header
        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)
        headers = {PAYMENT_REQUIRED_HEADER: encoded}

        payment_headers, payload = await http_client.handle_402_response(headers, None)

        assert PAYMENT_SIGNATURE_HEADER in payment_headers
        assert payload.x402_version == 2


# =============================================================================
# Sync HTTP Client Tests
# =============================================================================


class TestX402HTTPClientSync:
    """Tests for sync x402HTTPClientSync."""

    def test_create_payment_payload_delegates(self):
        """Test that create_payment_payload delegates to underlying client."""
        mock_client = MockX402ClientSync()
        http_client = x402HTTPClientSync(mock_client)

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )

        result = http_client.create_payment_payload(payment_required)

        assert len(mock_client.create_payment_calls) == 1
        assert result == mock_client.payload_to_return

    def test_handle_402_response(self):
        """Test handle_402_response convenience method."""
        mock_client = MockX402ClientSync()
        http_client = x402HTTPClientSync(mock_client)

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)
        headers = {PAYMENT_REQUIRED_HEADER: encoded}

        payment_headers, payload = http_client.handle_402_response(headers, None)

        assert PAYMENT_SIGNATURE_HEADER in payment_headers
        assert payload.x402_version == 2

    def test_rejects_async_client(self):
        """Test that TypeError is raised when async client is passed."""
        mock_async_client = MockX402Client()  # Has async create_payment_payload

        with pytest.raises(TypeError, match="requires a sync client"):
            x402HTTPClientSync(mock_async_client)  # type: ignore


# =============================================================================
# process_payment_result Tests
# =============================================================================


class TestProcessPaymentResult:
    @pytest.mark.asyncio
    async def test_v1_skips_response_hooks(self):
        mock_client = MockX402Client()
        http_client = x402HTTPClient(mock_client)
        payload = PaymentPayloadV1(
            x402_version=1,
            scheme="exact",
            network="base-sepolia",
            payload={"signature": "0xabc"},
        )

        result = await http_client.process_payment_result(payload, lambda _: None, 200)

        assert result.recovered is False
        assert len(mock_client.handle_payment_response_calls) == 0

    @pytest.mark.asyncio
    async def test_v2_settle_header_dispatches_hooks(self):
        mock_client = MockX402Client()
        http_client = x402HTTPClient(mock_client)
        payload = make_v2_payload()
        settle = SettleResponse(
            success=True,
            transaction="0xabc",
            network="eip155:8453",
        )
        encoded = encode_payment_response_header(settle)

        result = await http_client.process_payment_result(
            payload,
            lambda name: encoded if name == PAYMENT_RESPONSE_HEADER else None,
            200,
        )

        assert result.recovered is False
        assert result.settle_response is not None
        assert len(mock_client.handle_payment_response_calls) == 1

    @pytest.mark.asyncio
    async def test_v2_corrective_402_dispatches_hooks(self):
        mock_client = MockX402Client()
        http_client = x402HTTPClient(mock_client)
        payload = make_v2_payload()
        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)

        result = await http_client.process_payment_result(
            payload,
            lambda name: encoded if name == PAYMENT_REQUIRED_HEADER else None,
            402,
        )

        assert result.recovered is False
        assert len(mock_client.handle_payment_response_calls) == 1
        assert mock_client.handle_payment_response_calls[0].payment_required is not None

    @pytest.mark.asyncio
    async def test_recovery_from_hook(self):
        mock_client = MockX402Client()

        async def recover(ctx):
            return RecoveredResponseResult()

        mock_client.handle_payment_response = recover  # type: ignore[method-assign]
        http_client = x402HTTPClient(mock_client)
        payload = make_v2_payload()
        settle = SettleResponse(
            success=False,
            error_reason="failed",
            transaction="0x0",
            network="eip155:8453",
        )
        encoded = encode_payment_response_header(settle)

        result = await http_client.process_payment_result(
            payload,
            lambda name: encoded if name == PAYMENT_RESPONSE_HEADER else None,
            402,
        )

        assert result.recovered is True

    def test_sync_v2_no_headers_skips_hooks(self):
        mock_client = MockX402ClientSync()
        http_client = x402HTTPClientSync(mock_client)
        payload = make_v2_payload()

        result = http_client.process_payment_result(payload, lambda _: None, 200)

        assert result.recovered is False
        assert len(mock_client.handle_payment_response_calls) == 0


# =============================================================================
# PaymentRoundTripper Tests
# =============================================================================


class TestPaymentRoundTripper:
    """Tests for PaymentRoundTripper utility class."""

    def test_non_402_returns_none(self):
        """Test that non-402 responses return None (signal to return original)."""
        mock_client = MockX402ClientSync()
        http_client = x402HTTPClientSync(mock_client)
        tripper = PaymentRoundTripper(http_client)

        result = tripper.handle_response(
            request_id="req1",
            status_code=200,
            headers={},
            body=None,
            retry_func=lambda h: "should not be called",
        )

        assert result is None

    def test_402_triggers_payment_and_retry(self):
        """Test that 402 response triggers payment creation and retry."""
        mock_client = MockX402ClientSync()
        http_client = x402HTTPClientSync(mock_client)
        tripper = PaymentRoundTripper(http_client)

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)
        headers = {PAYMENT_REQUIRED_HEADER: encoded}

        retry_called_with = []

        def retry_func(payment_headers):
            retry_called_with.append(payment_headers)
            return "retry_response"

        result = tripper.handle_response(
            request_id="req2",
            status_code=402,
            headers=headers,
            body=None,
            retry_func=retry_func,
        )

        assert result == "retry_response"
        assert len(retry_called_with) == 1
        assert PAYMENT_SIGNATURE_HEADER in retry_called_with[0]

    def test_retry_limit_exceeded(self):
        """Test that retry limit is enforced."""
        mock_client = MockX402ClientSync()
        http_client = x402HTTPClientSync(mock_client)
        tripper = PaymentRoundTripper(http_client)

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)
        headers = {PAYMENT_REQUIRED_HEADER: encoded}

        # First 402 - should succeed
        tripper.handle_response(
            request_id="req3",
            status_code=402,
            headers=headers,
            body=None,
            retry_func=lambda h: "first",
        )

        # Manually set retry count to simulate already retried
        tripper._retry_counts["req4"] = 1

        # Second 402 with same request - should raise
        with pytest.raises(RuntimeError, match="Payment retry limit exceeded"):
            tripper.handle_response(
                request_id="req4",
                status_code=402,
                headers=headers,
                body=None,
                retry_func=lambda h: "should not happen",
            )
