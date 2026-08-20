"""Credential-free tests for request-bound payment-identifier lookup.

No wallet, chain, facilitator, or live payment.
"""

from __future__ import annotations

import unittest

from request_binding import (
    RESERVATION_TTL_SECONDS,
    Reservation,
    bind_payment_id,
    cleanup_expired_reservations,
    consume_reservation,
    lookup,
    request_fingerprint,
    try_reserve,
)

PAYMENT_ID = "pay_aaaaaaaaaaaaaaaa"
TTL = 3600.0
NOW = 1_000.0

PAYLOAD = {
    "x402Version": 2,
    "accepted": {
        "scheme": "exact",
        "network": "eip155:84532",
        "asset": "0x0000000000000000000000000000000000000001",
        "amount": "1000",
        "payTo": "0x0000000000000000000000000000000000000002",
    },
    "payload": {"signature": "0xsig"},
    "extensions": {
        "payment-identifier": {"info": {"id": PAYMENT_ID, "required": False}},
    },
}

WEATHER = "http://localhost:4022/weather"
FORECAST = "http://localhost:4022/forecast"


def fp(*, method="GET", url=WEATHER, body=b"", payload=PAYLOAD) -> str:
    return request_fingerprint(method=method, url=url, body=body, payload=payload)


def cache_for(fingerprint: str) -> dict:
    return {
        PAYMENT_ID: {
            "timestamp": NOW,
            "fingerprint": fingerprint,
            "response": {"report": {"weather": "sunny"}},
        }
    }


def bind(cache, reservations, fingerprint, now=NOW + 1):
    return bind_payment_id(
        cache,
        reservations,
        payment_id=PAYMENT_ID,
        fingerprint=fingerprint,
        now=now,
        cache_ttl_seconds=TTL,
        reservation_ttl_seconds=RESERVATION_TTL_SECONDS,
    )


class RequestBoundLookup(unittest.TestCase):
    def test_identical_retry_is_hit(self) -> None:
        decision = lookup(
            cache_for(fp()),
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW + 1,
            ttl_seconds=TTL,
        )
        self.assertEqual(decision.kind, "hit")
        self.assertEqual(decision.status_code, 200)
        self.assertTrue(decision.grant_access)

    def test_method_drift_is_409_without_access(self) -> None:
        decision = lookup(
            cache_for(fp(method="GET")),
            payment_id=PAYMENT_ID,
            fingerprint=fp(method="POST"),
            now=NOW + 1,
            ttl_seconds=TTL,
        )
        self.assertEqual(decision.status_code, 409)
        self.assertFalse(decision.grant_access)

    def test_path_drift_is_409_without_access(self) -> None:
        decision = lookup(
            cache_for(fp(url=WEATHER)),
            payment_id=PAYMENT_ID,
            fingerprint=fp(url=FORECAST),
            now=NOW + 1,
            ttl_seconds=TTL,
        )
        self.assertEqual(decision.status_code, 409)
        self.assertFalse(decision.grant_access)

    def test_body_drift_is_409_without_access(self) -> None:
        decision = lookup(
            cache_for(fp(body=b"")),
            payment_id=PAYMENT_ID,
            fingerprint=fp(body=b'{"city":"nyc"}'),
            now=NOW + 1,
            ttl_seconds=TTL,
        )
        self.assertEqual(decision.status_code, 409)
        self.assertFalse(decision.grant_access)

    def test_query_drift_is_409_without_access(self) -> None:
        decision = lookup(
            cache_for(fp(url=WEATHER)),
            payment_id=PAYMENT_ID,
            fingerprint=fp(url=WEATHER + "?city=nyc"),
            now=NOW + 1,
            ttl_seconds=TTL,
        )
        self.assertEqual(decision.status_code, 409)
        self.assertFalse(decision.grant_access)

    def test_terms_drift_is_409_without_access(self) -> None:
        other = {**PAYLOAD, "accepted": {**PAYLOAD["accepted"], "amount": "999999"}}
        decision = lookup(
            cache_for(fp()),
            payment_id=PAYMENT_ID,
            fingerprint=fp(payload=other),
            now=NOW + 1,
            ttl_seconds=TTL,
        )
        self.assertEqual(decision.status_code, 409)
        self.assertFalse(decision.grant_access)

    def test_missing_fingerprint_is_conflict(self) -> None:
        cache = {PAYMENT_ID: {"timestamp": NOW, "response": {}}}
        decision = lookup(
            cache,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW + 1,
            ttl_seconds=TTL,
        )
        self.assertEqual(decision.status_code, 409)
        self.assertFalse(decision.grant_access)

    def test_unknown_id_is_miss(self) -> None:
        decision = lookup(
            {}, payment_id=PAYMENT_ID, fingerprint=fp(), now=NOW, ttl_seconds=TTL
        )
        self.assertEqual(decision.kind, "miss")
        self.assertFalse(decision.grant_access)

    def test_query_param_order_is_stable(self) -> None:
        self.assertEqual(fp(url=WEATHER + "?b=2&a=1"), fp(url=WEATHER + "?a=1&b=2"))

    def test_duplicate_query_key_order_is_preserved(self) -> None:
        self.assertNotEqual(fp(url=WEATHER + "?a=1&a=2"), fp(url=WEATHER + "?a=2&a=1"))


