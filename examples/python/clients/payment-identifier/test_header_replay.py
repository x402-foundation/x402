"""Exact encoded payment-header replay for the payment-identifier client.

Replay is bound to the exact request URL and selected accepted terms.
No live server, wallet print, or raw header dump.
"""

from __future__ import annotations

import hashlib
import unittest

from x402 import x402Client
from x402.http import x402HTTPClient
from x402.schemas import (
    PaymentCreatedContext,
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
)

from main import configure_exact_header_replay

REQUIREMENTS = PaymentRequirements(
    scheme="exact",
    network="eip155:84532",
    asset="0x0000000000000000000000000000000000000001",
    amount="1000",
    pay_to="0x0000000000000000000000000000000000000002",
    max_timeout_seconds=300,
)
OTHER_REQUIREMENTS = PaymentRequirements(
    scheme="exact",
    network="eip155:84532",
    asset="0x0000000000000000000000000000000000000001",
    amount="9999",
    pay_to="0x0000000000000000000000000000000000000002",
    max_timeout_seconds=300,
)
PAYMENT_REQUIRED = PaymentRequired(accepts=[REQUIREMENTS])
OTHER_PAYMENT_REQUIRED = PaymentRequired(accepts=[OTHER_REQUIREMENTS])
PAYLOAD = PaymentPayload(
    x402_version=2,
    payload={"signature": "0xsig"},
    accepted=REQUIREMENTS,
)
PAYLOAD_A = PaymentPayload(
    x402_version=2,
    payload={"signature": "0xsig-A"},
    accepted=REQUIREMENTS,
)
PAYLOAD_B = PaymentPayload(
    x402_version=2,
    payload={"signature": "0xsig-B"},
    accepted=REQUIREMENTS,
)

WEATHER = "http://localhost:4022/weather"
WEATHER_QUERY = "http://localhost:4022/weather?x=1"
FORECAST = "http://localhost:4022/forecast"
EVIL_ORIGIN = "http://evil.example/weather"


