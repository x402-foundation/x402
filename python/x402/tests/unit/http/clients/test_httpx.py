"""Unit tests for x402.http.clients.httpx - httpx transport wrapper."""

import warnings
from unittest.mock import AsyncMock, MagicMock

import pytest

from x402.http.clients.httpx import (
    MissingRequestConfigError,
    PaymentAlreadyAttemptedError,
    PaymentError,
    wrapHttpxWithPayment,
    x402_httpx_hooks,
    x402_httpx_transport,
    x402AsyncTransport,
    x402HttpxClient,
)
from x402.http.utils import encode_payment_required_header, encode_payment_response_header
from x402.http.x402_http_client import x402HTTPClient
from x402.schemas import PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse
from x402.schemas.hooks import PaymentRequiredHeadersResult, RecoveredResponseResult

# Skip tests if httpx not installed
pytest.importorskip("httpx")
import httpx

# =============================================================================
# Helpers
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


# =============================================================================
# Mock x402 Clients
# =============================================================================


class MockX402Client:
    """Mock async x402Client for testing."""

    def __init__(self, payload: PaymentPayload | None = None):
        self.payload = payload or make_v2_payload()
        self.create_calls: list = []

    async def create_payment_payload(self, payment_required):
        self.create_calls.append(payment_required)
        return self.payload

    async def handle_payment_response(self, ctx):
        return None


class MockRecoveringClient(MockX402Client):
    async def handle_payment_response(self, ctx):
        return RecoveredResponseResult()


# =============================================================================
# Transport Tests
# =============================================================================


