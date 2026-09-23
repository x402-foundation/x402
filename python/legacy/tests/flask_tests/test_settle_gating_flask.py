"""Characterization tests: settlement gating by response status (Flask, 1.x).

These tests DOCUMENT current behavior of the legacy 1.x Flask adapter.
See https://github.com/x402-foundation/x402/issues/3465 — on paid routes,
responses with a 3xx status are delivered to the client WITHOUT settlement
(the settle gate is `200 <= status < 300`). The v2 line changed this gate to
`< 400` in 2.15.0 (PR #2826); these tests pin the 1.x behavior so any future
change to it is an explicit, reviewed decision.
"""

import base64
import json
from unittest.mock import AsyncMock, patch

from flask import Flask, redirect
from x402.flask.middleware import PaymentMiddleware
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
    app = Flask(__name__)

    @app.route("/redirect")
    def redirect_route():
        return redirect("/target", code=302)

    @app.route("/not-modified")
    def not_modified_route():
        return "", 304

    @app.route("/ok")
    def ok_route():
        return {"message": "ok"}

    middleware = PaymentMiddleware(app)
    for path in ["/redirect", "/not-modified", "/ok"]:
        middleware.add(
            price="$1.00",
            pay_to_address="0x" + "22" * 20,
            path=path,
            network="base-sepolia",
        )
    return app


def _patched_facilitator():
    """Patch FacilitatorClient.verify/settle; returns (patcher, mocks_dict).

    patch.multiple only reports mocks it creates itself, so we build the
    AsyncMocks here and hand them back for assertion.
    """
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
    app = _create_app()
    patcher, mocks = _patched_facilitator()
    with patcher:
        with app.test_client() as client:
            resp = client.get("/redirect", headers={"X-PAYMENT": _valid_payment_payload()})
        assert resp.status_code == 302
        assert resp.headers.get("Location") is not None
        assert mocks["verify"].await_count == 1
        assert mocks["settle"].await_count == 0  # settle() is not invoked on non-2xx: current 1.x behavior, see #3465


def test_paid_304_delivered_without_settlement():
    """Pins current 1.x behavior: a paid route returning 304 is delivered
    and settle() is NEVER called. See #3465."""
    app = _create_app()
    patcher, mocks = _patched_facilitator()
    with patcher:
        with app.test_client() as client:
            resp = client.get("/not-modified", headers={"X-PAYMENT": _valid_payment_payload()})
        assert resp.status_code == 304
        assert mocks["verify"].await_count == 1
        assert mocks["settle"].await_count == 0  # settle() is not invoked on non-2xx: current 1.x behavior, see #3465


def test_paid_200_settles_control():
    """Control: a paid 200 route verifies and settles exactly once."""
    app = _create_app()
    patcher, mocks = _patched_facilitator()
    with patcher:
        with app.test_client() as client:
            resp = client.get("/ok", headers={"X-PAYMENT": _valid_payment_payload()})
        assert resp.status_code == 200
        assert mocks["verify"].await_count == 1
        assert mocks["settle"].await_count == 1
        assert resp.headers.get("X-PAYMENT-RESPONSE") is not None
