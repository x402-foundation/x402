"""Execute the synchronous Bazaar example with a real, network-free client."""

from textwrap import dedent

import httpx

import x402.http as http
from x402.extensions.bazaar import BazaarExtension
from x402.http import FacilitatorConfig, HTTPFacilitatorClientSync


def test_sync_list_documented_example_is_self_contained(monkeypatch) -> None:
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"x402Version": 2, "items": [], "pagination": {}})

    with httpx.Client(transport=httpx.MockTransport(handler)) as transport:
        facilitator = HTTPFacilitatorClientSync(
            FacilitatorConfig(url="https://facilitator.example.com", http_client=transport)
        )
        monkeypatch.setattr(http, "HTTPFacilitatorClientSync", lambda: facilitator)
        example = BazaarExtension.list_resources.__doc__.split("```python\n", 1)[1].split("```", 1)[
            0
        ]
        exec(dedent(example), {})

    assert len(seen) == 1
    assert seen[0].url.path == "/discovery/resources"
    assert seen[0].url.params["type"] == "http"
    assert seen[0].url.params["limit"] == "10"
