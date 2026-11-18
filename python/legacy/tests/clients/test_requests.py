import pytest
import json
import base64
from unittest.mock import MagicMock, patch
from requests import Response, PreparedRequest, Session
from eth_account import Account
from x402.clients.requests import (
    x402HTTPAdapter,
    x402_http_adapter,
    x402_requests,
)
from x402.clients.base import (
    PaymentError,
)
from x402.types import PaymentRequirements, x402PaymentRequiredResponse


@pytest.fixture
def account():
    return Account.create()


@pytest.fixture
def session(account):
    return x402_requests(account)


@pytest.fixture
def adapter(account):
    return x402_http_adapter(account)


@pytest.fixture
def payment_requirements():
    return PaymentRequirements(
        scheme="exact",
        network="base-sepolia",
        asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        pay_to="0x0000000000000000000000000000000000000000",
        max_amount_required="10000",
        resource="https://example.com",
        description="test",
        max_timeout_seconds=1000,
        mime_type="text/plain",
        output_schema=None,
        extra={
            "name": "USD Coin",
            "version": "2",
        },
    )


def test_request_success(session):
    # Test successful request (200)
    mock_response = Response()
    mock_response.status_code = 200
    mock_response._content = b"success"

    with patch.object(session, "send", return_value=mock_response) as mock_send:
        response = session.request("GET", "https://example.com")
        assert response.status_code == 200
        assert response.content == b"success"
        mock_send.assert_called_once()


def test_request_non_402(session):
    # Test non-402 response
    mock_response = Response()
    mock_response.status_code = 404
    mock_response._content = b"not found"

    with patch.object(session, "send", return_value=mock_response) as mock_send:
        response = session.request("GET", "https://example.com")
        assert response.status_code == 404
        assert response.content == b"not found"
        mock_send.assert_called_once()


def test_adapter_send_success(adapter):
    # Test adapter with successful response
    mock_response = Response()
    mock_response.status_code = 200
    mock_response._content = b"success"

    # Create a prepared request
    request = PreparedRequest()
    request.prepare("GET", "https://example.com")

    with patch("requests.adapters.HTTPAdapter.send", return_value=mock_response):
        response = adapter.send(request)
        assert response.status_code == 200
        assert response.content == b"success"


def test_adapter_send_non_402(adapter):
    # Test adapter with non-402 response
    mock_response = Response()
    mock_response.status_code = 404
    mock_response._content = b"not found"

    # Create a prepared request
    request = PreparedRequest()
    request.prepare("GET", "https://example.com")

    with patch("requests.adapters.HTTPAdapter.send", return_value=mock_response):
        response = adapter.send(request)
        assert response.status_code == 404
        assert response.content == b"not found"


def test_adapter_retry(adapter):
    # Test retry handling in adapter
    mock_response = Response()
    mock_response.status_code = 402
    mock_response._content = b"payment required"

    # Create a prepared request
    request = PreparedRequest()
    request.prepare("GET", "https://example.com")

    # Set retry flag to true
    adapter._is_retry = True

    with patch("requests.adapters.HTTPAdapter.send", return_value=mock_response):
        response = adapter.send(request)
        assert response.status_code == 402
        assert response.content == b"payment required"
        # Verify retry flag is reset after call
        assert not adapter._is_retry


