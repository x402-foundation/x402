"""Server-side ResourceServerExtension factory for SIWX."""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

from x402.http.types import HTTPTransportContext
from x402.schemas.extensions import ResourceServerExtension
from x402.schemas.hooks import ServerPaymentRequiredContext

from .declare import get_signature_type
from .hooks import CreateSIWxHookOptions, create_siwx_request_hook, create_siwx_settle_hook
from .schema import build_siwx_schema
from .types import SIGN_IN_WITH_X, DeclareSIWxOptions

CreateSIWxResourceServerExtensionOptions = CreateSIWxHookOptions


async def _enrich_siwx_payment_required_response(
    declaration: Any,
    context: ServerPaymentRequiredContext,
) -> dict[str, Any]:
    decl = declaration if isinstance(declaration, dict) else declaration
    opts: DeclareSIWxOptions = decl.get("_options") or DeclareSIWxOptions()

    resource_uri = opts.resource_uri
    if not resource_uri and context.resource_info:
        resource_uri = context.resource_info.url

    domain = opts.domain
    if not domain and resource_uri:
        try:
            domain = urlparse(resource_uri).hostname or ""
        except ValueError:
            domain = ""

    if opts.network:
        supported_networks = opts.network if isinstance(opts.network, list) else [opts.network]
    else:
        supported_networks = list({req.network for req in context.requirements})

    nonce = secrets.token_hex(16)
    issued_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    expiration_time = None
    if opts.expiration_seconds is not None:
        expiration_time = (
            (datetime.now(timezone.utc) + timedelta(seconds=opts.expiration_seconds))
            .isoformat()
            .replace("+00:00", "Z")
        )

    info: dict[str, Any] = {
        "domain": domain or "",
        "uri": resource_uri or "",
        "version": opts.version or "1",
        "nonce": nonce,
        "issuedAt": issued_at,
        "resources": [resource_uri] if resource_uri else None,
    }
    if expiration_time:
        info["expirationTime"] = expiration_time
    if opts.statement:
        info["statement"] = opts.statement

    supported_chains = [
        {"chainId": network, "type": get_signature_type(network)} for network in supported_networks
    ]

    return {
        "info": {k: v for k, v in info.items() if v is not None},
        "supportedChains": supported_chains,
        "schema": build_siwx_schema(),
    }


def create_siwx_resource_server_extension(
    options: CreateSIWxResourceServerExtensionOptions,
) -> ResourceServerExtension:
    """Create a SIWX server extension for registration with x402ResourceServer."""
    settle_hook = create_siwx_settle_hook(options)
    request_hook = create_siwx_request_hook(options)

    class SIWxResourceServerExtension:
        key = SIGN_IN_WITH_X

        def enrich_declaration(self, declaration: Any, transport_context: Any) -> Any:
            return declaration

        async def enrich_payment_required_response(
            self,
            declaration: Any,
            context: ServerPaymentRequiredContext,
        ) -> dict[str, Any] | None:
            return await _enrich_siwx_payment_required_response(declaration, context)

        @property
        def hooks(self) -> _SIWxServerHooks:
            return _SIWxServerHooks(settle_hook=settle_hook)

        @property
        def transport_hooks(self) -> _SIWxServerTransportHooks:
            return _SIWxServerTransportHooks(request_hook=request_hook)

    return SIWxResourceServerExtension()


@dataclass
class _SIWxServerHooks:
    settle_hook: Any

    async def on_after_settle(self, _declaration: Any, context: Any) -> None:
        await self.settle_hook(context)


@dataclass
class _SIWxServerTransportHooks:
    request_hook: Any

    @property
    def http(self) -> _SIWxServerHTTPHooks:
        return _SIWxServerHTTPHooks(self.request_hook)


@dataclass
class _SIWxServerHTTPHooks:
    request_hook: Any

    async def on_protected_request(
        self,
        _declaration: Any,
        transport_context: HTTPTransportContext,
        route_config: Any | None = None,
    ):
        return await self.request_hook(transport_context.request, route_config)