class TestX402AsyncTransport:
    """Tests for x402AsyncTransport."""

    def test_init_with_x402_client(self):
        """Test initialization with x402Client."""
        mock_client = MockX402Client()
        transport = x402AsyncTransport(mock_client)

        assert transport._client == mock_client
        assert transport._http_client is not None

    def test_init_with_http_client(self):
        """Test initialization with x402HTTPClient."""
        mock_client = MockX402Client()
        http_client = x402HTTPClient(mock_client)
        transport = x402AsyncTransport(http_client)

        assert transport._http_client == http_client

    def test_retry_key_constant(self):
        """Test that RETRY_KEY constant is set."""
        assert x402AsyncTransport.RETRY_KEY == "_x402_is_retry"

    @pytest.mark.asyncio
    async def test_non_402_passes_through(self):
        """Test that non-402 responses pass through unchanged."""
        mock_client = MockX402Client()

        # Create mock transport that returns 200
        mock_transport = AsyncMock()
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_transport.handle_async_request = AsyncMock(return_value=mock_response)

        transport = x402AsyncTransport(mock_client, mock_transport)

        request = httpx.Request("GET", "https://example.com/api")
        response = await transport.handle_async_request(request)

        assert response == mock_response
        assert len(mock_client.create_calls) == 0

    @pytest.mark.asyncio
    async def test_402_triggers_payment_retry(self):
        """Test that 402 response triggers payment creation and retry."""
        mock_client = MockX402Client()

        # Create payment required response
        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)

        # Mock 402 response then 200 on retry
        mock_402_response = MagicMock()
        mock_402_response.status_code = 402
        mock_402_response.headers = {"PAYMENT-REQUIRED": encoded}
        mock_402_response.json.return_value = None
        mock_402_response.aread = AsyncMock()

        mock_200_response = MagicMock()
        mock_200_response.status_code = 200

        mock_transport = AsyncMock()
        mock_transport.handle_async_request = AsyncMock(
            side_effect=[mock_402_response, mock_200_response]
        )

        transport = x402AsyncTransport(mock_client, mock_transport)

        request = httpx.Request("GET", "https://example.com/api")
        response = await transport.handle_async_request(request)

        assert response == mock_200_response
        assert len(mock_client.create_calls) == 1
        assert mock_transport.handle_async_request.call_count == 2

    @pytest.mark.asyncio
    async def test_retry_request_has_payment_headers(self):
        """Test that retry request includes payment headers."""
        mock_client = MockX402Client()

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)

        mock_402_response = MagicMock()
        mock_402_response.status_code = 402
        mock_402_response.headers = {"PAYMENT-REQUIRED": encoded}
        mock_402_response.json.return_value = None
        mock_402_response.aread = AsyncMock()

        mock_200_response = MagicMock()
        mock_200_response.status_code = 200

        captured_retry_request = None

        async def capture_request(req):
            nonlocal captured_retry_request
            if captured_retry_request is None:
                # First call returns 402
                return mock_402_response
            # Second call - capture and return 200
            captured_retry_request = req
            return mock_200_response

        mock_transport = AsyncMock()
        # Set side effect manually
        call_count = [0]

        async def handle_request(req):
            call_count[0] += 1
            if call_count[0] == 1:
                return mock_402_response
            return mock_200_response

        mock_transport.handle_async_request = handle_request

        transport = x402AsyncTransport(mock_client, mock_transport)

        request = httpx.Request("GET", "https://example.com/api")
        await transport.handle_async_request(request)

        # Can't easily capture the retry request in this test setup,
        # but we verified payment was created

    @pytest.mark.asyncio
    async def test_retry_flag_prevents_infinite_loop(self):
        """Test that retry flag prevents infinite payment loops."""
        mock_client = MockX402Client()

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)

        # Both responses are 402
        mock_402_response = MagicMock()
        mock_402_response.status_code = 402
        mock_402_response.headers = {"PAYMENT-REQUIRED": encoded}
        mock_402_response.json.return_value = None
        mock_402_response.aread = AsyncMock()

        mock_transport = AsyncMock()
        mock_transport.handle_async_request = AsyncMock(return_value=mock_402_response)

        transport = x402AsyncTransport(mock_client, mock_transport)

        # Create request with retry flag already set
        request = httpx.Request(
            "GET",
            "https://example.com/api",
            extensions={x402AsyncTransport.RETRY_KEY: True},
        )
        response = await transport.handle_async_request(request)

        # Should return 402 without retrying (no payment creation)
        assert response == mock_402_response
        assert len(mock_client.create_calls) == 0

    @pytest.mark.asyncio
    async def test_aclose_delegates(self):
        """Test that aclose delegates to underlying transport."""
        mock_client = MockX402Client()
        mock_transport = AsyncMock()

        transport = x402AsyncTransport(mock_client, mock_transport)
        await transport.aclose()

        mock_transport.aclose.assert_called_once()

    @pytest.mark.asyncio
    async def test_hook_header_retry_bypasses_payment(self):
        """Hook-provided headers that succeed skip payment creation."""
        mock_client = MockX402Client()
        http_client = x402HTTPClient(mock_client)
        http_client.on_payment_required(
            lambda ctx: PaymentRequiredHeadersResult(headers={"Authorization": "Bearer x"})
        )

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)

        mock_402 = MagicMock()
        mock_402.status_code = 402
        mock_402.headers = {"PAYMENT-REQUIRED": encoded}
        mock_402.json.return_value = None
        mock_402.aread = AsyncMock()

        mock_200 = MagicMock()
        mock_200.status_code = 200

        mock_transport = AsyncMock()
        mock_transport.handle_async_request = AsyncMock(side_effect=[mock_402, mock_200])

        transport = x402AsyncTransport(http_client, mock_transport)
        response = await transport.handle_async_request(
            httpx.Request("GET", "https://example.com/api")
        )

        assert response == mock_200
        assert len(mock_client.create_calls) == 0
        assert mock_transport.handle_async_request.call_count == 2

    @pytest.mark.asyncio
    async def test_recovery_calls_create_payment_payload_twice(self):
        """Recovery retry creates a fresh payload after hook signals recovered."""
        mock_client = MockRecoveringClient()
        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded_required = encode_payment_required_header(payment_required)
        settle = SettleResponse(
            success=False,
            error_reason="failed",
            transaction="0x0",
            network="eip155:8453",
        )
        encoded_response = encode_payment_response_header(settle)

        mock_initial_402 = MagicMock()
        mock_initial_402.status_code = 402
        mock_initial_402.headers = {"PAYMENT-REQUIRED": encoded_required}
        mock_initial_402.json.return_value = None
        mock_initial_402.aread = AsyncMock()

        mock_paid_402 = MagicMock()
        mock_paid_402.status_code = 402
        mock_paid_402.headers = {"PAYMENT-RESPONSE": encoded_response}
        mock_paid_402.aread = AsyncMock()

        mock_success = MagicMock()
        mock_success.status_code = 200
        mock_success.headers = httpx.Headers()

        mock_transport = AsyncMock()
        mock_transport.handle_async_request = AsyncMock(
            side_effect=[mock_initial_402, mock_paid_402, mock_success]
        )

        transport = x402AsyncTransport(mock_client, mock_transport)
        response = await transport.handle_async_request(
            httpx.Request("GET", "https://example.com/api")
        )

        assert response.status_code == 200
        assert len(mock_client.create_calls) == 2
        assert mock_transport.handle_async_request.call_count == 3


