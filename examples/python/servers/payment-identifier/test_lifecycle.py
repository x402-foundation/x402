"""Harnessed FastAPI request lifecycle for payment-identifier reservations.

Uses the SDK FastAPIAdapter so the middleware token must reach hook context.
No wallet, chain, or facilitator.
"""

from __future__ import annotations

import base64
import json
import unittest

from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from x402.http.middleware.fastapi import FastAPIAdapter
from x402.http.types import HTTPRequestContext, HTTPTransportContext

from request_binding import (
    PENDING,
    RESERVATION_TTL_SECONDS,
    UNKNOWN,
    Reservation,
    bind_payment_id,
    consume_reservation,
    is_protected_route,
    mark_outcome_unknown,
    mark_settlement_started,
    release_if_pending,
    request_fingerprint,
    reservation_token_from_transport,
)

PAYMENT_ID = "pay_aaaaaaaaaaaaaaaa"
PAID_ROUTES = {"GET /weather": object()}
PAYLOAD = {
    "x402Version": 2,
    "accepted": {
        "scheme": "exact",
        "network": "eip155:84532",
        "asset": "0x0000000000000000000000000000000000000001",
        "amount": "1000",
        "payTo": "0x0000000000000000000000000000000000000002",
        "maxTimeoutSeconds": 300,
    },
    "payload": {"signature": "0xsig"},
    "extensions": {
        "payment-identifier": {"info": {"id": PAYMENT_ID, "required": False}},
    },
}


def encode_header(payload: dict) -> str:
    return base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")


