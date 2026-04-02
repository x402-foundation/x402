"""Unit tests for x402.http.facilitator_server."""

from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from x402.facilitator import x402Facilitator, x402FacilitatorSync
from x402.http.facilitator_server import create_facilitator_app
from x402.interfaces import FacilitatorContext
from x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    SupportedResponse,
    VerifyResponse,
)

# ============================================================================
# Mock Scheme Facilitator
# ============================================================================


class MockExactScheme:
    """Mock facilitator scheme for testing."""

    scheme = "exact"
    caip_family = "eip155:*"

    def get_extra(self, network: str) -> dict | None:
        return None

    def get_signers(self, network: str) -> list[str]:
        return ["0xfacilitator"]

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context: FacilitatorContext | None = None,
    ) -> VerifyResponse:
        sig = payload.payload.get("signature", "")
        if sig == "valid":
            return VerifyResponse(is_valid=True, payer="0xpayer")
        return VerifyResponse(
            is_valid=False,
            invalid_reason="bad_signature",
            invalid_message="Invalid signature provided",
        )

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context: FacilitatorContext | None = None,
    ) -> SettleResponse:
        sig = payload.payload.get("signature", "")
        if sig == "valid":
            return SettleResponse(
                success=True,
                transaction="0xtxhash",
                network=requirements.network,
                payer="0xpayer",
            )
        return SettleResponse(
            success=False,
            transaction="",
            network=requirements.network,
            error_reason="settlement_failed",
        )


# ============================================================================
# Fixtures
# ============================================================================

MOCK_NETWORK = "eip155:8453"


def _make_requirements() -> dict:
    return {
        "scheme": "exact",
        "network": MOCK_NETWORK,
        "asset": "0x0000000000000000000000000000000000000000",
        "amount": "1000000",
        "payTo": "0x1234567890123456789012345678901234567890",
        "maxTimeoutSeconds": 300,
    }


def _make_payload(signature: str = "valid") -> dict:
    return {
        "x402Version": 2,
        "payload": {"signature": signature},
        "accepted": _make_requirements(),
    }


def _make_request_body(signature: str = "valid") -> dict:
    return {
        "x402Version": 2,
        "paymentPayload": _make_payload(signature),
        "paymentRequirements": _make_requirements(),
    }


def _create_sync_facilitator() -> x402FacilitatorSync:
    f = x402FacilitatorSync()
    f.register([MOCK_NETWORK], MockExactScheme())
    return f


def _create_async_facilitator() -> x402Facilitator:
    f = x402Facilitator()
    f.register([MOCK_NETWORK], MockExactScheme())
    return f


@pytest.fixture()
def sync_client() -> TestClient:
    """TestClient with a sync facilitator."""
    app = create_facilitator_app(_create_sync_facilitator())
    return TestClient(app)


@pytest.fixture()
def async_client() -> TestClient:
    """TestClient with an async facilitator."""
    app = create_facilitator_app(_create_async_facilitator())
    return TestClient(app)


# ============================================================================
# /supported
# ============================================================================


class TestSupported:
    def test_returns_registered_kinds(self, sync_client: TestClient) -> None:
        resp = sync_client.get("/supported")
        assert resp.status_code == 200
        data = resp.json()
        assert "kinds" in data
        assert len(data["kinds"]) == 1
        kind = data["kinds"][0]
        assert kind["scheme"] == "exact"
        assert kind["network"] == MOCK_NETWORK
        assert kind["x402Version"] == 2

    def test_returns_signers(self, sync_client: TestClient) -> None:
        resp = sync_client.get("/supported")
        data = resp.json()
        assert "signers" in data
        assert "eip155:*" in data["signers"]
        assert "0xfacilitator" in data["signers"]["eip155:*"]

    def test_returns_extensions(self, sync_client: TestClient) -> None:
        resp = sync_client.get("/supported")
        data = resp.json()
        assert "extensions" in data
        assert data["extensions"] == []


# ============================================================================
# /verify
# ============================================================================