def test_adapter_payment_flow(adapter, payment_requirements):
    # Mock the payment required response
    payment_response = x402PaymentRequiredResponse(
        x402_version=1,
        accepts=[payment_requirements],
        error="Payment Required",
    )

    # Create initial 402 response
    initial_response = Response()
    initial_response.status_code = 402
    initial_response._content = json.dumps(
        payment_response.model_dump(by_alias=True)
    ).encode()

    # Mock the retry response with payment response header
    payment_result = {
        "success": True,
        "transaction": "0x1234",
        "network": "base-sepolia",
        "payer": "0x5678",
    }
    retry_response = Response()
    retry_response.status_code = 200
    retry_response.headers = {
        "X-Payment-Response": base64.b64encode(
            json.dumps(payment_result).encode()
        ).decode()
    }
    retry_response._content = b"success"

    # Create a prepared request
    request = PreparedRequest()
    request.prepare("GET", "https://example.com")
    request.headers = {}

    # Mock client methods
    adapter.client.select_payment_requirements = MagicMock(
        return_value=payment_requirements
    )
    mock_header = "mock_payment_header"
    adapter.client.create_payment_header = MagicMock(return_value=mock_header)

    # Mock the send method to return different responses
    def mock_send_impl(req, **kwargs):
        if adapter._is_retry:
            return retry_response
        return initial_response

    with patch(
        "requests.adapters.HTTPAdapter.send", side_effect=mock_send_impl
    ) as mock_send:
        response = adapter.send(request)

        # Verify the result
        assert response.status_code == 200
        assert "X-Payment-Response" in response.headers

        # Verify the mocked methods were called with correct arguments
        adapter.client.select_payment_requirements.assert_called_once_with(
            [payment_requirements]
        )
        adapter.client.create_payment_header.assert_called_once_with(
            payment_requirements, 1
        )

        # Verify the retry request was made with correct headers
        assert mock_send.call_count == 2
        retry_call = mock_send.call_args_list[1]
        retry_request = retry_call[0][0]
        assert retry_request.headers["X-Payment"] == mock_header
        assert (
            retry_request.headers["Access-Control-Expose-Headers"]
            == "X-Payment-Response"
        )


def test_adapter_payment_error(adapter, payment_requirements):
    # Mock the payment required response with unsupported scheme
    payment_requirements.scheme = "unsupported"
    payment_response = x402PaymentRequiredResponse(
        x402_version=1,
        accepts=[payment_requirements],
        error="Payment Required",
    )

    # Create initial 402 response
    initial_response = Response()
    initial_response.status_code = 402
    initial_response._content = json.dumps(
        payment_response.model_dump(by_alias=True)
    ).encode()

    # Create a prepared request
    request = PreparedRequest()
    request.prepare("GET", "https://example.com")

    with patch("requests.adapters.HTTPAdapter.send", return_value=initial_response):
        with pytest.raises(PaymentError):
            adapter.send(request)

        # Verify retry flag is reset
        assert not adapter._is_retry


def test_adapter_general_error(adapter):
    # Create initial 402 response with invalid JSON
    initial_response = Response()
    initial_response.status_code = 402
    initial_response._content = b"invalid json"

    # Create a prepared request
    request = PreparedRequest()
    request.prepare("GET", "https://example.com")

    with patch("requests.adapters.HTTPAdapter.send", return_value=initial_response):
        with pytest.raises(PaymentError):
            adapter.send(request)

        # Verify retry flag is reset
        assert not adapter._is_retry


def test_x402_http_adapter(account):
    # Test basic adapter creation
    adapter = x402_http_adapter(account)
    assert isinstance(adapter, x402HTTPAdapter)
    assert adapter.client.account == account
    assert adapter.client.max_value is None

    # Test with max_value
    adapter = x402_http_adapter(account, max_value=1000)
    assert adapter.client.max_value == 1000

    # Test with custom selector
    def custom_selector(accepts, network_filter=None, scheme_filter=None):
        return accepts[0]

    adapter = x402_http_adapter(account, payment_requirements_selector=custom_selector)
    assert (
        adapter.client.select_payment_requirements
        != adapter.client.__class__.select_payment_requirements
    )

    # Test passing adapter kwargs
    adapter = x402_http_adapter(account, pool_connections=10, pool_maxsize=100)
    # Note: HTTPAdapter doesn't expose these properties, so we can't directly assert them


def test_x402_requests(account):
    # Test session creation
    session = x402_requests(account)
    assert isinstance(session, Session)

    # Check http adapter mounting
    adapter = session.adapters.get("http://")
    assert isinstance(adapter, x402HTTPAdapter)
    assert adapter.client.account == account

    # Check https adapter mounting
    adapter = session.adapters.get("https://")
    assert isinstance(adapter, x402HTTPAdapter)
    assert adapter.client.account == account

    # Test with max_value
    session = x402_requests(account, max_value=1000)
    adapter = session.adapters.get("http://")
    assert adapter.client.max_value == 1000

    # Test with custom selector
    def custom_selector(accepts, network_filter=None, scheme_filter=None):
        return accepts[0]

    session = x402_requests(account, payment_requirements_selector=custom_selector)
    adapter = session.adapters.get("http://")
    assert (
        adapter.client.select_payment_requirements
        != adapter.client.__class__.select_payment_requirements
    )