def build_app() -> tuple[FastAPI, dict, dict, dict]:
    cache: dict = {}
    reservations: dict = {}
    seen: dict = {}
    app = FastAPI()

    @app.middleware("http")
    async def payment_stub(request: Request, call_next):  # type: ignore[no-untyped-def]
        adapter = FastAPIAdapter(request)
        transport = HTTPTransportContext(
            request=HTTPRequestContext(
                adapter=adapter,
                path=request.url.path,
                method=request.method,
            )
        )
        token = reservation_token_from_transport(transport)
        seen["token"] = token
        scenario = request.headers.get("x-test-scenario", "no-match")
        fingerprint = request_fingerprint(
            method=request.method,
            url=str(request.url),
            body=b"",
            payload=PAYLOAD,
        )
        if request.url.path != "/weather":
            return await call_next(request)
        if scenario == "verify-fail":
            seen["phase"] = "verify-fail"
            if token:
                release_if_pending(
                    reservations,
                    payment_id=PAYMENT_ID,
                    fingerprint=fingerprint,
                    now=1.0,
                    ttl_seconds=RESERVATION_TTL_SECONDS,
                    token=token,
                )
            return Response(status_code=402, content=b'{"error":"verify"}')
        if scenario == "settle-throw":
            seen["phase"] = "before-settle"
            if token:
                mark_settlement_started(
                    reservations,
                    payment_id=PAYMENT_ID,
                    fingerprint=fingerprint,
                    now=1.0,
                    ttl_seconds=RESERVATION_TTL_SECONDS,
                    token=token,
                )
                mark_outcome_unknown(
                    reservations,
                    payment_id=PAYMENT_ID,
                    fingerprint=fingerprint,
                    now=1.0,
                    ttl_seconds=RESERVATION_TTL_SECONDS,
                    token=token,
                )
            return Response(status_code=402, content=b'{"error":"settle-unknown"}')
        if scenario in ("settle-ok", "reservation-lost"):
            seen["phase"] = "after-settle"
            if token:
                started = mark_settlement_started(
                    reservations,
                    payment_id=PAYMENT_ID,
                    fingerprint=fingerprint,
                    now=1.0,
                    ttl_seconds=RESERVATION_TTL_SECONDS,
                    token=token,
                )
                if not started:
                    seen["aborted"] = True
                    return Response(
                        status_code=409,
                        content=b'{"error":"payment_identifier_reservation_lost"}',
                    )
                seen["settled"] = True
                consumed = consume_reservation(
                    reservations,
                    payment_id=PAYMENT_ID,
                    fingerprint=fingerprint,
                    now=1.0,
                    ttl_seconds=RESERVATION_TTL_SECONDS,
                    token=token,
                )
                if consumed:
                    cache[PAYMENT_ID] = {
                        "timestamp": 1.0,
                        "fingerprint": consumed,
                        "response": {"report": {"weather": "sunny", "cached": False}},
                    }
            return Response(
                status_code=200,
                content=b'{"report":{"weather":"sunny","cached":false}}',
            )
        seen["phase"] = "no-match"
        return Response(status_code=402, content=b'{"error":"no matching requirement"}')

    @app.middleware("http")
    async def idempotency(request: Request, call_next):  # type: ignore[no-untyped-def]
        header = request.headers.get("payment-signature") or request.headers.get(
            "x-payment"
        )
        reserved_token = None
        reserved_fp = None
        if header and is_protected_route(request.method, str(request.url), PAID_ROUTES):
            fingerprint = request_fingerprint(
                method=request.method,
                url=str(request.url),
                body=b"",
                payload=PAYLOAD,
            )
            try:
                if request.headers.get("x-test-scenario") == "storage-fail":
                    raise RuntimeError("injected storage failure")
                decision = bind_payment_id(
                    cache,
                    reservations,
                    payment_id=PAYMENT_ID,
                    fingerprint=fingerprint,
                    now=0.0,
                    cache_ttl_seconds=3600.0,
                    reservation_ttl_seconds=RESERVATION_TTL_SECONDS,
                )
            except Exception:  # noqa: BLE001 - injected storage boundary
                seen["storage_failed"] = True
                return Response(
                    status_code=503,
                    content=json.dumps(
                        {
                            "error": "payment identifier storage unavailable",
                            "retryable": True,
                        }
                    ),
                    media_type="application/json",
                    headers={"Retry-After": "1"},
                )
            if decision.kind == "hit":
                return Response(
                    status_code=200,
                    content=json.dumps(
                        {
                            "report": {
                                **cache[PAYMENT_ID]["response"]["report"],
                                "cached": True,
                            }
                        }
                    ),
                    media_type="application/json",
                )
            if decision.kind in ("conflict", "in_flight", "capacity"):
                return Response(
                    status_code=decision.status_code or 409,
                    content=json.dumps({"kind": decision.kind}),
                    media_type="application/json",
                )
            reserved = reservations.get(PAYMENT_ID)
            if reserved is not None and reserved.fingerprint == fingerprint:
                request.state.x402_reservation_token = reserved.token
                reserved_token = reserved.token
                reserved_fp = fingerprint
                if request.headers.get("x-test-scenario") == "reservation-lost":
                    reservations[PAYMENT_ID] = Reservation(
                        fingerprint=reserved.fingerprint,
                        timestamp=reserved.timestamp,
                        token="replacement-token",
                        ttl_seconds=reserved.ttl_seconds,
                        state=PENDING,
                    )
        response = await call_next(request)
        if reserved_token and reserved_fp:
            release_if_pending(
                reservations,
                payment_id=PAYMENT_ID,
                fingerprint=reserved_fp,
                now=2.0,
                ttl_seconds=RESERVATION_TTL_SECONDS,
                token=reserved_token,
            )
        return response

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/weather")
    async def weather() -> dict[str, str]:
        return {"weather": "sunny"}

    return app, cache, reservations, seen


