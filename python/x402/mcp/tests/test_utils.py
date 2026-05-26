"""Unit tests for MCP utility functions."""

import json

from x402.mcp.types import MCPToolResult
from x402.mcp.utils import (
    attach_payment_to_meta,
    create_tool_resource_url,
    extract_payment_from_meta,
    extract_payment_required_from_result,
    extract_payment_response_from_meta,
)
from x402.schemas import PaymentPayload, PaymentRequired, SettleResponse


def test_extract_payment_from_meta_no_meta():
    """Test extraction when _meta is missing."""
    params = {"name": "test"}
    result = extract_payment_from_meta(params)
    assert result is None


def test_extract_payment_from_meta_no_payment():
    """Test extraction when payment is not in _meta."""
    params = {"_meta": {}}
    result = extract_payment_from_meta(params)
    assert result is None


def test_extract_payment_from_meta_valid():
    """Test extraction of valid payment."""
    payload = PaymentPayload(
        x402_version=2,
        accepted={
            "scheme": "exact",
            "network": "eip155:84532",
            "amount": "1000",
            "asset": "USDC",
            "payTo": "0xrecipient",
            "maxTimeoutSeconds": 300,
        },
        payload={"signature": "0x123"},
    )
    params = {
        "_meta": {
            "x402/payment": (payload.model_dump() if hasattr(payload, "model_dump") else payload)
        }
    }
    result = extract_payment_from_meta(params)
    assert result is not None
    assert result.x402_version == 2


def test_attach_payment_to_meta():
    """Test attaching payment to params."""
    payload = PaymentPayload(
        x402_version=2,
        accepted={
            "scheme": "exact",
            "network": "eip155:84532",
            "amount": "1000",
            "asset": "USDC",
            "payTo": "0xrecipient",
            "maxTimeoutSeconds": 300,
        },
        payload={"signature": "0x123"},
    )
    params = {"name": "test", "arguments": {"city": "NYC"}}
    result = attach_payment_to_meta(params, payload)
    assert "_meta" in result
    assert "x402/payment" in result["_meta"]


def test_extract_payment_required_from_result_structured():
    """Test extraction from structuredContent."""
    payment_required = PaymentRequired(
        x402_version=2,
        accepts=[
            {
                "scheme": "exact",
                "network": "eip155:84532",
                "amount": "1000",
                "asset": "USDC",
                "payTo": "0xrecipient",
                "maxTimeoutSeconds": 300,
            }
        ],
    )
    structured_content = (
        payment_required.model_dump()
        if hasattr(payment_required, "model_dump")
        else payment_required
    )
    result = MCPToolResult(
        content=[],
        is_error=True,
        structured_content=structured_content,
    )
    extracted = extract_payment_required_from_result(result)
    assert extracted is not None
    assert extracted.x402_version == 2


def test_extract_payment_required_from_result_text():
    """Test extraction from content[0].text."""
    payment_required = PaymentRequired(
        x402_version=2,
        accepts=[
            {
                "scheme": "exact",
                "network": "eip155:84532",
                "amount": "1000",
                "asset": "USDC",
                "payTo": "0xrecipient",
                "maxTimeoutSeconds": 300,
            }
        ],
    )
    text = json.dumps(
        payment_required.model_dump()
        if hasattr(payment_required, "model_dump")
        else payment_required
    )
    result = MCPToolResult(
        content=[{"type": "text", "text": text}],
        is_error=True,
    )
    extracted = extract_payment_required_from_result(result)
    assert extracted is not None
    assert extracted.x402_version == 2


def test_is_object():
    """Test is_object type guard."""
    from x402.mcp import is_object

    assert is_object({"key": "value"}) is True
    assert is_object({}) is True
    assert is_object(None) is False
    assert is_object("string") is False
    assert is_object(42) is False
    assert is_object(True) is False


def test_create_payment_required_error():
    """Test create_payment_required_error helper."""
    from x402.mcp import create_payment_required_error
    from x402.schemas import PaymentRequired

    payment_required = PaymentRequired(
        x402_version=2,
        accepts=[
            {
                "scheme": "exact",
                "network": "eip155:84532",
                "amount": "1000",
                "asset": "USDC",
                "payTo": "0xrecipient",
                "maxTimeoutSeconds": 300,
            }
        ],
    )

    # Test default message
    error = create_payment_required_error(payment_required)
    assert error.code == 402
    assert str(error) == "Payment required" or (
        hasattr(error, "args") and len(error.args) > 0 and error.args[0] == "Payment required"
    )
    assert error.payment_required == payment_required

    # Test custom message
    error = create_payment_required_error(payment_required, "Custom error")
    assert str(error) == "Custom error" or (
        hasattr(error, "args") and len(error.args) > 0 and error.args[0] == "Custom error"
    )


def test_extract_payment_required_from_error():
    """Test extract_payment_required_from_error utility."""
    from x402.mcp import extract_payment_required_from_error

    # Test valid 402 error
    json_rpc_error = {
        "code": 402,
        "message": "Payment required",
        "data": {
            "x402Version": 2,
            "accepts": [
                {
                    "scheme": "exact",
                    "network": "eip155:84532",
                    "amount": "1000",
                    "asset": "USDC",
                    "payTo": "0xrecipient",
                    "maxTimeoutSeconds": 300,
                }
            ],
        },
    }

    pr = extract_payment_required_from_error(json_rpc_error)
    assert pr is not None
    assert pr.x402_version == 2

    # Test non-402 error
    non_402_error = {"code": 500, "message": "Server error"}
    pr = extract_payment_required_from_error(non_402_error)
    assert pr is None

    # Test nil error
    pr = extract_payment_required_from_error(None)
    assert pr is None

    # Test non-object error
    pr = extract_payment_required_from_error("not an object")
    assert pr is None