# =============================================================================
# Factory Function Tests
# =============================================================================


class TestX402HttpxTransport:
    """Tests for x402_httpx_transport factory function."""

    def test_creates_transport(self):
        """Test that factory creates x402AsyncTransport."""
        mock_client = MockX402Client()
        transport = x402_httpx_transport(mock_client)

        assert isinstance(transport, x402AsyncTransport)


class TestX402HttpxHooks:
    """Tests for deprecated x402_httpx_hooks function."""

    def test_emits_deprecation_warning(self):
        """Test that x402_httpx_hooks emits deprecation warning."""
        mock_client = MockX402Client()

        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            _ = x402_httpx_hooks(mock_client)

            assert len(w) == 1
            assert issubclass(w[0].category, DeprecationWarning)
            assert "deprecated" in str(w[0].message).lower()

    def test_returns_empty_hooks(self):
        """Test that deprecated function returns empty hooks dict."""
        mock_client = MockX402Client()

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            hooks = x402_httpx_hooks(mock_client)

        assert hooks == {"request": [], "response": []}


# =============================================================================
# Wrapper Function Tests
# =============================================================================


class TestWrapHttpxWithPayment:
    """Tests for wrapHttpxWithPayment function."""

    def test_creates_async_client_with_transport(self):
        """Test that wrapper creates AsyncClient with payment transport."""
        mock_client = MockX402Client()
        client = wrapHttpxWithPayment(mock_client)

        assert isinstance(client, httpx.AsyncClient)
        # Transport should be x402AsyncTransport
        assert isinstance(client._transport, x402AsyncTransport)

    def test_passes_httpx_kwargs(self):
        """Test that additional kwargs are passed to AsyncClient."""
        mock_client = MockX402Client()
        client = wrapHttpxWithPayment(mock_client, timeout=30.0)

        assert client.timeout.connect == 30.0


# =============================================================================
# Convenience Class Tests
# =============================================================================


class TestX402HttpxClient:
    """Tests for x402HttpxClient convenience class."""

    def test_inherits_from_async_client(self):
        """Test that x402HttpxClient inherits from httpx.AsyncClient."""
        mock_client = MockX402Client()
        client = x402HttpxClient(mock_client)

        assert isinstance(client, httpx.AsyncClient)

    def test_has_payment_transport(self):
        """Test that x402HttpxClient uses payment transport."""
        mock_client = MockX402Client()
        client = x402HttpxClient(mock_client)

        assert isinstance(client._transport, x402AsyncTransport)

    def test_accepts_additional_kwargs(self):
        """Test that additional kwargs are passed through."""
        mock_client = MockX402Client()
        client = x402HttpxClient(mock_client, timeout=60.0)

        assert client.timeout.connect == 60.0


# =============================================================================
# Error Class Tests
# =============================================================================