class TestVerify:
    def test_valid_payment(self, sync_client: TestClient) -> None:
        resp = sync_client.post("/verify", json=_make_request_body("valid"))
        assert resp.status_code == 200
        data = resp.json()
        assert data["isValid"] is True
        assert data["payer"] == "0xpayer"

    def test_invalid_payment(self, sync_client: TestClient) -> None:
        resp = sync_client.post("/verify", json=_make_request_body("bad"))
        assert resp.status_code == 200
        data = resp.json()
        assert data["isValid"] is False
        assert data["invalidReason"] == "bad_signature"

    def test_missing_payload(self, sync_client: TestClient) -> None:
        resp = sync_client.post("/verify", json={"x402Version": 2})
        assert resp.status_code == 400

    def test_missing_version(self, sync_client: TestClient) -> None:
        body = _make_request_body()
        del body["x402Version"]
        resp = sync_client.post("/verify", json=body)
        assert resp.status_code == 400

    def test_invalid_json(self, sync_client: TestClient) -> None:
        resp = sync_client.post(
            "/verify",
            content=b"not json",
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 400

    def test_unsupported_network(self, sync_client: TestClient) -> None:
        body = _make_request_body()
        # Use a completely different chain family (not eip155)
        body["paymentPayload"]["accepted"]["network"] = "solana:mainnet"
        body["paymentPayload"]["accepted"]["scheme"] = "exact"
        body["paymentRequirements"]["network"] = "solana:mainnet"
        resp = sync_client.post("/verify", json=body)
        assert resp.status_code == 400
        assert "Unsupported" in resp.json().get("error", "")

    def test_async_facilitator(self, async_client: TestClient) -> None:
        resp = async_client.post("/verify", json=_make_request_body("valid"))
        assert resp.status_code == 200
        data = resp.json()
        assert data["isValid"] is True


# ============================================================================
# /settle
# ============================================================================


class TestSettle:
    def test_successful_settlement(self, sync_client: TestClient) -> None:
        resp = sync_client.post("/settle", json=_make_request_body("valid"))
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["transaction"] == "0xtxhash"
        assert data["network"] == MOCK_NETWORK
        assert data["payer"] == "0xpayer"

    def test_failed_settlement(self, sync_client: TestClient) -> None:
        resp = sync_client.post("/settle", json=_make_request_body("bad"))
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is False
        assert data["errorReason"] == "settlement_failed"

    def test_missing_payload(self, sync_client: TestClient) -> None:
        resp = sync_client.post("/settle", json={"x402Version": 2})
        assert resp.status_code == 400

    def test_async_facilitator(self, async_client: TestClient) -> None:
        resp = async_client.post("/settle", json=_make_request_body("valid"))
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True


# ============================================================================
# /health
# ============================================================================


class TestHealth:
    def test_returns_ok(self, sync_client: TestClient) -> None:
        resp = sync_client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


# ============================================================================
# CORS
# ============================================================================


class TestCors:
    def test_cors_headers_when_configured(self) -> None:
        app = create_facilitator_app(
            _create_sync_facilitator(),
            cors_origins=["https://example.com"],
        )
        client = TestClient(app)
        resp = client.options(
            "/supported",
            headers={
                "Origin": "https://example.com",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert resp.headers.get("access-control-allow-origin") == "https://example.com"

    def test_no_cors_by_default(self, sync_client: TestClient) -> None:
        resp = sync_client.get(
            "/supported",
            headers={"Origin": "https://evil.com"},
        )
        assert "access-control-allow-origin" not in resp.headers


# ============================================================================
# Round-trip: client ↔ server
# ============================================================================


class TestRoundTrip:
    """Verify the server produces responses the client can parse."""

    def test_verify_response_matches_client_schema(self, sync_client: TestClient) -> None:
        """Verify response can be parsed by the same VerifyResponse model the client uses."""
        resp = sync_client.post("/verify", json=_make_request_body("valid"))
        assert resp.status_code == 200

        # Parse with the same model the HTTPFacilitatorClient uses
        result = VerifyResponse.model_validate(resp.json())
        assert result.is_valid is True
        assert result.payer == "0xpayer"

    def test_settle_response_matches_client_schema(self, sync_client: TestClient) -> None:
        """Settle response can be parsed by the same SettleResponse model the client uses."""
        resp = sync_client.post("/settle", json=_make_request_body("valid"))
        assert resp.status_code == 200

        result = SettleResponse.model_validate(resp.json())
        assert result.success is True
        assert result.transaction == "0xtxhash"

    def test_supported_response_matches_client_schema(self, sync_client: TestClient) -> None:
        """Supported response can be parsed by the same SupportedResponse model."""
        resp = sync_client.get("/supported")
        assert resp.status_code == 200

        result = SupportedResponse.model_validate(resp.json())
        assert len(result.kinds) == 1
        assert result.kinds[0].scheme == "exact"
