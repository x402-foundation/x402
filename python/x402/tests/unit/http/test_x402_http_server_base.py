"""Tests for x402HTTPServerBase._create_http_response.

Regression coverage for the JSON (non-browser) 402 response: the body must
carry the same challenge as the PAYMENT-REQUIRED header, not an empty object.
Body-reading clients (i.e. clients that parse the response body rather than
the header) otherwise fail closed on `{}`.
"""

from __future__ import annotations

import base64
import json
from unittest.mock import MagicMock

from x402.http.constants import PAYMENT_REQUIRED_HEADER
from x402.http.types import PaymentOption, RouteConfig
from x402.http.x402_http_server_base import x402HTTPServerBase
from x402.schemas import PaymentRequired, PaymentRequirements, ResourceInfo


def _make_payment_required() -> PaymentRequired:
    return PaymentRequired(
        x402_version=2,
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
                amount="1000000",
                pay_to="0x209693Bc6afc0C5328bA36FaF04C514EF312287C",
                max_timeout_seconds=60,
            )
        ],
        resource=ResourceInfo(url="https://example.com/api/data"),
        error="Payment required",
    )


def _make_server_base() -> x402HTTPServerBase:
    route_config = RouteConfig(
        accepts=PaymentOption(
            scheme="exact",
            pay_to="0x209693Bc6afc0C5328bA36FaF04C514EF312287C",
            price="$1.00",
            network="eip155:84532",
        )
    )
    return x402HTTPServerBase(server=MagicMock(), routes=route_config)


def _decode_header_payload(header_value: str) -> dict:
    return json.loads(base64.b64decode(header_value.encode("utf-8")).decode("utf-8"))


def test_json_402_body_mirrors_header_payload() -> None:
    """Non-browser 402 response body must deep-equal the decoded header payload."""
    server_base = _make_server_base()
    payment_required = _make_payment_required()

    response = server_base._create_http_response(
        payment_required,
        is_web_browser=False,
    )

    assert response.status == 402
    assert response.headers["Content-Type"] == "application/json"

    header_payload = _decode_header_payload(response.headers[PAYMENT_REQUIRED_HEADER])

    assert response.body != {}
    assert response.body == header_payload
    assert response.body["accepts"], "challenge body must include payment requirements"


def test_json_402_body_uses_same_serialization_flags_as_header() -> None:
    """Body must be produced with by_alias=True, exclude_none=True, mode='json'."""
    server_base = _make_server_base()
    payment_required = _make_payment_required()

    response = server_base._create_http_response(
        payment_required,
        is_web_browser=False,
    )

    expected_body = payment_required.model_dump(
        by_alias=True, exclude_none=True, mode="json"
    )
    assert response.body == expected_body


def test_route_level_unpaid_response_override_still_wins() -> None:
    """An explicit unpaid_response argument still overrides the default body."""
    from x402.http.types import HTTPResponseBody

    server_base = _make_server_base()
    payment_required = _make_payment_required()

    override = HTTPResponseBody(
        content_type="application/json", body={"custom": "challenge"}
    )
    response = server_base._create_http_response(
        payment_required,
        is_web_browser=False,
        unpaid_response=override,
    )

    assert response.body == {"custom": "challenge"}