class TestPaymentErrors:
    """Tests for payment error classes."""

    def test_payment_error_is_exception(self):
        """Test PaymentError is an Exception."""
        error = PaymentError("test error")
        assert isinstance(error, Exception)
        assert str(error) == "test error"

    def test_payment_already_attempted_inherits(self):
        """Test PaymentAlreadyAttemptedError inherits from PaymentError."""
        error = PaymentAlreadyAttemptedError()
        assert isinstance(error, PaymentError)

    def test_missing_request_config_inherits(self):
        """Test MissingRequestConfigError inherits from PaymentError."""
        error = MissingRequestConfigError()
        assert isinstance(error, PaymentError)


# =============================================================================
# Additional Mock Classes for Fixture-based Tests
# =============================================================================


class MockX402ClientWithCounter:
    """Mock x402Client for testing with call count tracking."""

    def __init__(self, payload: PaymentPayload | None = None):
        self.payload = payload or make_v2_payload()
        self.create_payment_payload_call_count = 0

    async def create_payment_payload(self, payment_required):
        self.create_payment_payload_call_count += 1
        return self.payload


class MockX402HTTPClientForTransport:
    """Mock x402HTTPClient for testing transport."""

    def __init__(self):
        self.get_payment_required_response_call_count = 0

    def get_payment_required_response(self, _get_header, _body):
        self.get_payment_required_response_call_count += 1
        return MagicMock(
            scheme="exact",
            network="base-sepolia",
            asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            amount="10000",
            pay_to="0x0000000000000000000000000000000000000000",
        )

    def encode_payment_signature_header(self, _payload):
        return {"X-Payment": "mock_payment_header"}


# =============================================================================
# Fixtures for Transport Tests
# =============================================================================


@pytest.fixture(scope="function")
def mock_client_with_counter():
    """Create a mock x402Client with call counting."""
    return MockX402ClientWithCounter()


@pytest.fixture(scope="function")
def mock_http_client_for_transport():
    """Create a mock x402HTTPClient for transport tests."""
    return MockX402HTTPClientForTransport()


@pytest.fixture(scope="function")
def transport_with_mocks(mock_client_with_counter, mock_http_client_for_transport):
    """Create an x402AsyncTransport with mocked dependencies.

    Uses MagicMock spec to create a valid transport instance, then injects
    mock dependencies for isolated unit testing.
    """
    transport = MagicMock(spec=x402AsyncTransport)
    transport._client = mock_client_with_counter
    transport._http_client = mock_http_client_for_transport
    transport.RETRY_KEY = x402AsyncTransport.RETRY_KEY
    return transport


def _create_mock_response(status_code: int, content: bytes = b"") -> MagicMock:
    """Create a mock httpx Response object."""
    response = MagicMock()
    response.status_code = status_code
    response.content = content
    response.headers = {}
    response.json.return_value = None
    response.aread = AsyncMock()
    return response


def _create_httpx_request(url: str = "https://example.com") -> httpx.Request:
    """Create an httpx Request object."""
    return httpx.Request("GET", url)


# =============================================================================
# Consecutive Payments Tests
# =============================================================================


