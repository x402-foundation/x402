"""Unit tests for the payment Access-Control-Expose-Headers helpers."""

from unittest.mock import MagicMock

import pytest

from x402.http.types import RouteConfig
from x402.http.x402_http_server_base import (
    apply_payment_response_headers,
    with_payment_cors_expose_headers,
    x402HTTPServerBase,
)
from x402.schemas import PaymentRequired, ResourceInfo, SettleResponse

EXPOSE = "Access-Control-Expose-Headers"


class TestWithPaymentCorsExposeHeaders:
    def test_adds_both_payment_headers(self):
        headers = with_payment_cors_expose_headers({"PAYMENT-REQUIRED": "encoded"})
        assert headers == {
            "PAYMENT-REQUIRED": "encoded",
            EXPOSE: "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
        }

    @pytest.mark.parametrize(
        ("existing", "expected"),
        [
            ("X-Request-Id, X-Trace", "X-Request-Id, X-Trace, PAYMENT-REQUIRED, PAYMENT-RESPONSE"),
            (
                ["X-Request-Id", "X-Trace"],
                "X-Request-Id, X-Trace, PAYMENT-REQUIRED, PAYMENT-RESPONSE",
            ),
            (
                ["payment-required, X-Trace", "x-trace, Payment-Response"],
                "payment-required, X-Trace, Payment-Response",
            ),
            ([" , X-Trace ,,", ""], "X-Trace, PAYMENT-REQUIRED, PAYMENT-RESPONSE"),
        ],
        ids=["string", "multiple-values", "case-insensitive-dedup", "empty-entries"],
    )
    def test_merges_existing_list(self, existing, expected):
        headers = with_payment_cors_expose_headers({"PAYMENT-RESPONSE": "receipt"}, existing)
        assert headers[EXPOSE] == expected

    def test_reuses_existing_key_spelling(self):
        headers = with_payment_cors_expose_headers(
            {"PAYMENT-RESPONSE": "receipt", "access-control-expose-headers": "X-Custom"}
        )
        assert headers == {
            "PAYMENT-RESPONSE": "receipt",
            "access-control-expose-headers": "X-Custom, PAYMENT-REQUIRED, PAYMENT-RESPONSE",
        }

    def test_leaves_headers_without_payment_header_unchanged(self):
        assert with_payment_cors_expose_headers({"Cache-Control": "private"}, "X-Trace") == {
            "Cache-Control": "private"
        }

    def test_never_sets_allow_origin(self):
        headers = with_payment_cors_expose_headers({"PAYMENT-REQUIRED": "encoded"}, "X-Trace")
        assert not any(key.lower() == "access-control-allow-origin" for key in headers)


class TestApplyPaymentResponseHeaders:
    def test_merges_every_existing_value_and_keeps_allow_origin(self):
        written = {
            "Access-Control-Allow-Origin": ["https://app.example"],
            EXPOSE: ["X-Request-Id, payment-required", "X-Trace"],
        }

        def set_header(name, value):
            written[name] = [value]

        apply_payment_response_headers(
            {"PAYMENT-RESPONSE": "receipt", EXPOSE: "PAYMENT-REQUIRED, PAYMENT-RESPONSE"},
            lambda name: written.get(name, []),
            set_header,
        )

        assert written == {
            "Access-Control-Allow-Origin": ["https://app.example"],
            EXPOSE: ["X-Request-Id, payment-required, X-Trace, PAYMENT-RESPONSE"],
            "PAYMENT-RESPONSE": ["receipt"],
        }


class TestServerHeaderBuilders:
    @staticmethod
    def _server() -> x402HTTPServerBase:
        return x402HTTPServerBase(MagicMock(), {"*": RouteConfig(accepts=[])})

    @pytest.mark.parametrize("is_web_browser", [False, True], ids=["api", "browser"])
    def test_402_exposes_payment_headers(self, is_web_browser):
        payment_required = PaymentRequired(
            x402_version=2,
            accepts=[],
            resource=ResourceInfo(url="https://example.com", description="", mime_type=""),
        )
        response = self._server()._create_http_response(
            payment_required, is_web_browser=is_web_browser
        )
        assert response.headers[EXPOSE] == "PAYMENT-REQUIRED, PAYMENT-RESPONSE"
        assert "Access-Control-Allow-Origin" not in response.headers

    def test_settlement_headers_expose_payment_headers(self):
        settle = SettleResponse(success=True, transaction="0xtx", network="eip155:8453")
        headers = self._server()._create_settlement_headers(settle, MagicMock())
        assert headers["PAYMENT-RESPONSE"]
        assert headers[EXPOSE] == "PAYMENT-REQUIRED, PAYMENT-RESPONSE"
        assert "Access-Control-Allow-Origin" not in headers