class FastAPILifecycle(unittest.TestCase):
    def setUp(self) -> None:
        self.app, self.cache, self.reservations, self.seen = build_app()
        self.client = TestClient(self.app)
        self.headers = {"payment-signature": encode_header(PAYLOAD)}

    def test_unprotected_health_does_not_reserve(self) -> None:
        response = self.client.get("/health", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.reservations, {})
        weather = self.client.get(
            "/weather",
            headers={**self.headers, "x-test-scenario": "settle-ok"},
        )
        self.assertEqual(weather.status_code, 200)
        self.assertIn(PAYMENT_ID, self.cache)

    def test_pre_settlement_rejection_releases_pending(self) -> None:
        response = self.client.get(
            "/weather",
            headers={**self.headers, "x-test-scenario": "no-match"},
        )
        self.assertEqual(response.status_code, 402)
        self.assertEqual(self.seen["phase"], "no-match")
        self.assertTrue(self.seen["token"])
        self.assertNotIn(PAYMENT_ID, self.reservations)

    def test_token_reaches_before_settle_and_unknown_retention(self) -> None:
        response = self.client.get(
            "/weather",
            headers={**self.headers, "x-test-scenario": "settle-throw"},
        )
        self.assertEqual(response.status_code, 402)
        self.assertTrue(self.seen["token"])
        self.assertEqual(self.reservations[PAYMENT_ID].state, UNKNOWN)
        self.assertEqual(self.reservations[PAYMENT_ID].token, self.seen["token"])
        retry = self.client.get(
            "/weather",
            headers={**self.headers, "x-test-scenario": "settle-ok"},
        )
        self.assertEqual(retry.status_code, 503)
        self.assertNotIn(PAYMENT_ID, self.cache)

    def test_successful_consume_caches(self) -> None:
        response = self.client.get(
            "/weather",
            headers={**self.headers, "x-test-scenario": "settle-ok"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(self.seen["token"])
        self.assertIn(PAYMENT_ID, self.cache)
        self.assertNotIn(PAYMENT_ID, self.reservations)
        hit = self.client.get(
            "/weather",
            headers={**self.headers, "x-test-scenario": "settle-ok"},
        )
        self.assertEqual(hit.status_code, 200)
        self.assertTrue(hit.json()["report"]["cached"])

    def test_verify_failure_is_pre_settlement_cleanup(self) -> None:
        response = self.client.get(
            "/weather",
            headers={**self.headers, "x-test-scenario": "verify-fail"},
        )
        self.assertEqual(response.status_code, 402)
        self.assertTrue(self.seen["token"])
        self.assertNotIn(PAYMENT_ID, self.reservations)
        self.assertEqual(self.reservations.get(PAYMENT_ID, PENDING), PENDING)

    def test_stale_token_callback_does_not_mutate_replacement(self) -> None:
        response = self.client.get(
            "/weather",
            headers={**self.headers, "x-test-scenario": "settle-throw"},
        )
        self.assertEqual(response.status_code, 402)
        original = self.reservations[PAYMENT_ID]
        stale_token = original.token
        self.reservations[PAYMENT_ID] = Reservation(
            fingerprint=original.fingerprint,
            timestamp=original.timestamp,
            token="token-replacement",
            ttl_seconds=original.ttl_seconds,
            state=PENDING,
        )
        self.assertIsNone(
            consume_reservation(
                self.reservations,
                payment_id=PAYMENT_ID,
                fingerprint=original.fingerprint,
                now=1.0,
                ttl_seconds=RESERVATION_TTL_SECONDS,
                token=stale_token,
            )
        )
        self.assertFalse(
            release_if_pending(
                self.reservations,
                payment_id=PAYMENT_ID,
                fingerprint=original.fingerprint,
                now=1.0,
                ttl_seconds=RESERVATION_TTL_SECONDS,
                token=stale_token,
            )
        )
        self.assertEqual(self.reservations[PAYMENT_ID].token, "token-replacement")
        self.assertEqual(self.reservations[PAYMENT_ID].state, PENDING)

    def test_lost_reservation_aborts_before_settlement(self) -> None:
        response = self.client.get(
            "/weather",
            headers={**self.headers, "x-test-scenario": "reservation-lost"},
        )
        self.assertEqual(response.status_code, 409)
        self.assertTrue(self.seen["aborted"])
        self.assertFalse(self.seen.get("settled", False))
        self.assertNotIn(PAYMENT_ID, self.cache)
        self.assertEqual(self.reservations[PAYMENT_ID].token, "replacement-token")

    def test_storage_failure_fails_closed_before_payment(self) -> None:
        response = self.client.get(
            "/weather",
            headers={**self.headers, "x-test-scenario": "storage-fail"},
        )
        self.assertEqual(response.status_code, 503)
        self.assertTrue(response.json()["retryable"])
        self.assertEqual(response.headers["retry-after"], "1")
        self.assertTrue(self.seen["storage_failed"])
        self.assertNotIn("phase", self.seen)
        self.assertFalse(self.seen.get("settled", False))
        self.assertEqual(self.cache, {})
        self.assertEqual(self.reservations, {})


if __name__ == "__main__":
    unittest.main()