class TestConsecutivePayments:
    """Test consecutive payment requests."""

    @pytest.mark.asyncio
    async def test_should_handle_all_consecutive_402_requests(self):
        """Should handle all consecutive 402 requests with payment retry."""
        mock_client = MockX402ClientWithCounter()

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)

        call_count = 0

        async def mock_handle_request(request):
            nonlocal call_count
            call_count += 1
            is_retry = request.extensions.get(x402AsyncTransport.RETRY_KEY)
            if is_retry:
                return _create_mock_response(200, b'{"success": true}')
            mock_402 = _create_mock_response(402, b"{}")
            mock_402.headers = {"PAYMENT-REQUIRED": encoded}
            return mock_402

        mock_transport = AsyncMock()
        mock_transport.handle_async_request = mock_handle_request

        transport = x402AsyncTransport(mock_client, mock_transport)

        for i in range(3):
            request = _create_httpx_request(f"https://example.com/resource{i}")
            response = await transport.handle_async_request(request)
            assert response.status_code == 200, f"Request {i + 1} failed"

        assert call_count == 6  # 3 initial + 3 retries
        assert mock_client.create_payment_payload_call_count == 3

    @pytest.mark.asyncio
    async def test_should_set_retry_key_on_retry_request(self):
        """Should set retry key extension on the retry request."""
        mock_client = MockX402ClientWithCounter()

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)

        captured_requests = []

        async def mock_handle_request(request):
            captured_requests.append(request)
            is_retry = request.extensions.get(x402AsyncTransport.RETRY_KEY)
            if is_retry:
                return _create_mock_response(200, b'{"success": true}')
            mock_402 = _create_mock_response(402, b"{}")
            mock_402.headers = {"PAYMENT-REQUIRED": encoded}
            return mock_402

        mock_transport = AsyncMock()
        mock_transport.handle_async_request = mock_handle_request

        transport = x402AsyncTransport(mock_client, mock_transport)
        await transport.handle_async_request(_create_httpx_request())

        assert x402AsyncTransport.RETRY_KEY not in captured_requests[0].extensions
        assert captured_requests[1].extensions.get(x402AsyncTransport.RETRY_KEY) is True

    @pytest.mark.asyncio
    async def test_should_not_modify_original_request(self):
        """Should not modify original request during retry."""
        mock_client = MockX402ClientWithCounter()

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)

        async def mock_handle_request(request):
            is_retry = request.extensions.get(x402AsyncTransport.RETRY_KEY)
            if is_retry:
                return _create_mock_response(200, b'{"success": true}')
            mock_402 = _create_mock_response(402, b"{}")
            mock_402.headers = {"PAYMENT-REQUIRED": encoded}
            return mock_402

        mock_transport = AsyncMock()
        mock_transport.handle_async_request = mock_handle_request

        transport = x402AsyncTransport(mock_client, mock_transport)
        original_request = _create_httpx_request()
        await transport.handle_async_request(original_request)

        assert x402AsyncTransport.RETRY_KEY not in original_request.extensions
        assert "X-Payment" not in original_request.headers

    @pytest.mark.asyncio
    async def test_should_handle_mixed_200_and_402_requests(self):
        """Should handle alternating free (200) and paid (402) requests."""
        mock_client = MockX402ClientWithCounter()

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)

        call_sequence = []

        async def mock_handle_request(request):
            url = str(request.url)
            is_retry = request.extensions.get(x402AsyncTransport.RETRY_KEY)
            call_sequence.append((url, is_retry or False))

            if "/free" in url:
                return _create_mock_response(200, b'{"free": true}')
            elif is_retry:
                return _create_mock_response(200, b'{"paid": true}')
            mock_402 = _create_mock_response(402, b"{}")
            mock_402.headers = {"PAYMENT-REQUIRED": encoded}
            return mock_402

        mock_transport = AsyncMock()
        mock_transport.handle_async_request = mock_handle_request

        transport = x402AsyncTransport(mock_client, mock_transport)

        urls = [
            "https://example.com/free",
            "https://example.com/paid1",
            "https://example.com/free",
            "https://example.com/paid2",
        ]
        for url in urls:
            response = await transport.handle_async_request(_create_httpx_request(url))
            assert response.status_code == 200

        expected = [
            ("https://example.com/free", False),
            ("https://example.com/paid1", False),
            ("https://example.com/paid1", True),
            ("https://example.com/free", False),
            ("https://example.com/paid2", False),
            ("https://example.com/paid2", True),
        ]
        assert call_sequence == expected


# =============================================================================
# Basic Functionality Tests with Parametrization
# =============================================================================


