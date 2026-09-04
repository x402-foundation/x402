"""Credential-free tests for request-bound payment-identifier lookup.

No wallet, chain, facilitator, or live payment.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from request_binding import (
    CAPACITY,
    CONFLICT,
    CONFLICT_STATUS_CODE,
    FALLBACK_RESERVATION_TTL_SECONDS,
    HIT,
    IN_FLIGHT,
    MAX_PENDING_RESERVATIONS,
    PENDING,
    RESERVATION_TTL_SECONDS,
    RETRYABLE_STATUS_CODE,
    UNKNOWN,
    Reservation,
    bind_payment_id,
    canonical_accepted_extra,
    canonical_max_timeout_seconds,
    canonical_request_url,
    cleanup_expired_reservations,
    consume_reservation,
    is_protected_route,
    lookup,
    mark_outcome_unknown,
    mark_settlement_started,
    release_if_pending,
    release_reservation,
    request_fingerprint,
    reservation_ttl_seconds,
    try_reserve,
)

PAYMENT_ID = "pay_aaaaaaaaaaaaaaaa"
TTL = 3600.0
NOW = 1_000.0
CANONICAL_SAME_REQUEST_FINGERPRINT = (
    "3be3051236cf413f1cb88528fa8d9a7f22de774366f31fa7f319b972e943cc3f"
)
CANONICAL_EXTRA_FINGERPRINT = (
    "0565bb0ee3d8210ff27002b3c8e0748a570362835e1ef44186e1d4c967f2cf8c"
)
QUERY_FIXTURES = json.loads(
    (
        Path(__file__).resolve().parents[3]
        / "shared"
        / "payment-identifier-query-fixtures.json"
    ).read_text(encoding="utf-8")
)

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


def stored(fingerprint: str, **overrides: object) -> Reservation:
    values = {
        "fingerprint": fingerprint,
        "timestamp": NOW,
        "token": "token-a",
        "ttl_seconds": RESERVATION_TTL_SECONDS,
        "state": PENDING,
    }
    values.update(overrides)
    return Reservation(**values)  # type: ignore[arg-type]


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
        self.assertEqual(decision.kind, HIT)
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

    def test_credential_drift_is_409_without_access(self) -> None:
        other = {**PAYLOAD, "payload": {"signature": "0xforged"}}
        decision = lookup(
            cache_for(fp()),
            payment_id=PAYMENT_ID,
            fingerprint=fp(payload=other),
            now=NOW + 1,
            ttl_seconds=TTL,
        )
        self.assertEqual(decision.status_code, 409)
        self.assertFalse(decision.grant_access)
        self.assertNotEqual(fp(), fp(payload=other))

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
        self.assertEqual(second.kind, IN_FLIGHT)
        self.assertEqual(second.status_code, RETRYABLE_STATUS_CODE)
        self.assertFalse(second.grant_access)
        self.assertEqual(reservations[PAYMENT_ID].fingerprint, fp())

    def test_same_id_different_request_is_conflict(self) -> None:
        cache: dict = {}
        reservations: dict = {}
        first = bind(cache, reservations, fp(url=WEATHER))
        second = bind(cache, reservations, fp(url=FORECAST))
        self.assertEqual(first.kind, "miss")
        self.assertEqual(second.kind, CONFLICT)
        self.assertEqual(second.status_code, CONFLICT_STATUS_CODE)
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
        token = reservations[PAYMENT_ID].token
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
                fingerprint=first_fp,
                now=NOW + 2,
                ttl_seconds=RESERVATION_TTL_SECONDS,
                token=token,
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
        self.assertEqual(blocked.kind, IN_FLIGHT)
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
            fingerprint=fp(),
            now=NOW,
            ttl_seconds=RESERVATION_TTL_SECONDS,
            token="token-a",
        )
        self.assertIsNone(fingerprint)

    def test_expired_current_reservation_can_cache_if_not_replaced(self) -> None:
        reservations = {PAYMENT_ID: stored(fp())}
        fingerprint = consume_reservation(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW + RESERVATION_TTL_SECONDS,
            ttl_seconds=RESERVATION_TTL_SECONDS,
            token="token-a",
        )
        self.assertEqual(fingerprint, fp())
        self.assertNotIn(PAYMENT_ID, reservations)

    def test_settled_retry_is_hit(self) -> None:
        cache: dict = {}
        reservations: dict = {}
        first = bind(cache, reservations, fp())
        self.assertEqual(first.kind, "miss")
        token = reservations[PAYMENT_ID].token
        stored_fp = consume_reservation(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW + 2,
            ttl_seconds=RESERVATION_TTL_SECONDS,
            token=token,
        )
        self.assertEqual(stored_fp, fp())
        cache[PAYMENT_ID] = {
            "timestamp": NOW + 2,
            "fingerprint": stored_fp,
            "response": {"report": {"weather": "sunny"}},
        }
        leftover = stored(fp(url=FORECAST), timestamp=NOW + 2, token="token-b")
        reservations[PAYMENT_ID] = leftover
        retry = bind(cache, reservations, fp(), now=NOW + 3)
        self.assertEqual(retry.kind, HIT)
        self.assertEqual(retry.status_code, 200)
        self.assertTrue(retry.grant_access)
        self.assertEqual(reservations[PAYMENT_ID], leftover)


PAID_ROUTES = {"GET /weather": object()}


class ProtectedRoute(unittest.TestCase):
    def test_weather_is_protected(self) -> None:
        self.assertTrue(is_protected_route("GET", WEATHER, PAID_ROUTES))
        self.assertTrue(is_protected_route("GET", "/weather?city=nyc", PAID_ROUTES))

    def test_health_is_not_protected(self) -> None:
        self.assertFalse(
            is_protected_route("GET", "http://localhost:4022/health", PAID_ROUTES)
        )

    def test_unmatched_path_is_not_protected(self) -> None:
        self.assertFalse(is_protected_route("GET", "/not-a-paid-route", PAID_ROUTES))

    def test_unprotected_header_cannot_block_paid_route(self) -> None:
        cache: dict = {}
        reservations: dict = {}
        health_fp = fp(url="http://localhost:4022/health")
        self.assertFalse(
            is_protected_route("GET", "http://localhost:4022/health", PAID_ROUTES)
        )
        self.assertNotIn(PAYMENT_ID, reservations)
        weather = bind(cache, reservations, fp())
        self.assertEqual(weather.kind, "miss")
        self.assertEqual(reservations[PAYMENT_ID].fingerprint, fp())
        self.assertNotEqual(health_fp, fp())


class ReservationRelease(unittest.TestCase):
    def test_verify_failure_releases_matching_reservation(self) -> None:
        reservations: dict = {}
        try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        token = reservations[PAYMENT_ID].token
        released = release_reservation(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW + 1,
            ttl_seconds=RESERVATION_TTL_SECONDS,
            token=token,
        )
        self.assertTrue(released)
        self.assertNotIn(PAYMENT_ID, reservations)
        retry = try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW + 2,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        self.assertEqual(retry.kind, "miss")

    def test_stale_failure_does_not_drop_replacement(self) -> None:
        replacement = stored(fp(url=FORECAST), timestamp=NOW + 1, token="token-b")
        reservations = {PAYMENT_ID: replacement}
        dropped = release_reservation(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW + 2,
            ttl_seconds=RESERVATION_TTL_SECONDS,
            token="token-a",
        )
        self.assertFalse(dropped)
        self.assertEqual(reservations[PAYMENT_ID], replacement)

    def test_stale_settle_does_not_consume_replacement(self) -> None:
        first_fp = fp()
        replacement_fp = fp(url=FORECAST)
        reservations = {
            PAYMENT_ID: stored(replacement_fp, timestamp=NOW + 1, token="token-b")
        }
        stolen = consume_reservation(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=first_fp,
            now=NOW + 2,
            ttl_seconds=RESERVATION_TTL_SECONDS,
            token="token-a",
        )
        self.assertIsNone(stolen)
        self.assertEqual(reservations[PAYMENT_ID].fingerprint, replacement_fp)

    def test_settle_after_expiry_does_not_cache_replacement(self) -> None:
        replacement = stored(
            fp(url=FORECAST),
            timestamp=NOW + RESERVATION_TTL_SECONDS,
            token="token-b",
        )
        reservations = {PAYMENT_ID: replacement}
        cached = consume_reservation(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW + RESERVATION_TTL_SECONDS + 1,
            ttl_seconds=RESERVATION_TTL_SECONDS,
            token="token-a",
        )
        self.assertIsNone(cached)
        self.assertEqual(reservations[PAYMENT_ID], replacement)

    def test_same_fingerprint_replacement_requires_token(self) -> None:
        reservations = {
            PAYMENT_ID: stored(
                fp(), timestamp=NOW + RESERVATION_TTL_SECONDS, token="token-b"
            )
        }
        stolen = consume_reservation(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW + RESERVATION_TTL_SECONDS + 1,
            ttl_seconds=RESERVATION_TTL_SECONDS,
            token="token-a",
        )
        self.assertIsNone(stolen)
        self.assertIn(PAYMENT_ID, reservations)

    def test_missing_token_is_not_fingerprint_ownership(self) -> None:
        reservations = {PAYMENT_ID: stored(fp(), token="token-b")}
        self.assertFalse(
            release_reservation(
                reservations,
                payment_id=PAYMENT_ID,
                fingerprint=fp(),
                now=NOW + 1,
                ttl_seconds=RESERVATION_TTL_SECONDS,
            )
        )
        self.assertIsNone(
            consume_reservation(
                reservations,
                payment_id=PAYMENT_ID,
                fingerprint=fp(),
                now=NOW + 1,
                ttl_seconds=RESERVATION_TTL_SECONDS,
            )
        )
        self.assertFalse(
            mark_outcome_unknown(
                reservations,
                payment_id=PAYMENT_ID,
                fingerprint=fp(),
                now=NOW + 1,
                ttl_seconds=RESERVATION_TTL_SECONDS,
                token="token-a",
            )
        )
        self.assertFalse(
            mark_settlement_started(
                reservations,
                payment_id=PAYMENT_ID,
                fingerprint=fp(),
                now=NOW + 1,
                ttl_seconds=RESERVATION_TTL_SECONDS,
                token="token-a",
            )
        )
        self.assertEqual(reservations[PAYMENT_ID].token, "token-b")
        self.assertEqual(reservations[PAYMENT_ID].timestamp, NOW)


class ReservationTtl(unittest.TestCase):
    def test_exact_current_token_enters_settlement_after_prior_deadline(self) -> None:
        reservations: dict = {}
        try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        token = reservations[PAYMENT_ID].token
        settlement_started = NOW + RESERVATION_TTL_SECONDS + 1
        self.assertTrue(
            mark_settlement_started(
                reservations,
                payment_id=PAYMENT_ID,
                fingerprint=fp(),
                now=settlement_started,
                ttl_seconds=RESERVATION_TTL_SECONDS,
                token=token,
            )
        )
        self.assertEqual(reservations[PAYMENT_ID].timestamp, settlement_started)
        self.assertEqual(
            consume_reservation(
                reservations,
                payment_id=PAYMENT_ID,
                fingerprint=fp(),
                now=settlement_started + RESERVATION_TTL_SECONDS + 1,
                ttl_seconds=RESERVATION_TTL_SECONDS,
                token=token,
            ),
            fp(),
        )
        self.assertNotIn(PAYMENT_ID, reservations)

    def test_unknown_transition_refreshes_full_window_after_original_deadline(
        self,
    ) -> None:
        reservations: dict = {}
        try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        token = reservations[PAYMENT_ID].token
        settlement_started = NOW + RESERVATION_TTL_SECONDS - 1
        outcome_unknown = settlement_started + RESERVATION_TTL_SECONDS + 1
        self.assertTrue(
            mark_settlement_started(
                reservations,
                payment_id=PAYMENT_ID,
                fingerprint=fp(),
                now=settlement_started,
                ttl_seconds=RESERVATION_TTL_SECONDS,
                token=token,
            )
        )
        self.assertTrue(
            mark_outcome_unknown(
                reservations,
                payment_id=PAYMENT_ID,
                fingerprint=fp(),
                now=outcome_unknown,
                ttl_seconds=RESERVATION_TTL_SECONDS,
                token=token,
            )
        )
        self.assertEqual(reservations[PAYMENT_ID].timestamp, outcome_unknown)
        other = fp(payload={**PAYLOAD, "payload": {"signature": "0xforged"}})
        self.assertEqual(
            try_reserve(
                reservations,
                payment_id=PAYMENT_ID,
                fingerprint=other,
                now=outcome_unknown + RESERVATION_TTL_SECONDS - 1,
                ttl_seconds=RESERVATION_TTL_SECONDS,
            ).kind,
            CONFLICT,
        )

    def test_tiny_client_timeout_does_not_set_map_ttl(self) -> None:
        payload = {
            **PAYLOAD,
            "accepted": {**PAYLOAD["accepted"], "maxTimeoutSeconds": 1},
        }
        reservations: dict = {}
        try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(payload=payload),
            now=NOW,
            ttl_seconds=reservation_ttl_seconds(payload),
        )
        blocked = try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(payload=payload),
            now=NOW + 2,
            ttl_seconds=reservation_ttl_seconds(payload),
        )
        self.assertEqual(blocked.kind, IN_FLIGHT)
        self.assertEqual(reservation_ttl_seconds(payload), RESERVATION_TTL_SECONDS)
        self.assertEqual(FALLBACK_RESERVATION_TTL_SECONDS, 300.0)

    def test_huge_client_timeout_does_not_extend_map_ttl(self) -> None:
        payload = {
            **PAYLOAD,
            "accepted": {**PAYLOAD["accepted"], "maxTimeoutSeconds": 1_000_000},
        }
        reservations: dict = {}
        try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(payload=payload),
            now=NOW,
            ttl_seconds=reservation_ttl_seconds(payload),
        )
        removed = cleanup_expired_reservations(
            reservations,
            now=NOW + RESERVATION_TTL_SECONDS,
            ttl_seconds=reservation_ttl_seconds(payload),
        )
        self.assertEqual(removed, 1)
        self.assertNotIn(PAYMENT_ID, reservations)

    def test_expires_only_after_server_owned_ttl(self) -> None:
        reservations: dict = {}
        try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        self.assertEqual(
            cleanup_expired_reservations(
                reservations,
                now=NOW + RESERVATION_TTL_SECONDS - 1,
                ttl_seconds=RESERVATION_TTL_SECONDS,
            ),
            0,
        )
        self.assertEqual(
            cleanup_expired_reservations(
                reservations,
                now=NOW + RESERVATION_TTL_SECONDS,
                ttl_seconds=RESERVATION_TTL_SECONDS,
            ),
            1,
        )


class ReservationCapacity(unittest.TestCase):
    def test_capacity_fails_closed_without_overwrite(self) -> None:
        reservations: dict = {}
        for index in range(MAX_PENDING_RESERVATIONS):
            decision = try_reserve(
                reservations,
                payment_id=f"pay_{index:04d}",
                fingerprint=fp(),
                now=NOW,
                ttl_seconds=RESERVATION_TTL_SECONDS,
            )
            self.assertEqual(decision.kind, "miss")
        overflow = try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        self.assertEqual(overflow.kind, CAPACITY)
        self.assertEqual(overflow.status_code, RETRYABLE_STATUS_CODE)
        self.assertFalse(overflow.grant_access)
        self.assertEqual(len(reservations), MAX_PENDING_RESERVATIONS)
        self.assertNotIn(PAYMENT_ID, reservations)

    def test_capacity_recovers_after_expiry_cleanup(self) -> None:
        reservations: dict = {}
        for index in range(MAX_PENDING_RESERVATIONS):
            try_reserve(
                reservations,
                payment_id=f"pay_{index:04d}",
                fingerprint=fp(),
                now=NOW,
                ttl_seconds=RESERVATION_TTL_SECONDS,
            )
        retry = try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW + RESERVATION_TTL_SECONDS,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        self.assertEqual(retry.kind, "miss")
        self.assertIn(PAYMENT_ID, reservations)


class SettlementLifecycle(unittest.TestCase):
    def test_pre_settlement_release_clears_pending(self) -> None:
        reservations: dict = {}
        try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        token = reservations[PAYMENT_ID].token
        self.assertTrue(
            release_if_pending(
                reservations,
                payment_id=PAYMENT_ID,
                fingerprint=fp(),
                now=NOW + 1,
                ttl_seconds=RESERVATION_TTL_SECONDS,
                token=token,
            )
        )
        self.assertNotIn(PAYMENT_ID, reservations)

    def test_outcome_unknown_retains_tombstone(self) -> None:
        reservations: dict = {}
        try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        token = reservations[PAYMENT_ID].token
        self.assertTrue(
            mark_settlement_started(
                reservations,
                payment_id=PAYMENT_ID,
                fingerprint=fp(),
                now=NOW + 1,
                ttl_seconds=RESERVATION_TTL_SECONDS,
                token=token,
            )
        )
        self.assertTrue(
            mark_outcome_unknown(
                reservations,
                payment_id=PAYMENT_ID,
                fingerprint=fp(),
                now=NOW + 2,
                ttl_seconds=RESERVATION_TTL_SECONDS,
                token=token,
            )
        )
        self.assertEqual(reservations[PAYMENT_ID].state, UNKNOWN)
        self.assertFalse(
            release_if_pending(
                reservations,
                payment_id=PAYMENT_ID,
                fingerprint=fp(),
                now=NOW + 3,
                ttl_seconds=RESERVATION_TTL_SECONDS,
                token=token,
            )
        )
        self.assertIsNone(
            consume_reservation(
                reservations,
                payment_id=PAYMENT_ID,
                fingerprint=fp(),
                now=NOW + 3,
                ttl_seconds=RESERVATION_TTL_SECONDS,
                token=token,
            )
        )
        other = fp(payload={**PAYLOAD, "payload": {"signature": "0xforged"}})
        fresh = try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=other,
            now=NOW + 4,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        self.assertEqual(fresh.kind, CONFLICT)
        same = try_reserve(
            reservations,
            payment_id=PAYMENT_ID,
            fingerprint=fp(),
            now=NOW + 5,
            ttl_seconds=RESERVATION_TTL_SECONDS,
        )
        self.assertEqual(same.kind, IN_FLIGHT)


class AcceptedTermsFingerprint(unittest.TestCase):
    def test_max_timeout_seconds_is_fingerprinted(self) -> None:
        other = {
            **PAYLOAD,
            "accepted": {**PAYLOAD["accepted"], "maxTimeoutSeconds": 60},
        }
        self.assertNotEqual(fp(), fp(payload=other))
        self.assertEqual(canonical_max_timeout_seconds(PAYLOAD["accepted"]), "")
        self.assertEqual(canonical_max_timeout_seconds(other["accepted"]), "60")

    def test_extra_is_recursively_canonical(self) -> None:
        extra_a = {
            **PAYLOAD,
            "accepted": {**PAYLOAD["accepted"], "extra": {"z": 1, "a": {"b": 2}}},
        }
        extra_b = {
            **PAYLOAD,
            "accepted": {**PAYLOAD["accepted"], "extra": {"a": {"b": 2}, "z": 1}},
        }
        extra_c = {
            **PAYLOAD,
            "accepted": {**PAYLOAD["accepted"], "extra": {"z": 1, "a": {"b": 3}}},
        }
        self.assertEqual(fp(payload=extra_a), fp(payload=extra_b))
        self.assertNotEqual(fp(payload=extra_a), fp(payload=extra_c))
        self.assertEqual(
            canonical_accepted_extra(extra_a["accepted"]),
            '{"a":{"b":2},"z":1}',
        )


class CanonicalQueryEncoding(unittest.TestCase):
    def test_shared_adversarial_fixtures(self) -> None:
        for fixture in QUERY_FIXTURES:
            with self.subTest(fixture["name"]):
                self.assertEqual(
                    canonical_request_url(fixture["url"]), fixture["canonical"]
                )


class CrossLanguageFixture(unittest.TestCase):
    def test_canonical_same_request_fingerprint(self) -> None:
        digest = fp(url=WEATHER + "?b=2&a=1")
        self.assertEqual(fp(url=WEATHER + "?a=1&b=2"), digest)
        self.assertEqual(digest, CANONICAL_SAME_REQUEST_FINGERPRINT)

    def test_canonical_extra_fingerprint(self) -> None:
        extra = {
            **PAYLOAD,
            "accepted": {**PAYLOAD["accepted"], "extra": {"z": 1, "a": {"b": 2}}},
        }
        self.assertEqual(fp(payload=extra), CANONICAL_EXTRA_FINGERPRINT)


if __name__ == "__main__":
    unittest.main()
