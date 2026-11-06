"""Characterization tests: settlement gating by response status (FastAPI, 1.x).

These tests DOCUMENT current behavior of the legacy 1.x FastAPI adapter.
See https://github.com/x402-foundation/x402/issues/3465 — on paid routes,
responses with a 3xx status are delivered to the client WITHOUT settlement
(`fastapi/middleware.py` early-returns without settling when the response is
not 2xx). The v2 line settled `< 400` for FastAPI from 2.0.0 onward; these
tests pin the 1.x behavior so any future change to it is an explicit,
reviewed decision.
"""

import base64
import json
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.responses import RedirectResponse, Response
from fastapi.testclient import TestClient
from x402.fastapi.middleware import require_payment
from x402.facilitator import VerifyResponse, SettleResponse


def _valid_payment_payload():
    # A structurally valid base64 payment payload; validity is mocked at the
    # facilitator boundary, so the exact contents do not matter.
    return base64.b64encode(
        json.dumps(
            {
                "x402Version": 1,
                "scheme": "exact",
                "network": "base-sepolia",
                "payload": {
                    "signature": "0x" + "00" * 65,
                    "authorization": {
                        "from": "0x" + "11" * 20,
                        "to": "0x" + "22" * 20,
                        "value": "10000",
                        "validAfter": "0",
                        "validBefore": "9999999999",
                        "nonce": "0x" + "00" * 32,
                    },
                },
            }
        ).encode()
    ).decode()


def _create_app():
    app = FastAPI()

    @app.get("/redirect")
    async def redirect_route():
        return RedirectResponse(url="/target", status_code=302)

    @app.get("/not-modified")
    async def not_modified_route():
        return Response(status_code=304)

    @app.get("/ok")
    async def ok_route():
        return {"message": "ok"}

    app.middleware("http")(
        require_payment(
            price="$1.00",
            pay_to_address="0x" + "22" * 20,
            path=["/redirect", "/not-modified", "/ok"],
            network="base-sepolia",
            description="Test payment",
        )
    )
    return app


def _patched_facilitator():
    """Patch FacilitatorClient.verify/settle; returns (patcher, mocks_dict)."""
    mocks = {
        "verify": AsyncMock(
            return_value=VerifyResponse(is_valid=True, invalid_reason=None, payer="0x" + "11" * 20)
        ),
        "settle": AsyncMock(
            return_value=SettleResponse(
                success=True,
                error_reason=None,
                transaction="0x" + "ab" * 32,
                network="base-sepolia",
                payer="0x" + "11" * 20,
            )
        ),
    }
    patcher = patch.multiple("x402.facilitator.FacilitatorClient", **mocks)
    return patcher, mocks


def test_paid_302_delivered_without_settlement():
    """Pins current 1.x behavior: a paid route returning 302 is delivered
    to the client and settle() is NEVER called. See #3465."""
    client = TestClient(_create_app(), follow_redirects=False)
    patcher, mocks = _patched_facilitator()
    with patcher:
        resp = client.get("/redirect", headers={"X-PAYMENT": _valid_payment_payload()})
    assert resp.status_code == 302
    assert resp.headers.get("location") is not None
    assert mocks["verify"].await_count == 1
    assert mocks["settle"].await_count == 0  # settle() is not invoked on non-2xx: current 1.x behavior, see #3465


def test_paid_304_delivered_without_settlement():
    """Pins current 1.x behavior: a paid route returning 304 is delivered
    and settle() is NEVER called. See #3465."""
    client = TestClient(_create_app(), follow_redirects=False)
    patcher, mocks = _patched_facilitator()
    with patcher:
        resp = client.get("/not-modified", headers={"X-PAYMENT": _valid_payment_payload()})
    assert resp.status_code == 304
    assert mocks["verify"].await_count == 1
    assert mocks["settle"].await_count == 0  # settle() is not invoked on non-2xx: current 1.x behavior, see #3465


def test_paid_200_settles_control():
    """Control: a paid 200 route verifies and settles exactly once."""
    client = TestClient(_create_app(), follow_redirects=False)
    patcher, mocks = _patched_facilitator()
    with patcher:
        resp = client.get("/ok", headers={"X-PAYMENT": _valid_payment_payload()})
    assert resp.status_code == 200
    assert mocks["verify"].await_count == 1
    assert mocks["settle"].await_count == 1
    assert resp.headers.get("X-PAYMENT-RESPONSE") is not None
