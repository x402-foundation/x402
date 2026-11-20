"""Execute the actual async discovery docs against real network-free clients."""

import re
from pathlib import Path
from textwrap import dedent

import httpx
import pytest

import x402.http as http
from x402.http import HTTPFacilitatorClient


@pytest.mark.parametrize("index", [0, 1])
@pytest.mark.parametrize("status", [200, 500])
def test_async_discovery_documented_examples(monkeypatch, index, status):
    doc = (Path(__file__).resolve().parents[6] / "docs/extensions/bazaar.mdx").read_text()
    section = doc.split("#### Step 1: Discover Available Services", 1)[1].split(
        "#### Step 2: Call a Discovered Service", 1
    )[0]
    examples = re.findall(r"    ```python\n(.*?)    ```", section, re.S)
    assert len(examples) == 2
    requests = []
    transports = []

    def handler(request):
        requests.append(request)
        body = {"x402Version": 2, "items": [], "pagination": {}}
        if request.url.path.endswith("/search"):
            body = {"resources": []}
        return httpx.Response(status, json=body)

    def factory(config):
        client = HTTPFacilitatorClient(config)
        transport = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client._http_client = transport
        transports.append(transport)
        return client

    monkeypatch.setattr(http, "HTTPFacilitatorClient", factory)
    code = compile(dedent(examples[index]), "bazaar.mdx", "exec")
    if status == 500:
        with pytest.raises(ValueError, match=r"failed \(500\)"):
            exec(code, {})
    else:
        namespace = {}
        exec(code, namespace)
        assert "affordable_services" in namespace if index == 0 else "results" in namespace
    assert len(requests) == len(transports) == 1
    assert transports[0].is_closed
    expected = "/discovery/resources" if index == 0 else "/discovery/search"
    assert requests[0].url.path == "/facilitator" + expected
    assert requests[0].url.params["type"] == "http"
