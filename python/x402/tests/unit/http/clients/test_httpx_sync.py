"""Unit tests for x402SyncTransport (httpx.Client)."""

import gzip
import json

import pytest

pytest.importorskip("httpx")
import httpx

from x402.http.clients import x402SyncTransport as lazy_sync_transport
from x402.http.clients.httpx import PaymentError, x402SyncTransport
from x402.http.utils import (
    MAX_CONTROL_PLANE_RESPONSE_BYTES,
    ResponseBodyTooLargeError,
    encode_payment_required_header,
    encode_payment_response_header,
)
from x402.http.x402_http_client import x402HTTPClientSync
from x402.schemas import PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse
from x402.schemas.hooks import PaymentRequiredHeadersResult, RecoveredResponseResult


def make_payment_requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x0000000000000000000000000000000000000000",
        amount="1000000",
        pay_to="0x1234567890123456789012345678901234567890",
        max_timeout_seconds=300,
    )


def make_v2_payload(signature: str = "0xmock") -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        payload={"signature": signature},
        accepted=make_payment_requirements(),
    )


ENCODED_REQUIRED = encode_payment_required_header(
    PaymentRequired(x402_version=2, accepts=[make_payment_requirements()])
)


class MockX402ClientSync:
    def __init__(self) -> None:
        self.create_calls: list = []

    def create_payment_payload(self, payment_required):
        self.create_calls.append(payment_required)
        return make_v2_payload(f"0xsig{len(self.create_calls)}")

    def get_extensions(self):
        return []

    def handle_payment_response(self, ctx):
        return None


class MockRecoveringClientSync(MockX402ClientSync):
    def handle_payment_response(self, ctx):
        return RecoveredResponseResult()


class MockX402ClientAsync:
    async def create_payment_payload(self, payment_required):
        return None


def payment_required_response() -> httpx.Response:
    return httpx.Response(402, headers={"PAYMENT-REQUIRED": ENCODED_REQUIRED}, json={})


class Server(httpx.BaseTransport):
    """Records requests and returns the queued responses in order.

    Unlike httpx.MockTransport, this does not buffer the request body first.
    """

    def __init__(self, *responses: httpx.Response) -> None:
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []
        self.bodies: list[bytes] = []

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        # Consume the stream like a real transport would, without caching it.
        self.bodies.append(b"".join(request.stream))
        return self.responses.pop(0)


def make_http(client, server: Server) -> httpx.Client:
    return httpx.Client(transport=x402SyncTransport(client, server))


