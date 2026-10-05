"""Exercise the actual e2e FastMCP registration with an offline facilitator."""

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from mcp.server.fastmcp import Context, FastMCP

from x402.mcp.constants import MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY
from x402.mechanisms.cardano.exact.masumi.verify import verify_masumi_authorization
from x402.schemas import PaymentRequirements, SettleResponse, VerifyResponse
from x402.tests.unit.mechanisms.cardano.test_server import (
    NETWORK,
    Facilitator,
    payment,
    template,
)


class OfflineFacilitator(Facilitator):
    def __init__(self):
        self.verified = []
        self.settled = []

    async def verify(self, payload, requirements):
        assert verify_masumi_authorization(requirements.extra, requirements).ok
        self.verified.append(requirements)
        return VerifyResponse(is_valid=True)

    async def settle(self, payload, requirements):
        self.settled.append(requirements)
        return SettleResponse(success=True, transaction="12" * 32, network=NETWORK)


@pytest.fixture
def e2e_tools(monkeypatch):
    root = Path(__file__).resolve().parents[6]
    monkeypatch.syspath_prepend(str(root / "e2e/servers/python"))
    import catalog
    import config
    import mcp.server.fastmcp
    import uvicorn

    import x402.http

    app = FastMCP("offline-cardano")
    facilitator = OfflineFacilitator()
    monkeypatch.setattr(mcp.server.fastmcp, "FastMCP", lambda *args, **kwargs: app)
    monkeypatch.setattr(x402.http, "HTTPFacilitatorClient", lambda *args: facilitator)
    applications = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: applications.append(app))
    monkeypatch.setenv("CARDANO_NETWORK", NETWORK)
    monkeypatch.setenv("SERVER_CARDANO_SELLER_MNEMONIC", "abandon " * 11 + "about")
    monkeypatch.setattr(
        config,
        "load_server_config",
        lambda: config.ServerConfig(
            4021, "https://offline.test", {"cardano": template().pay_to}, ""
        ),
    )
    routes = [
        catalog.ResolvedRoute(
            path=f"/cardano-job-{job}",
            network_id="cardano",
            scheme="exact",
            network=NETWORK,
            pay_to=template().pay_to,
            price={"asset": "lovelace", "amount": "5000000"},
            extra={"assetTransferMethod": "masumi"},
        )
        for job in ("a", "b")
    ]
    monkeypatch.setattr(catalog, "resolve_routes", lambda *args: routes)
    spec = importlib.util.spec_from_file_location(
        "cardano_e2e_mcp", root / "e2e/servers/python/mcp/main.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.main()
    return (
        app,
        facilitator,
        [catalog.mcp_tool_name(route.path) for route in routes],
        applications[0],
    )


def context(app, payload=None):
    meta = {} if payload is None else {MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True)}
    return Context(
        request_context=SimpleNamespace(meta=SimpleNamespace(model_extra=meta)),
        fastmcp=app,
    )


@pytest.mark.asyncio
async def test_e2e_mcp_issues_signed_quote_and_reuses_it_on_paid_retry(e2e_tools):
    app, facilitator, names, _ = e2e_tools
    tool = app._tool_manager.get_tool(names[0])
    assert await app._tool_manager.get_tool("ping").run({}) == "pong"
    # Context must be injected by FastMCP, without adding a public tool argument.
    assert tool.parameters["properties"] == {}
    unpaid = await tool.run({}, context=context(app))
    assert unpaid.isError
    issued = PaymentRequirements.model_validate(unpaid.structuredContent["accepts"][0])
    assert verify_masumi_authorization(issued.extra, issued).ok
    assert facilitator.verified == facilitator.settled == []

    paid = await tool.run({}, context=context(app, payment(issued)))
    assert not paid.isError
    assert json.loads(paid.content[0].text)["message"] == "Protected endpoint accessed successfully"
    assert paid.meta[MCP_PAYMENT_RESPONSE_META_KEY]["success"]
    assert facilitator.verified == facilitator.settled == [issued]

    other = app._tool_manager.get_tool(names[1])
    rejected = await other.run({}, context=context(app, payment(issued)))
    assert rejected.isError
    assert facilitator.verified == facilitator.settled == [issued]


@pytest.mark.asyncio
async def test_e2e_mcp_app_runs_lifespan_and_serves_health(e2e_tools):
    import httpx

    _, _, _, app = e2e_tools
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://localhost"
        ) as client:
            response = await client.get("/health")
    assert response.status_code == 200
