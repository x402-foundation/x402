"""End-to-end regression test for CDPAI-1054 / ANT-2026-21985.

The require_payment middleware fills the paywall's `resource` field with
`str(request.url)`. Without HTML-safe JSON encoding, an attacker who
lures a victim to a URL containing `</script>` closes the inline
<script> tag and runs arbitrary JavaScript on the merchant origin.

This test drives the FULL flow: real FastAPI + real middleware + real
TestClient request. It does not poke at internal helpers.
"""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from x402.fastapi.middleware import require_payment


async def _ok():
    return {"message": "success"}


def _build_client() -> TestClient:
    app = FastAPI()
    app.get("/api/{tail:path}")(_ok)
    app.middleware("http")(
        require_payment(
            price="$1.00",
            pay_to_address="0x1111111111111111111111111111111111111111",
            network="base-sepolia",
            description="Test payment",
        )
    )
    return TestClient(app)


def _inline_script_body(html: str) -> str:
    """Return the JSON literal assigned to window.x402, untrimmed."""
    marker = "window.x402 = "
    start = html.index(marker) + len(marker)
    end = html.index(";\n", start)
    return html[start:end]


def test_paywall_html_does_not_let_resource_url_close_the_script_tag():
    client = _build_client()
    # Hostile path: contains </script> and an XSS payload that would fire
    # if the script tag is successfully closed.
    response = client.get(
        "/api/protected</script><img src=x onerror=alert(1)>",
        headers={
            "Accept": "text/html",
            "User-Agent": "Mozilla/5.0",
        },
    )

    assert response.status_code == 402
    body = response.text
    # The browser-served paywall HTML must contain an inline window.x402 block.
    assert "window.x402 = " in body
    # The raw </script> from the URL must not survive into the rendered HTML
    # (anywhere — but especially not inside the inline script body).
    assert "</script><img" not in body
    script_body = _inline_script_body(body)
    assert "<" not in script_body
    assert ">" not in script_body


def test_paywall_html_escapes_lt_gt_amp_in_url():
    client = _build_client()
    response = client.get(
        "/api/protected?q=<script>alert(1)</script>&x=&amp;",
        headers={
            "Accept": "text/html",
            "User-Agent": "Mozilla/5.0",
        },
    )

    assert response.status_code == 402
    script_body = _inline_script_body(response.text)
    assert "<" not in script_body
    assert ">" not in script_body
    assert "&" not in script_body


def test_paywall_html_json_still_round_trips_after_escaping():
    import json

    client = _build_client()
    response = client.get(
        "/api/protected/foo</script>?q=<>&amp;",
        headers={
            "Accept": "text/html",
            "User-Agent": "Mozilla/5.0",
        },
    )

    assert response.status_code == 402
    config = json.loads(_inline_script_body(response.text))
    # The escaped JSON must still parse back to the original characters,
    # so the in-page JavaScript can read the values verbatim.
    assert "</script>" in config["currentUrl"]
    assert "</script>" in config["paymentRequirements"][0]["resource"]
