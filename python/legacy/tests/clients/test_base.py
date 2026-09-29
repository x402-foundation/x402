import pytest
import json
import base64
from eth_account import Account
from x402.clients.base import (
    x402Client,
    PaymentAmountExceededError,
    UnsupportedSchemeException,
    decode_x_payment_response,
)
from x402.types import PaymentRequirements
from x402.exact import decode_payment


@pytest.fixture
def account():
    return Account.create()


@pytest.fixture
def client(account):
    return x402Client(account)


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


def test_decode_x_payment_response():
    # Test valid response
    response = {
        "success": True,
        "transaction": "0x1234",
        "network": "base-sepolia",
        "payer": "0x5678",
    }
    encoded = base64.b64encode(json.dumps(response).encode()).decode()
    decoded = decode_x_payment_response(encoded)
    assert decoded == response

    # Test invalid base64
    with pytest.raises(Exception):
        decode_x_payment_response("invalid base64!")

    # Test invalid JSON
    with pytest.raises(Exception):
        decode_x_payment_response(base64.b64encode(b"invalid json").decode())

    # Test missing fields
    response = {"success": True}  # Missing required fields
    encoded = base64.b64encode(json.dumps(response).encode()).decode()
    decoded = decode_x_payment_response(encoded)
    assert decoded == response  # Should still decode but with missing fields


def test_client_initialization(account):
    # Test basic initialization
    client = x402Client(account)
    assert client.account == account
    assert client.max_value is None

    # Test initialization with max_value
    client = x402Client(account, max_value=1000)
    assert client.max_value == 1000

    # Test initialization with custom selector
    def custom_selector(accepts, network_filter=None, scheme_filter=None):
        return accepts[0]  # Just return first requirement

    client = x402Client(account, payment_requirements_selector=custom_selector)
    assert client.select_payment_requirements != x402Client.select_payment_requirements


def test_generate_nonce(client):
    # Test nonce generation
    nonce = client.generate_nonce()

    # Test nonce is a string
    assert isinstance(nonce, str)

    # Test nonce length (32 bytes = 64 hex chars)
    assert len(nonce) == 64

    # Test nonce is hex
    assert all(c in "0123456789abcdef" for c in nonce)

    # Test nonces are random
    nonce2 = client.generate_nonce()
    assert nonce != nonce2


def test_select_payment_requirements(client, payment_requirements):
    # Test selecting from single requirement
    selected = client.select_payment_requirements([payment_requirements])
    assert selected == payment_requirements

    # Test selecting with network filter
    selected = client.select_payment_requirements(
        [payment_requirements], network_filter="base-sepolia"
    )
    assert selected == payment_requirements

    # Test selecting with scheme filter
    selected = client.select_payment_requirements(
        [payment_requirements], scheme_filter="exact"
    )
    assert selected == payment_requirements

    # Test no matching requirements
    with pytest.raises(UnsupportedSchemeException):
        client.select_payment_requirements(
            [payment_requirements], network_filter="ethereum"
        )


def test_select_payment_requirements_amount_exceeded(client, payment_requirements):
    # Set max_value lower than required amount
    client.max_value = 1000

    with pytest.raises(PaymentAmountExceededError):
        client.select_payment_requirements([payment_requirements])


def test_create_payment_header(client, payment_requirements):
    header = client.create_payment_header(payment_requirements, 1)

    # Test header is a non-empty string
    assert isinstance(header, str)
    assert len(header) > 0

    # Test header structure
    decoded = decode_payment(header)
    assert "x402Version" in decoded
    assert "scheme" in decoded
    assert "network" in decoded
    assert "payload" in decoded
    assert "authorization" in decoded["payload"]
    assert "signature" in decoded["payload"]


def test_payment_requirements_sorting(client):
    base_req = PaymentRequirements(
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

    other_req = PaymentRequirements(
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

    # Test both networks are equal
    selected = client.select_payment_requirements([other_req, base_req])
    assert selected.network == "base-sepolia"
