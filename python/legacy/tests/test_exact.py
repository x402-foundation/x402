import pytest
import time
import base64
from eth_account import Account
from hexbytes import HexBytes
from x402.exact import (
    create_nonce,
    prepare_payment_header,
    sign_payment_header,
    encode_payment,
    decode_payment,
)
from x402.types import PaymentRequirements


@pytest.fixture
def account():
    return Account.create()


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


def test_create_nonce():
    nonce1 = create_nonce()
    nonce2 = create_nonce()

    # Test nonce length (32 bytes)
    assert len(nonce1) == 32
    assert isinstance(nonce1, bytes)

    # Test nonces are random
    assert nonce1 != nonce2


def test_prepare_payment_header(account, payment_requirements):
    header = prepare_payment_header(account.address, 1, payment_requirements)

    # Test header structure
    assert header["x402Version"] == 1
    assert header["scheme"] == payment_requirements.scheme
    assert header["network"] == payment_requirements.network
    assert "payload" in header
    assert "authorization" in header["payload"]
    assert "signature" in header["payload"]
    assert header["payload"]["signature"] is None

    # Test authorization fields
    auth = header["payload"]["authorization"]
    assert auth["from"] == account.address
    assert auth["to"] == payment_requirements.pay_to
    assert auth["value"] == payment_requirements.max_amount_required
    assert isinstance(auth["nonce"], bytes)
    assert len(auth["nonce"]) == 32


def test_sign_payment_header(account, payment_requirements):
    unsigned_header = prepare_payment_header(account.address, 1, payment_requirements)

    # Convert nonce to hex string for signing
    nonce = unsigned_header["payload"]["authorization"]["nonce"]
    unsigned_header["payload"]["authorization"]["nonce"] = nonce.hex()

    signed_message = sign_payment_header(account, payment_requirements, unsigned_header)

    # Test signature properties
    assert isinstance(signed_message, str)
    assert len(signed_message) > 0

    # Test decoded structure
    decoded = decode_payment(signed_message)
    assert "x402Version" in decoded
    assert "scheme" in decoded
    assert "network" in decoded
    assert "payload" in decoded
    assert "signature" in decoded["payload"]
    assert "authorization" in decoded["payload"]
    assert decoded["payload"]["signature"].startswith("0x")
    assert decoded["payload"]["authorization"]["nonce"].startswith("0x")

    # Test domain data
    auth = decoded["payload"]["authorization"]
    assert auth["from"] == account.address
    assert auth["to"] == payment_requirements.pay_to
    assert auth["value"] == payment_requirements.max_amount_required
    assert int(auth["validAfter"]) < int(time.time())
    assert int(auth["validBefore"]) > int(time.time())


def test_sign_payment_header_no_account(payment_requirements):
    unsigned_header = prepare_payment_header(
        "0x0000000000000000000000000000000000000000", 1, payment_requirements
    )

    # Convert nonce to hex string for signing
    nonce = unsigned_header["payload"]["authorization"]["nonce"]
    unsigned_header["payload"]["authorization"]["nonce"] = nonce.hex()

    with pytest.raises(Exception):
        sign_payment_header(None, payment_requirements, unsigned_header)


def test_encode_payment():
    # Test basic encoding
    data = {"test": "value"}
    encoded = encode_payment(data)
    assert isinstance(encoded, str)
    assert len(encoded) > 0
    decoded = decode_payment(encoded)
    assert decoded == data

    # Test HexBytes handling
    hex_bytes = HexBytes("0x1234")
    data = {"test": hex_bytes}
    encoded = encode_payment(data)
    decoded = decode_payment(encoded)
    assert decoded["test"] == "1234"  # Implementation returns hex without 0x prefix

    # Test object with to_dict
    class TestObject:
        def to_dict(self):
            return {"test": "value"}

    data = {"test": TestObject()}
    encoded = encode_payment(data)
    decoded = decode_payment(encoded)
    assert decoded["test"] == {"test": "value"}

    # Test object with hex
    class HexObject:
        def hex(self):
            return "0x1234"

    data = {"test": HexObject()}
    encoded = encode_payment(data)
    decoded = decode_payment(encoded)
    assert decoded["test"] == "0x1234"

    # Test non-serializable object
    class NonSerializable:
        pass

    data = {"test": NonSerializable()}
    with pytest.raises(TypeError):
        encode_payment(data)


def test_decode_payment():
    # Test basic decoding
    data = {"test": "value"}
    encoded = encode_payment(data)
    decoded = decode_payment(encoded)
    assert decoded == data

    # Test invalid base64
    with pytest.raises(Exception):
        decode_payment("invalid base64!")

    # Test invalid JSON
    with pytest.raises(Exception):
        decode_payment(base64.b64encode(b"invalid json").decode())

    # Test round-trip encoding/decoding
    complex_data = {
        "string": "test",
        "number": 123,
        "boolean": True,
        "null": None,
        "array": [1, 2, 3],
        "object": {"nested": "value"},
        "hex": HexBytes("0x1234"),
    }
    encoded = encode_payment(complex_data)
    decoded = decode_payment(encoded)
    assert decoded["string"] == complex_data["string"]
    assert decoded["number"] == complex_data["number"]
    assert decoded["boolean"] == complex_data["boolean"]
    assert decoded["null"] is None
    assert decoded["array"] == complex_data["array"]
    assert decoded["object"] == complex_data["object"]
    assert decoded["hex"] == "1234"  # Implementation returns hex without 0x prefix