class TestX402SyncTransport:
    def test_lazy_export(self):
        assert lazy_sync_transport is x402SyncTransport

    def test_accepts_http_client(self):
        http_client = x402HTTPClientSync(MockX402ClientSync())
        assert x402SyncTransport(http_client)._http_client is http_client

    def test_rejects_async_client(self):
        with pytest.raises(TypeError, match="requires a sync client"):
            x402SyncTransport(MockX402ClientAsync())

    def test_non_402_passes_through(self):
        client = MockX402ClientSync()
        server = Server(httpx.Response(200, text="free"))

        with make_http(client, server) as http:
            response = http.get("https://example.com/free")

        assert response.text == "free"
        assert len(server.requests) == 1
        assert client.create_calls == []

    def test_pays_and_replays_request(self):
        client = MockX402ClientSync()
        server = Server(payment_required_response(), httpx.Response(200, text="paid"))

        with make_http(client, server) as http:
            response = http.post(
                "https://example.com/paid?q=1",
                headers={"X-Custom": "kept"},
                content=b"request-body",
            )

        assert response.status_code == 200
        assert response.text == "paid"
        assert len(client.create_calls) == 1
        initial, paid = server.requests
        assert "PAYMENT-SIGNATURE" not in initial.headers
        assert paid.headers["PAYMENT-SIGNATURE"]
        assert paid.method == "POST"
        assert str(paid.url) == "https://example.com/paid?q=1"
        assert paid.headers["X-Custom"] == "kept"
        assert server.bodies == [b"request-body", b"request-body"]

    def test_streaming_body_is_replayed(self):
        server = Server(payment_required_response(), httpx.Response(200))

        def body():
            yield b"chunk-1,"
            yield b"chunk-2"

        with make_http(MockX402ClientSync(), server) as http:
            http.post("https://example.com/paid", content=body())

        assert server.bodies == [b"chunk-1,chunk-2", b"chunk-1,chunk-2"]
        initial, paid = server.requests
        assert initial.headers["Transfer-Encoding"] == "chunked"
        assert "Transfer-Encoding" not in paid.headers
        assert paid.headers["Content-Length"] == str(len(b"chunk-1,chunk-2"))

    def test_rejected_payment_is_returned_without_another_attempt(self):
        client = MockX402ClientSync()
        server = Server(
            payment_required_response(),
            httpx.Response(
                402,
                headers={"PAYMENT-REQUIRED": ENCODED_REQUIRED},
                json={"error": "insufficient_funds"},
            ),
        )

        with make_http(client, server) as http:
            response = http.get("https://example.com/paid")

        assert response.status_code == 402
        assert response.json() == {"error": "insufficient_funds"}
        assert len(server.requests) == 2
        assert len(client.create_calls) == 1

    def test_marked_retry_request_is_not_paid_again(self):
        client = MockX402ClientSync()
        server = Server(payment_required_response())
        transport = x402SyncTransport(client, server)
        request = httpx.Request(
            "GET", "https://example.com/paid", extensions={x402SyncTransport.RETRY_KEY: True}
        )

        response = transport.handle_request(request)

        assert response.status_code == 402
        assert client.create_calls == []

    def test_consecutive_requests_each_pay(self):
        client = MockX402ClientSync()
        server = Server(
            payment_required_response(),
            httpx.Response(200),
            payment_required_response(),
            httpx.Response(200),
        )

        with make_http(client, server) as http:
            assert http.get("https://example.com/a").status_code == 200
            assert http.get("https://example.com/b").status_code == 200

        assert len(client.create_calls) == 2

    def test_hook_headers_retry_bypasses_payment(self):
        client = MockX402ClientSync()
        http_client = x402HTTPClientSync(client)
        urls: list[str] = []

        def hook(ctx):
            urls.append(ctx.request_url)
            return PaymentRequiredHeadersResult(headers={"Authorization": "Bearer x"})

        http_client.on_payment_required(hook)
        server = Server(payment_required_response(), httpx.Response(200, text="authorized"))

        with make_http(http_client, server) as http:
            response = http.get("https://example.com/paid")

        assert response.text == "authorized"
        assert urls == ["https://example.com/paid"]
        assert server.requests[1].headers["Authorization"] == "Bearer x"
        assert client.create_calls == []

    def test_recovery_retries_with_fresh_payload(self):
        client = MockRecoveringClientSync()
        settle = SettleResponse(
            success=False, error_reason="failed", transaction="0x0", network="eip155:8453"
        )
        server = Server(
            payment_required_response(),
            httpx.Response(
                402, headers={"PAYMENT-RESPONSE": encode_payment_response_header(settle)}
            ),
            httpx.Response(200),
        )

        with make_http(client, server) as http:
            response = http.get("https://example.com/paid")

        assert response.status_code == 200
        assert len(client.create_calls) == 2
        signatures = [r.headers["PAYMENT-SIGNATURE"] for r in server.requests[1:]]
        assert signatures[0] != signatures[1]

    def test_recovery_closes_non_402_paid_response(self):
        settle = SettleResponse(
            success=False, error_reason="failed", transaction="0x0", network="eip155:8453"
        )
        closed: list[bool] = []

        class TrackedStream(httpx.SyncByteStream):
            def __iter__(self):
                yield b"error"

            def close(self):
                closed.append(True)

        failed = httpx.Response(
            500,
            headers={"PAYMENT-RESPONSE": encode_payment_response_header(settle)},
            stream=TrackedStream(),
        )
        server = Server(payment_required_response(), failed, httpx.Response(200))

        with make_http(MockRecoveringClientSync(), server) as http:
            assert http.get("https://example.com/paid").status_code == 200

        assert closed == [True]

    def test_returned_gzip_402_is_decoded(self):
        rejected = httpx.Response(
            402,
            headers={"PAYMENT-REQUIRED": ENCODED_REQUIRED, "Content-Encoding": "gzip"},
            content=gzip.compress(b'{"error": "rejected"}'),
        )
        server = Server(payment_required_response(), rejected)

        with make_http(MockX402ClientSync(), server) as http:
            response = http.get("https://example.com/paid")

        assert response.status_code == 402
        assert response.json() == {"error": "rejected"}

    def test_rejects_oversized_402(self):
        server = Server(
            httpx.Response(
                402,
                headers={"PAYMENT-REQUIRED": ENCODED_REQUIRED},
                content=b"x" * (MAX_CONTROL_PLANE_RESPONSE_BYTES + 1),
            )
        )

        with make_http(MockX402ClientSync(), server) as http:
            with pytest.raises(ResponseBodyTooLargeError):
                http.get("https://example.com/paid")

    def test_unparseable_402_raises_payment_error(self):
        server = Server(httpx.Response(402, text="not x402"))

        with make_http(MockX402ClientSync(), server) as http:
            with pytest.raises(PaymentError, match="Failed to handle payment"):
                http.get("https://example.com/paid")

    def test_v1_body_payment_required(self):
        client = MockX402ClientSync()
        v1_body = {
            "x402Version": 1,
            "error": "X-PAYMENT header is required",
            "accepts": [
                {
                    "scheme": "exact",
                    "network": "base-sepolia",
                    "maxAmountRequired": "1000",
                    "resource": "https://example.com/paid",
                    "description": "",
                    "mimeType": "application/json",
                    "payTo": "0x1234567890123456789012345678901234567890",
                    "maxTimeoutSeconds": 300,
                    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
                }
            ],
        }
        server = Server(
            httpx.Response(402, content=json.dumps(v1_body).encode()), httpx.Response(200)
        )

        with make_http(client, server) as http:
            assert http.get("https://example.com/paid").status_code == 200

        assert client.create_calls[0].x402_version == 1
