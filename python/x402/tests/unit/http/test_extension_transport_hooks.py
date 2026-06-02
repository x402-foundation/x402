"""Tests for extension HTTP transport hooks on client and server."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from x402.http.types import HTTPRequestContext, PaymentOption, RouteConfig
from x402.http.x402_http_client import x402HTTPClient
from x402.http.x402_http_server_base import x402HTTPServerBase
from x402.schemas import PaymentRequired, PaymentRequirements
from x402.schemas.hooks import (
    GrantAccessResult,
    PaymentRequiredContext,
    PaymentRequiredHeadersResult,
)
from x402.server import x402ResourceServer


class _Adapter:
    def get_method(self) -> str:
        return "GET"

    def get_path(self) -> str:
        return "/test"

    def get_header(self, _name: str) -> str | None:
        return None

    def get_body_bytes(self) -> bytes:
        return b""


@dataclass
class _HTTPExtensionHooks:
    on_protected_request: Any = None
    on_payment_required: Any = None


@dataclass
class _TransportHooks:
    http: _HTTPExtensionHooks


class _ServerExtension:
    key = "srv-ext"

    def enrich_declaration(self, declared: Any, _transport_context: Any) -> Any:
        return declared

    @property
    def transport_hooks(self) -> _TransportHooks:
        return _TransportHooks(
            http=_HTTPExtensionHooks(
                on_protected_request=lambda _decl, _ctx, _route=None: GrantAccessResult(),
            )
        )


class _ClientExtension:
    key = "cli-ext"

    @property
    def transport_hooks(self) -> _TransportHooks:
        return _TransportHooks(
            http=_HTTPExtensionHooks(
                on_payment_required=lambda _decl, _ctx: PaymentRequiredHeadersResult(
                    headers={"X-Test": "1"}
                ),
            )
        )


class _ClientForHttp:
    def get_extensions(self) -> list[_ClientExtension]:
        return [_ClientExtension()]


def _route_config(extensions: dict[str, Any] | None = None) -> RouteConfig:
    return RouteConfig(
        accepts=PaymentOption(
            scheme="exact",
            pay_to="0xpay",
            price="$0.01",
            network="eip155:8453",
        ),
        extensions=extensions,
    )


def test_server_extension_on_protected_request_runs_after_manual():
    server = x402ResourceServer()
    server.register_extension(_ServerExtension())
    route = _route_config({"srv-ext": {}})
    http_server = x402HTTPServerBase(server, {"*": route})

    order: list[str] = []

    def manual(_ctx: Any, _route: RouteConfig) -> None:
        order.append("manual")

    http_server.on_protected_request(manual)
    hooks = http_server._collect_protected_request_hooks(route)
    assert len(hooks) == 2
    context = HTTPRequestContext(adapter=_Adapter(), method="GET", path="/test")
    hooks[0](context, route)
    result = hooks[1](context, route)
    assert order == ["manual"]
    assert isinstance(result, GrantAccessResult)


def test_server_extension_on_protected_request_gated_by_declared_key():
    server = x402ResourceServer()
    server.register_extension(_ServerExtension())
    route = _route_config()
    http_server = x402HTTPServerBase(server, {"*": route})
    hooks = http_server._collect_protected_request_hooks(route)
    assert len(hooks) == 0


def test_server_extension_on_protected_request_forwards_route_config():
    received: list[RouteConfig] = []

    class _RouteAwareExtension:
        key = "route-ext"

        def enrich_declaration(self, declared: Any, _transport_context: Any) -> Any:
            return declared

        @property
        def transport_hooks(self) -> _TransportHooks:
            return _TransportHooks(
                http=_HTTPExtensionHooks(
                    on_protected_request=lambda _decl, _ctx, route_cfg: (
                        received.append(route_cfg) or GrantAccessResult()
                    ),
                )
            )

    server = x402ResourceServer()
    server.register_extension(_RouteAwareExtension())
    route = _route_config({"route-ext": {}})
    http_server = x402HTTPServerBase(server, {"*": route})
    hooks = http_server._collect_protected_request_hooks(route)
    context = HTTPRequestContext(adapter=_Adapter(), method="GET", path="/test")
    hooks[0](context, route)
    assert received == [route]


@pytest.mark.asyncio
async def test_client_extension_on_payment_required_runs_after_manual():
    client = _ClientForHttp()
    http_client = x402HTTPClient(client)  # type: ignore[arg-type]
    order: list[str] = []

    async def manual(_ctx: PaymentRequiredContext) -> None:
        order.append("manual")

    http_client.on_payment_required(manual)
    requirements = PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0xusdc",
        amount="1000",
        pay_to="0xpay",
        max_timeout_seconds=300,
    )
    payment_required = PaymentRequired(
        x402_version=2,
        accepts=[requirements],
        extensions={"cli-ext": {}},
    )
    headers = await http_client.handle_payment_required(payment_required)
    assert order == ["manual"]
    assert headers == {"X-Test": "1"}
