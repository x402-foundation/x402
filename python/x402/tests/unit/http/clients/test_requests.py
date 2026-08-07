"""Unit tests for x402.http.clients.requests - requests adapter wrapper."""

import json
from unittest.mock import MagicMock, patch

import pytest

from x402.http.clients.requests import (
    PaymentAlreadyAttemptedError,
    PaymentError,
    wrapRequestsWithPayment,
    x402_http_adapter,
    x402_requests,
    x402HTTPAdapter,
)
from x402.http.utils import encode_payment_required_header, encode_payment_response_header
from x402.http.x402_http_client import x402HTTPClientSync
from x402.http.x402_http_client_base import ProcessPaymentResult
from x402.schemas import PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse
from x402.schemas.hooks import PaymentRequiredHeadersResult, RecoveredResponseResult

# Skip tests if requests not installed
pytest.importorskip("requests")
import requests

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


class MockX402ClientSync:
    """Mock sync x402ClientSync for testing."""

    def __init__(self, payload: PaymentPayload | None = None):
        self.payload = payload or make_v2_payload()
        self.create_calls: list = []

    def create_payment_payload(self, payment_required):
        self.create_calls.append(payment_required)
        return self.payload

    def handle_payment_response(self, ctx):
        return None


class MockRecoveringClientSync(MockX402ClientSync):
    def handle_payment_response(self, ctx):
        return RecoveredResponseResult()


class MockX402ClientAsync:
    """Mock async x402Client for testing type checking."""

    async def create_payment_payload(self, payment_required):
        return None


# =============================================================================
# Adapter Tests
# =============================================================================