class InFlightReservation(unittest.TestCase):
    def test_same_id_same_request_is_in_flight(self) -> None:
        cache: dict = {}
        reservations: dict = {}
        first = bind(cache, reservations, fp())
        second = bind(cache, reservations, fp())
        self.assertEqual(first.kind, "miss")
        self.assertEqual(second.kind, "in_flight")
        self.assertEqual(second.status_code, 409)
        self.assertFalse(second.grant_access)
        self.assertEqual(reservations[PAYMENT_ID].fingerprint, fp())

    def test_same_id_different_request_is_conflict(self) -> None:
        cache: dict = {}
        reservations: dict = {}
        first = bind(cache, reservations, fp(url=WEATHER))
        second = bind(cache, reservations, fp(url=FORECAST))
        self.assertEqual(first.kind, "miss")
        self.assertEqual(second.kind, "conflict")
        self.assertEqual(second.status_code, 409)
        self.assertFalse(second.grant_access)

    def test_live_reservation_is_not_overwritten(self) -> None:
        reservations: dict = {}
        first_fp = fp(url=WEATHER)
        second_fp = fp(url=FORECAST)
        try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=first_fp,
            now=NOW,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=second_fp,
            now=NOW + 1,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        self.assertEqual(reservations[PAYMENT_ID].fingerprint, first_fp)
        self.assertEqual(
            consume_reservation(
                reservations,
                payment_id=PAYMENT_ID,
                now=NOW + 2,
                ttl_seconds=RESERVATION_TTL_SECONDS,
            ),
            first_fp,
        )

    def test_failed_payment_reservation_expires(self) -> None:
        reservations: dict = {}
        first = try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        self.assertEqual(first.kind, "miss")
        blocked = try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW + 1,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        self.assertEqual(blocked.kind, "in_flight")
        removed = cleanup_expired_reservations(
            reservations,
            now=NOW + RESERVATION_TTL_SECONDS,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        self.assertEqual(removed, 1)
        self.assertNotIn(PAYMENT_ID, reservations)
        retry = try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW + RESERVATION_TTL_SECONDS,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        self.assertEqual(retry.kind, "miss")
        self.assertFalse(retry.grant_access)

    def test_missing_reservation_at_settle_does_not_cache(self) -> None:
        fingerprint = consume_reservation(
            {},
            payment_id=PAYMENT_ID,
            now=NOW,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        self.assertIsNone(fingerprint)

    def test_expired_reservation_at_settle_does_not_cache(self) -> None:
        reservations = {
            PAYMENT_ID: Reservation(fingerprint=fp(), timestamp=NOW),
        }
        fingerprint = consume_reservation(
            reservations,
            payment_id=PAYMENT_ID,
            now=NOW + RESERVATION_TTL_SECONDS,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        self.assertIsNone(fingerprint)
        self.assertNotIn(PAYMENT_ID, reservations)

    def test_settled_retry_is_hit(self) -> None:
        cache: dict = {}
        reservations: dict = {}
        first = bind(cache, reservations, fp())
        self.assertEqual(first.kind, "miss")
        stored = consume_reservation(
            reservations,
            payment_id=PAYMENT_ID,
            now=NOW + 2,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        self.assertEqual(stored, fp())
        cache[PAYMENT_ID] = {
            "timestamp": NOW + 2,
            "fingerprint": stored,
            "response": {"report": {"weather": "sunny"}},
        }
        leftover = Reservation(fingerprint=fp(url=FORECAST), timestamp=NOW + 2)
        reservations[PAYMENT_ID] = leftover
        retry = bind(cache, reservations, fp(), now=NOW + 3)
        self.assertEqual(retry.kind, "hit")
        self.assertEqual(retry.status_code, 200)
        self.assertTrue(retry.grant_access)
        self.assertEqual(reservations[PAYMENT_ID], leftover)


if __name__ == "__main__":
    unittest.main()