def _digest(headers: dict[str, str] | None) -> str:
    if not headers:
        return ""
    value = next(iter(headers.values()))
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class ExactHeaderReplay(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.client = x402Client()
        self.http_client = x402HTTPClient(self.client)
        self.captured, self.after_payment_creation = configure_exact_header_replay(
            self.client, self.http_client, WEATHER
        )

    async def _capture(self) -> None:
        before = await self.http_client.handle_payment_required(
            PAYMENT_REQUIRED, WEATHER
        )
        self.assertIsNone(before)
        await self.after_payment_creation(
            PaymentCreatedContext(
                payment_required=PAYMENT_REQUIRED,
                selected_requirements=REQUIREMENTS,
                payment_payload=PAYLOAD,
            )
        )

    async def test_second_402_replays_the_first_encoded_header(self) -> None:
        await self._capture()
        self.assertIn("headers", self.captured)
        first = self.captured["headers"]
        self.assertIsInstance(first, dict)
        replayed = await self.http_client.handle_payment_required(
            PAYMENT_REQUIRED, WEATHER
        )
        self.assertIsNotNone(replayed)
        first_headers = first
        replayed_headers = replayed or {}
        self.assertEqual(list(first_headers), list(replayed_headers))
        self.assertEqual(_digest(first_headers), _digest(replayed_headers))
        first_value = next(iter(first_headers.values()))
        self.assertGreater(len(first_value), 16)

    async def test_replay_rejects_a_different_url(self) -> None:
        await self._capture()
        replayed = await self.http_client.handle_payment_required(
            PAYMENT_REQUIRED, WEATHER_QUERY
        )
        self.assertIsNone(replayed)

    async def test_replay_rejects_a_different_origin(self) -> None:
        await self._capture()
        replayed = await self.http_client.handle_payment_required(
            PAYMENT_REQUIRED, EVIL_ORIGIN
        )
        self.assertIsNone(replayed)

    async def test_replay_rejects_a_different_path(self) -> None:
        await self._capture()
        replayed = await self.http_client.handle_payment_required(
            PAYMENT_REQUIRED, FORECAST
        )
        self.assertIsNone(replayed)

    async def test_replay_rejects_different_accepted_terms(self) -> None:
        await self._capture()
        replayed = await self.http_client.handle_payment_required(
            OTHER_PAYMENT_REQUIRED, WEATHER
        )
        self.assertIsNone(replayed)
        same = await self.http_client.handle_payment_required(PAYMENT_REQUIRED, WEATHER)
        self.assertIsNotNone(same)
        self.assertEqual(_digest(self.captured["headers"]), _digest(same))

    async def test_interleaved_foreign_402_does_not_bind_capture_to_b(self) -> None:
        before_a = await self.http_client.handle_payment_required(
            PAYMENT_REQUIRED, WEATHER
        )
        before_b = await self.http_client.handle_payment_required(
            PAYMENT_REQUIRED, EVIL_ORIGIN
        )
        self.assertIsNone(before_a)
        self.assertIsNone(before_b)
        await self.after_payment_creation(
            PaymentCreatedContext(
                payment_required=PAYMENT_REQUIRED,
                selected_requirements=REQUIREMENTS,
                payment_payload=PAYLOAD_A,
            )
        )
        replayed_b = await self.http_client.handle_payment_required(
            PAYMENT_REQUIRED, EVIL_ORIGIN
        )
        replayed_a = await self.http_client.handle_payment_required(
            PAYMENT_REQUIRED, WEATHER
        )
        self.assertIsNone(replayed_b)
        self.assertIsNone(replayed_a)
        self.assertEqual(self.captured.get("url"), WEATHER)
        self.assertFalse(self.captured.get("headers"))

    async def test_reverse_interleave_does_not_bind_b_credential_to_a(self) -> None:
        before_b = await self.http_client.handle_payment_required(
            PAYMENT_REQUIRED, FORECAST
        )
        before_a = await self.http_client.handle_payment_required(
            PAYMENT_REQUIRED, WEATHER
        )
        self.assertIsNone(before_b)
        self.assertIsNone(before_a)
        await self.after_payment_creation(
            PaymentCreatedContext(
                payment_required=PAYMENT_REQUIRED,
                selected_requirements=REQUIREMENTS,
                payment_payload=PAYLOAD_B,
            )
        )
        replayed_a = await self.http_client.handle_payment_required(
            PAYMENT_REQUIRED, WEATHER
        )
        replayed_b = await self.http_client.handle_payment_required(
            PAYMENT_REQUIRED, FORECAST
        )
        self.assertIsNone(replayed_a)
        self.assertIsNone(replayed_b)
        self.assertEqual(self.captured.get("url"), WEATHER)
        self.assertFalse(self.captured.get("headers"))

    async def test_sequential_capture_survives_a_later_foreign_402(self) -> None:
        await self._capture()
        foreign = await self.http_client.handle_payment_required(
            PAYMENT_REQUIRED, EVIL_ORIGIN
        )
        self.assertIsNone(foreign)
        same = await self.http_client.handle_payment_required(PAYMENT_REQUIRED, WEATHER)
        self.assertIsNotNone(same)
        self.assertEqual(_digest(self.captured["headers"]), _digest(same))
        self.assertEqual(self.captured.get("url"), WEATHER)

    async def test_empty_target_url_fails_closed(self) -> None:
        client = x402Client()
        http_client = x402HTTPClient(client)
        captured, after_payment_creation = configure_exact_header_replay(
            client, http_client, ""
        )
        before = await http_client.handle_payment_required(PAYMENT_REQUIRED, WEATHER)
        self.assertIsNone(before)
        await after_payment_creation(
            PaymentCreatedContext(
                payment_required=PAYMENT_REQUIRED,
                selected_requirements=REQUIREMENTS,
                payment_payload=PAYLOAD,
            )
        )
        replayed = await http_client.handle_payment_required(PAYMENT_REQUIRED, WEATHER)
        self.assertIsNone(replayed)
        self.assertFalse(captured.get("headers"))


if __name__ == "__main__":
    unittest.main()
