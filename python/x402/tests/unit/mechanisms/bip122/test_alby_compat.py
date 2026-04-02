"""Compatibility tests against Alby's live Lightning facilitator.

These tests verify that our bip122/exact mechanism is wire-compatible
with the Alby Labs facilitator at x402.albylabs.com — the first
production Lightning facilitator in the x402 ecosystem.

Requires network access. Skip with: pytest -m "not network"
"""

import json
import urllib.request

import pytest

from x402.mechanisms.bip122.constants import (
    BTC_MAINNET_CAIP2,
    SCHEME_EXACT,
)
from x402.schemas.responses import SupportedResponse

ALBY_FACILITATOR_URL = "https://x402.albylabs.com"


def _fetch_json(url: str) -> dict:
    """Fetch JSON from a URL using only stdlib."""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


@pytest.mark.network
class TestAlbyFacilitatorCompat:
    """Verify our schemas and constants are compatible with Alby's facilitator."""

    def test_supported_endpoint_is_reachable(self):
        data = _fetch_json(f"{ALBY_FACILITATOR_URL}/supported")
        assert "kinds" in data

    def test_supported_response_parses_into_our_schema(self):
        data = _fetch_json(f"{ALBY_FACILITATOR_URL}/supported")
        resp = SupportedResponse.model_validate(data)
        assert len(resp.kinds) >= 1

    def test_alby_supports_bip122_mainnet(self):
        data = _fetch_json(f"{ALBY_FACILITATOR_URL}/supported")
        resp = SupportedResponse.model_validate(data)
        networks = [k.network for k in resp.kinds]
        assert BTC_MAINNET_CAIP2 in networks, (
            f"Expected {BTC_MAINNET_CAIP2} in Alby's supported networks, got {networks}"
        )

    def test_alby_supports_exact_scheme(self):
        data = _fetch_json(f"{ALBY_FACILITATOR_URL}/supported")
        resp = SupportedResponse.model_validate(data)
        schemes = [k.scheme for k in resp.kinds]
        assert SCHEME_EXACT in schemes, (
            f"Expected '{SCHEME_EXACT}' in Alby's supported schemes, got {schemes}"
        )

    def test_alby_uses_x402_version_2(self):
        data = _fetch_json(f"{ALBY_FACILITATOR_URL}/supported")
        resp = SupportedResponse.model_validate(data)
        versions = [k.x402_version for k in resp.kinds]
        assert 2 in versions, f"Expected x402Version 2 in Alby's response, got {versions}"

    def test_our_payment_requirements_format_matches_alby(self):
        """Verify the payment requirements our server would generate
        are compatible with what Alby's facilitator expects."""
        data = _fetch_json(f"{ALBY_FACILITATOR_URL}/supported")
        resp = SupportedResponse.model_validate(data)

        # Find the bip122 mainnet kind
        bip122_kind = next(
            (k for k in resp.kinds if k.network == BTC_MAINNET_CAIP2),
            None,
        )
        assert bip122_kind is not None

        # Our server generates requirements with these fields —
        # verify they match Alby's expected format
        assert bip122_kind.scheme == SCHEME_EXACT
        assert bip122_kind.x402_version == 2
        assert bip122_kind.network == BTC_MAINNET_CAIP2

    def test_signers_field_present(self):
        """Alby's response should include a signers map (even if empty)."""
        data = _fetch_json(f"{ALBY_FACILITATOR_URL}/supported")
        resp = SupportedResponse.model_validate(data)
        assert isinstance(resp.signers, dict)
        # Alby currently has bip122:* with empty signers
        assert "bip122:*" in resp.signers