class TestX402HTTPAdapter:
    """Tests for x402HTTPAdapter."""

    def test_init_with_sync_client(self):
        """Test initialization with sync x402ClientSync."""
        mock_client = MockX402ClientSync()
        adapter = x402HTTPAdapter(mock_client)

        assert adapter._client == mock_client
        assert adapter._http_client is not None

    def test_init_with_http_client(self):
        """Test initialization with x402HTTPClientSync."""
        mock_client = MockX402ClientSync()
        http_client = x402HTTPClientSync(mock_client)
        adapter = x402HTTPAdapter(http_client)

        assert adapter._http_client == http_client

    def test_init_rejects_async_client(self):
        """Test that TypeError is raised for async client."""
        mock_async_client = MockX402ClientAsync()

        with pytest.raises(TypeError, match="requires a sync client"):
            x402HTTPAdapter(mock_async_client)  # type: ignore

    def test_send_non_402_passes_through(self):
        """Test that non-402 responses pass through unchanged."""
        mock_client = MockX402ClientSync()
        adapter = x402HTTPAdapter(mock_client)

        # Create mock request and response
        mock_request = MagicMock(spec=requests.PreparedRequest)
        mock_request.headers = {}

        mock_response = MagicMock(spec=requests.Response)
        mock_response.status_code = 200
        mock_response.content = b'{"data": "test"}'

        with patch.object(requests.adapters.HTTPAdapter, "send", return_value=mock_response):
            response = adapter.send(mock_request)

        assert response == mock_response
        assert len(mock_client.create_calls) == 0

    def test_send_402_triggers_payment_retry(self):
        """Test that 402 response triggers payment creation and retry."""
        mock_client = MockX402ClientSync()
        adapter = x402HTTPAdapter(mock_client)

        # Create payment required
        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)

        # Create mock request
        mock_request = MagicMock(spec=requests.PreparedRequest)
        mock_request.headers = {}

        # Create 402 and 200 responses
        mock_402_response = MagicMock(spec=requests.Response)
        mock_402_response.status_code = 402
        mock_402_response.headers = {"PAYMENT-REQUIRED": encoded}
        mock_402_response.content = b"{}"

        mock_200_response = MagicMock(spec=requests.Response)
        mock_200_response.status_code = 200
        mock_200_response.headers = {"Content-Type": "application/json"}
        mock_200_response.content = b'{"success": true}'

        call_count = [0]

        def mock_send(req, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return mock_402_response
            return mock_200_response

        with patch.object(requests.adapters.HTTPAdapter, "send", side_effect=mock_send):
            response = adapter.send(mock_request)

        # Response should have 200 status (copied from retry)
        assert response.status_code == 200
        assert len(mock_client.create_calls) == 1
        assert call_count[0] == 2

    def test_send_adds_payment_headers_on_retry(self):
        """Test that retry request includes payment headers."""
        mock_client = MockX402ClientSync()
        adapter = x402HTTPAdapter(mock_client)

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)

        mock_request = MagicMock(spec=requests.PreparedRequest)
        mock_request.headers = {}

        # Configure copy() to return a mock with a real dict for headers
        retry_headers: dict = {}
        mock_retry_request = MagicMock(spec=requests.PreparedRequest)
        mock_retry_request.headers = retry_headers
        mock_request.copy.return_value = mock_retry_request

        mock_402_response = MagicMock(spec=requests.Response)
        mock_402_response.status_code = 402
        mock_402_response.headers = {"PAYMENT-REQUIRED": encoded}
        mock_402_response.content = b"{}"

        mock_200_response = MagicMock(spec=requests.Response)
        mock_200_response.status_code = 200
        mock_200_response.headers = {}
        mock_200_response.content = b"{}"

        call_count = [0]

        def mock_send(req, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return mock_402_response
            # On retry, check headers were added
            assert "PAYMENT-SIGNATURE" in req.headers or any(
                k.upper() == "PAYMENT-SIGNATURE" for k in req.headers
            )
            return mock_200_response

        with patch.object(requests.adapters.HTTPAdapter, "send", side_effect=mock_send):
            adapter.send(mock_request)

        assert call_count[0] == 2

    def test_send_handles_v1_body_payment_required(self):
        """Test that V1 payment required in body is handled."""
        mock_client = MockX402ClientSync()
        adapter = x402HTTPAdapter(mock_client)

        v1_body = {
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

        mock_request = MagicMock(spec=requests.PreparedRequest)
        mock_request.headers = {}

        mock_402_response = MagicMock(spec=requests.Response)
        mock_402_response.status_code = 402
        mock_402_response.headers = {}  # No header
        mock_402_response.content = json.dumps(v1_body).encode("utf-8")

        mock_200_response = MagicMock(spec=requests.Response)
        mock_200_response.status_code = 200
        mock_200_response.headers = {}
        mock_200_response.content = b"{}"

        call_count = [0]

        def mock_send(req, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return mock_402_response
            return mock_200_response

        with patch.object(requests.adapters.HTTPAdapter, "send", side_effect=mock_send):
            adapter.send(mock_request)

        assert len(mock_client.create_calls) == 1

    def test_send_propagates_payment_error(self):
        """Test that PaymentError is propagated."""
        mock_client = MockX402ClientSync()
        adapter = x402HTTPAdapter(mock_client)

        mock_request = MagicMock(spec=requests.PreparedRequest)
        mock_request.headers = {}

        mock_402_response = MagicMock(spec=requests.Response)
        mock_402_response.status_code = 402
        mock_402_response.headers = {}  # No valid payment info
        mock_402_response.content = b"not json"

        with patch.object(requests.adapters.HTTPAdapter, "send", return_value=mock_402_response):
            with pytest.raises(PaymentError):
                adapter.send(mock_request)

    def test_hook_header_retry_bypasses_payment(self):
        """Hook-provided headers that succeed skip payment creation."""
        mock_client = MockX402ClientSync()
        http_client = x402HTTPClientSync(mock_client)
        http_client.on_payment_required(
            lambda ctx: PaymentRequiredHeadersResult(headers={"Authorization": "Bearer x"})
        )
        adapter = x402HTTPAdapter(http_client)

        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[make_payment_requirements()],
        )
        encoded = encode_payment_required_header(payment_required)

        mock_request = MagicMock(spec=requests.PreparedRequest)
        mock_request.headers = {}

        mock_402 = MagicMock(spec=requests.Response)
        mock_402.status_code = 402
        mock_402.headers = {"PAYMENT-REQUIRED": encoded}
        mock_402.content = b"{}"

        mock_200 = MagicMock(spec=requests.Response)
        mock_200.status_code = 200
        mock_200.headers = {}
        mock_200.content = b"{}"

        call_count = [0]

        def mock_send(req, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return mock_402
            return mock_200

        with patch.object(requests.adapters.HTTPAdapter, "send", side_effect=mock_send):
            response = adapter.send(mock_request)

        assert response == mock_200
        assert len(mock_client.create_calls) == 0
        assert call_count[0] == 2

    def test_recovery_calls_create_payment_payload_twice(self):
        """Recovery retry creates a fresh payload after hook signals recovered."""
        mock_client = MockRecoveringClientSync()
        adapter = x402HTTPAdapter(mock_client)

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

        mock_request = MagicMock(spec=requests.PreparedRequest)
        mock_request.headers = {}
        mock_retry_request = MagicMock(spec=requests.PreparedRequest)
        mock_retry_request.headers = {}
        mock_request.copy.return_value = mock_retry_request

        mock_initial_402 = MagicMock(spec=requests.Response)
        mock_initial_402.status_code = 402
        mock_initial_402.headers = {"PAYMENT-REQUIRED": encoded_required}
        mock_initial_402.content = b"{}"

        mock_paid_402 = MagicMock(spec=requests.Response)
        mock_paid_402.status_code = 402
        mock_paid_402.headers = {"PAYMENT-RESPONSE": encoded_response}
        mock_paid_402.content = b"{}"

        mock_success = MagicMock(spec=requests.Response)
        mock_success.status_code = 200
        mock_success.headers = {}
        mock_success.content = b"{}"

        call_count = [0]

        def mock_send(req, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return mock_initial_402
            if call_count[0] == 2:
                return mock_paid_402
            return mock_success

        with patch.object(requests.adapters.HTTPAdapter, "send", side_effect=mock_send):
            response = adapter.send(mock_request)

        assert response == mock_success
        assert len(mock_client.create_calls) == 2
        assert call_count[0] == 3


# =============================================================================
# Factory Function Tests
# =============================================================================


class TestX402HttpAdapter:
    """Tests for x402_http_adapter factory function."""

    def test_creates_adapter(self):
        """Test that factory creates x402HTTPAdapter."""
        mock_client = MockX402ClientSync()
        adapter = x402_http_adapter(mock_client)

        assert isinstance(adapter, x402HTTPAdapter)


class TestWrapRequestsWithPayment:
    """Tests for wrapRequestsWithPayment function."""

    def test_mounts_adapter_to_session(self):
        """Test that adapter is mounted to session."""
        mock_client = MockX402ClientSync()
        session = requests.Session()

        result = wrapRequestsWithPayment(session, mock_client)

        assert result is session
        # Check adapters are mounted
        assert isinstance(session.get_adapter("https://example.com"), x402HTTPAdapter)
        assert isinstance(session.get_adapter("http://example.com"), x402HTTPAdapter)


class TestX402Requests:
    """Tests for x402_requests convenience function."""

    def test_creates_session_with_adapter(self):
        """Test that convenience function creates configured session."""
        mock_client = MockX402ClientSync()
        session = x402_requests(mock_client)

        assert isinstance(session, requests.Session)
        assert isinstance(session.get_adapter("https://example.com"), x402HTTPAdapter)


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


class MockX402Client:
    """Mock x402Client for testing with call count tracking."""

    def __init__(self):
        self.create_payment_payload_call_count = 0

    def create_payment_payload(self, payment_required):
        self.create_payment_payload_call_count += 1
        return MagicMock(x402_version=2, accepted=payment_required)


class MockX402HTTPClient:
    """Mock x402HTTPClient for testing."""

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

    def handle_payment_required(self, _payment_required):
        return None

    def process_payment_result(self, _payment_payload, _get_header, _status):
        return ProcessPaymentResult(recovered=False)


@pytest.fixture(scope="function")
def mock_client():
    """Create a mock x402Client."""
    return MockX402Client()


@pytest.fixture(scope="function")
def mock_http_client():
    """Create a mock x402HTTPClient."""
    return MockX402HTTPClient()


@pytest.fixture(scope="function")
def adapter(mock_client, mock_http_client):
    """Create an x402HTTPAdapter with mocked dependencies.

    Uses MagicMock spec to create a valid adapter instance, then injects
    mock dependencies for isolated unit testing.
    """
    adapter = MagicMock(spec=x402HTTPAdapter)
    adapter._client = mock_client
    adapter._http_client = mock_http_client
    adapter.send = x402HTTPAdapter.send.__get__(adapter, x402HTTPAdapter)
    adapter.RETRY_HEADER = x402HTTPAdapter.RETRY_HEADER
    adapter.RECOVERY_HEADER = x402HTTPAdapter.RECOVERY_HEADER
    return adapter


def _create_response(status_code: int, content: bytes = b"") -> requests.Response:
    """Create a mock Response object."""
    response = requests.Response()
    response.status_code = status_code
    response._content = content
    response.headers = {}
    return response


def _create_request(url: str = "https://example.com") -> requests.PreparedRequest:
    """Create a PreparedRequest object."""
    request = requests.PreparedRequest()
    request.prepare("GET", url)
    return request


class TestRetryHeaderConstant:
    """Test the RETRY_HEADER class constant."""

    def test_should_have_retry_header_constant(self):
        """Should have RETRY_HEADER constant defined."""
        assert hasattr(x402HTTPAdapter, "RETRY_HEADER")
        assert x402HTTPAdapter.RETRY_HEADER == "Payment-Retry"


class TestConsecutivePayments:
    """Test consecutive payment requests."""

    def test_should_set_retry_header_on_retry_request(self, adapter):
        """Should set retry header on the retry request."""
        captured_requests = []

        def mock_send(request, **_kwargs):
            captured_requests.append(request)
            is_retry = request.headers.get(x402HTTPAdapter.RETRY_HEADER) == "1"
            if is_retry:
                return _create_response(200, b'{"success": true}')
            return _create_response(402, b"{}")

        with patch("requests.adapters.HTTPAdapter.send", side_effect=mock_send):
            adapter.send(_create_request())

            assert x402HTTPAdapter.RETRY_HEADER not in captured_requests[0].headers
            assert captured_requests[1].headers.get(x402HTTPAdapter.RETRY_HEADER) == "1"

    def test_should_not_modify_original_request(self, adapter):
        """Should not modify original request during retry."""

        def mock_send(request, **_kwargs):
            is_retry = request.headers.get(x402HTTPAdapter.RETRY_HEADER) == "1"
            if is_retry:
                return _create_response(200, b'{"success": true}')
            return _create_response(402, b"{}")

        with patch("requests.adapters.HTTPAdapter.send", side_effect=mock_send):
            original_request = _create_request()
            adapter.send(original_request)

            assert x402HTTPAdapter.RETRY_HEADER not in original_request.headers
            assert "X-Payment" not in original_request.headers

    def test_should_handle_mixed_200_and_402_requests(self, adapter):
        """Should handle alternating free (200) and paid (402) requests."""
        call_sequence = []

        def mock_send(request, **_kwargs):
            url = request.url
            is_retry = request.headers.get(x402HTTPAdapter.RETRY_HEADER) == "1"
            call_sequence.append((url, is_retry))

            if "/free" in url:
                return _create_response(200, b'{"free": true}')
            elif is_retry:
                return _create_response(200, b'{"paid": true}')
            return _create_response(402, b"{}")

        with patch("requests.adapters.HTTPAdapter.send", side_effect=mock_send):
            urls = [
                "https://example.com/free",
                "https://example.com/paid1",
                "https://example.com/free",
                "https://example.com/paid2",
            ]
            for url in urls:
                response = adapter.send(_create_request(url))
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


class TestBasicFunctionalityWithFixtures:
    """Test basic adapter functionality using fixtures."""

    @pytest.mark.parametrize(
        ("status_code", "content"),
        [
            (200, b"success"),
            (404, b"not found"),
            (500, b"server error"),
            (301, b"redirect"),
        ],
    )
    def test_should_return_non_402_response_directly(self, adapter, status_code, content):
        """Should return non-402 responses without payment handling."""
        mock_response = _create_response(status_code, content)

        with patch("requests.adapters.HTTPAdapter.send", return_value=mock_response):
            response = adapter.send(_create_request())

            assert response.status_code == status_code
            assert response.content == content
            assert adapter._client.create_payment_payload_call_count == 0

    def test_should_return_402_directly_when_retry_header_present(self, adapter):
        """Should return 402 directly when retry header is present.

        This prevents infinite retry loops when payment is rejected.
        """
        mock_response = _create_response(402, b"payment rejected")

        with patch("requests.adapters.HTTPAdapter.send", return_value=mock_response):
            request = _create_request()
            request.headers[x402HTTPAdapter.RETRY_HEADER] = "1"

            response = adapter.send(request)

            assert response.status_code == 402
            assert adapter._client.create_payment_payload_call_count == 0


class TestErrorHandlingWithFixtures:
    """Test error handling in the adapter using fixtures."""

    def test_should_raise_payment_error_on_client_error(self, adapter):
        """Should raise PaymentError when client fails."""
        adapter._client.create_payment_payload = MagicMock(side_effect=Exception("Client error"))
        mock_402 = _create_response(402, b"{}")

        with patch("requests.adapters.HTTPAdapter.send", return_value=mock_402):
            with pytest.raises(PaymentError, match="Failed to handle payment"):
                adapter.send(_create_request())

    def test_should_propagate_payment_error(self, adapter):
        """Should propagate PaymentError from client."""
        adapter._client.create_payment_payload = MagicMock(
            side_effect=PaymentError("Custom payment error")
        )
        mock_402 = _create_response(402, b"{}")

        with patch("requests.adapters.HTTPAdapter.send", return_value=mock_402):
            with pytest.raises(PaymentError, match="Custom payment error"):
                adapter.send(_create_request())


class TestFactoryFunctionsWithPatch:
    """Test factory functions for creating adapters and sessions."""

    def test_x402_http_adapter_should_create_adapter(self):
        """Should create x402HTTPAdapter instance."""
        mock_client = MagicMock()

        with patch.object(x402HTTPAdapter, "__init__", return_value=None):
            adapter = x402_http_adapter(mock_client)
            assert isinstance(adapter, x402HTTPAdapter)

    def test_x402_requests_should_create_session_with_adapters(self):
        """Should create session with HTTP and HTTPS adapters mounted."""
        mock_client = MagicMock()

        with patch.object(x402HTTPAdapter, "__init__", return_value=None):
            session = x402_requests(mock_client)

            assert isinstance(session, requests.Session)
            assert "http://" in session.adapters
            assert "https://" in session.adapters

    def test_wrap_requests_with_payment_should_mount_adapters(self):
        """Should mount adapters on existing session."""
        mock_client = MagicMock()
        session = requests.Session()

        with patch.object(x402HTTPAdapter, "__init__", return_value=None):
            wrapped = wrapRequestsWithPayment(session, mock_client)

            assert wrapped is session
            assert "http://" in wrapped.adapters
            assert "https://" in wrapped.adapters