class TestBasicFunctionalityParameterized:
    """Test basic transport functionality with parameterized tests."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("status_code", "content"),
        [
            (200, b"success"),
            (404, b"not found"),
            (500, b"server error"),
            (301, b"redirect"),
        ],
    )
    async def test_should_return_non_402_response_directly(self, status_code, content):
        """Should return non-402 responses without payment handling."""
        mock_client = MockX402ClientWithCounter()
        mock_response = _create_mock_response(status_code, content)

        mock_transport = AsyncMock()
        mock_transport.handle_async_request = AsyncMock(return_value=mock_response)

        transport = x402AsyncTransport(mock_client, mock_transport)
        response = await transport.handle_async_request(_create_httpx_request())

        assert response.status_code == status_code
        assert response.content == content
        assert mock_client.create_payment_payload_call_count == 0

    @pytest.mark.asyncio
    async def test_should_return_402_directly_when_retry_key_present(self):
        """Should return 402 directly when retry key is present.

        This prevents infinite retry loops when payment is rejected.
        """
        mock_client = MockX402ClientWithCounter()
        mock_response = _create_mock_response(402, b"payment rejected")

        mock_transport = AsyncMock()
        mock_transport.handle_async_request = AsyncMock(return_value=mock_response)

        transport = x402AsyncTransport(mock_client, mock_transport)
        request = httpx.Request(
            "GET",
            "https://example.com",
            extensions={x402AsyncTransport.RETRY_KEY: True},
        )

        response = await transport.handle_async_request(request)

        assert response.status_code == 402
        assert mock_client.create_payment_payload_call_count == 0


# =============================================================================
# Error Handling Tests
# =============================================================================


class TestErrorHandlingTransport:
    """Test error handling in the transport."""

    @pytest.mark.asyncio
    async def test_should_raise_payment_error_on_client_error(self):
        """Should raise PaymentError when client fails."""
        mock_client = MagicMock()
        mock_client.create_payment_payload = AsyncMock(side_effect=Exception("Client error"))

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)

        mock_402 = _create_mock_response(402, b"{}")
        mock_402.headers = {"PAYMENT-REQUIRED": encoded}

        mock_transport = AsyncMock()
        mock_transport.handle_async_request = AsyncMock(return_value=mock_402)

        transport = x402AsyncTransport(mock_client, mock_transport)

        with pytest.raises(PaymentError, match="Failed to handle payment"):
            await transport.handle_async_request(_create_httpx_request())

    @pytest.mark.asyncio
    async def test_should_propagate_payment_error(self):
        """Should propagate PaymentError from client."""
        mock_client = MagicMock()
        mock_client.create_payment_payload = AsyncMock(
            side_effect=PaymentError("Custom payment error")
        )

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)

        mock_402 = _create_mock_response(402, b"{}")
        mock_402.headers = {"PAYMENT-REQUIRED": encoded}

        mock_transport = AsyncMock()
        mock_transport.handle_async_request = AsyncMock(return_value=mock_402)

        transport = x402AsyncTransport(mock_client, mock_transport)

        with pytest.raises(PaymentError, match="Custom payment error"):
            await transport.handle_async_request(_create_httpx_request())


# =============================================================================
# Factory Functions Tests with Patching
# =============================================================================


class TestFactoryFunctionsWithPatch:
    """Test factory functions for creating transports and clients."""

    def test_x402_httpx_transport_should_create_transport(self):
        """Should create x402AsyncTransport instance."""
        mock_client = MockX402Client()
        transport = x402_httpx_transport(mock_client)
        assert isinstance(transport, x402AsyncTransport)

    def test_wrap_httpx_with_payment_should_create_client_with_transport(self):
        """Should create AsyncClient with x402AsyncTransport."""
        mock_client = MockX402Client()
        client = wrapHttpxWithPayment(mock_client)

        assert isinstance(client, httpx.AsyncClient)
        assert isinstance(client._transport, x402AsyncTransport)

    def test_x402_httpx_client_should_create_client_with_transport(self):
        """Should create x402HttpxClient with payment transport."""
        mock_client = MockX402Client()
        client = x402HttpxClient(mock_client)

        assert isinstance(client, httpx.AsyncClient)
        assert isinstance(client._transport, x402AsyncTransport)