def test_create_tool_resource_url():
    """Test resource URL creation."""
    assert create_tool_resource_url("get_weather") == "mcp://tool/get_weather"
    assert (
        create_tool_resource_url("get_weather", "https://api.example.com/weather")
        == "https://api.example.com/weather"
    )


def test_extract_payment_response_from_meta_no_meta():
    """Test extraction when meta is missing."""

    result = MCPToolResult(content=[], is_error=False, meta=None)
    response = extract_payment_response_from_meta(result)
    assert response is None


def test_extract_payment_response_from_meta_no_response():
    """Test extraction when payment response is not in meta."""

    result = MCPToolResult(content=[], is_error=False, meta={})
    response = extract_payment_response_from_meta(result)
    assert response is None


def test_extract_payment_response_from_meta_valid():
    """Test extraction of valid payment response."""

    settle_response = SettleResponse(
        success=True,
        transaction="0xtxhash123",
        network="eip155:84532",
    )

    result = MCPToolResult(
        content=[],
        is_error=False,
        meta={
            "x402/payment-response": (
                settle_response.model_dump()
                if hasattr(settle_response, "model_dump")
                else settle_response
            )
        },
    )

    response = extract_payment_response_from_meta(result)
    assert response is not None
    assert response.success is True
    assert response.transaction == "0xtxhash123"
    assert response.network == "eip155:84532"


def test_attach_payment_response_to_meta():
    """Test attaching payment response to result."""
    from x402.mcp.utils import (
        attach_payment_response_to_meta,
    )

    settle_response = SettleResponse(
        success=True,
        transaction="0xtxhash123",
        network="eip155:84532",
    )

    result = MCPToolResult(content=[{"type": "text", "text": "success"}], is_error=False, meta=None)

    updated = attach_payment_response_to_meta(result, settle_response)

    assert updated.meta is not None
    assert "x402/payment-response" in updated.meta

    # Verify it can be extracted back
    extracted = extract_payment_response_from_meta(updated)
    assert extracted is not None
    assert extracted.transaction == settle_response.transaction


def test_attach_payment_response_to_meta_existing_meta():
    """Test attaching payment response preserves existing meta."""
    from x402.mcp.utils import attach_payment_response_to_meta

    settle_response = SettleResponse(
        success=True,
        transaction="0xtxhash123",
        network="eip155:84532",
    )

    result = MCPToolResult(
        content=[],
        is_error=False,
        meta={"other_key": "other_value"},
    )

    updated = attach_payment_response_to_meta(result, settle_response)

    assert updated.meta["other_key"] == "other_value"
    assert "x402/payment-response" in updated.meta


def test_attach_payment_response_to_meta_does_not_mutate_original():
    """Test that attach_payment_response_to_meta does not mutate the original result."""
    from x402.mcp.utils import attach_payment_response_to_meta

    settle_response = SettleResponse(
        success=True,
        transaction="0xtxhash123",
        network="eip155:84532",
    )

    original = MCPToolResult(
        content=[{"type": "text", "text": "hello"}],
        is_error=False,
        meta={"existing": "value"},
    )

    updated = attach_payment_response_to_meta(original, settle_response)

    # Original should not be mutated
    assert "x402/payment-response" not in original.meta
    assert original.meta == {"existing": "value"}

    # Updated should have the response
    assert "x402/payment-response" in updated.meta
    assert updated.meta["existing"] == "value"


def test_extract_payment_from_meta_json_string():
    """Test extraction of payment from JSON string format in _meta."""
    payload = PaymentPayload(
        x402_version=2,
        accepted={
            "scheme": "exact",
            "network": "eip155:84532",
            "amount": "1000",
            "asset": "USDC",
            "payTo": "0xrecipient",
            "maxTimeoutSeconds": 300,
        },
        payload={"signature": "0x123"},
    )
    payload_json = json.dumps(payload.model_dump() if hasattr(payload, "model_dump") else payload)
    params = {
        "_meta": {
            "x402/payment": payload_json,
        }
    }
    result = extract_payment_from_meta(params)
    assert result is not None
    assert result.x402_version == 2


def test_is_payment_required_error():
    """Test is_payment_required_error type guard."""
    from x402.mcp.types import PaymentRequiredError
    from x402.mcp.utils import is_payment_required_error

    pr_error = PaymentRequiredError("test", payment_required=None)
    assert is_payment_required_error(pr_error) is True

    generic_error = ValueError("not a payment error")
    assert is_payment_required_error(generic_error) is False


# ============================================================================
# convert_mcp_result tests
# ============================================================================


def test_convert_mcp_result():
    """Test that convert_mcp_result extracts attributes correctly."""
    from x402.mcp.utils import convert_mcp_result

    class FakeResult:
        content = [{"type": "text", "text": "hello"}]
        isError = False
        _meta = {"key": "val"}
        structuredContent = {"x": 1}

    result = convert_mcp_result(FakeResult())
    assert result.content == [{"type": "text", "text": "hello"}]
    assert result.is_error is False
    assert result.meta == {"key": "val"}
    assert result.structured_content == {"x": 1}


def test_convert_mcp_result_missing_attrs():
    """Test convert_mcp_result with missing attributes defaults gracefully."""
    from x402.mcp.utils import convert_mcp_result

    class EmptyResult:
        pass

    result = convert_mcp_result(EmptyResult())
    assert result.content == []
    assert result.is_error is False
    assert result.meta == {}
    assert result.structured_content is None
