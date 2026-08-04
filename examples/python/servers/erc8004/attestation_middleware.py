"""Payment middleware with post-settle ERC-8004 interaction attestation."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Request
from fastapi.responses import HTMLResponse, JSONResponse
from starlette.responses import Response

from x402.extensions.erc8004 import (
    attach_interaction_attestation_header,
    create_interaction_attestation,
    set_requirements_agent_id,
)
from x402.http.constants import SETTLEMENT_OVERRIDES_HEADER
from x402.http.facilitator_client_base import FacilitatorResponseError
from x402.http.middleware.fastapi import FastAPIAdapter, _check_if_bazaar_needed, _register_bazaar_extension
from x402.http.types import (
    HTTPRequestContext,
    HTTPTransportContext,
    PaywallConfig,
    RoutesConfig,
)
from x402.http.x402_http_server import PaywallProvider, x402HTTPResourceServer
from x402.schemas import VerifiedPaymentCancelOptions
from x402.server import x402ResourceServer


def _facilitator_error_response(error: FacilitatorResponseError) -> JSONResponse:
    return JSONResponse(content={"error": str(error)}, status_code=502)


def erc8004_payment_middleware(
    routes: RoutesConfig,
    server: x402ResourceServer,
    *,
    agent_owner: Any,
    wrapper_address: str,
    agent_id: int,
    paywall_config: PaywallConfig | None = None,
    paywall_provider: PaywallProvider | None = None,
    sync_facilitator_on_start: bool = True,
) -> Callable[[Request, Callable[[Request], Awaitable[Response]]], Awaitable[Response]]:
    """x402 payment middleware that attaches interaction attestation after settle."""
    if _check_if_bazaar_needed(routes):
        _register_bazaar_extension(server)

    http_server = x402HTTPResourceServer(server, routes)
    if paywall_provider:
        http_server.register_paywall_provider(paywall_provider)

    init_done = False
    init_lock = asyncio.Lock()

    async def middleware(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        nonlocal init_done

        adapter = FastAPIAdapter(request)
        context = HTTPRequestContext(
            adapter=adapter,
            path=request.url.path,
            method=request.method,
            payment_header=(
                adapter.get_header("payment-signature") or adapter.get_header("x-payment")
            ),
        )

        if not http_server.requires_payment(context):
            return await call_next(request)

        if sync_facilitator_on_start and not init_done:
            async with init_lock:
                if not init_done:
                    try:
                        http_server.initialize()
                    except FacilitatorResponseError as error:
                        return _facilitator_error_response(error)
                    init_done = True

        try:
            result = await http_server.process_http_request(context, paywall_config)
        except FacilitatorResponseError as error:
            return _facilitator_error_response(error)

        if result.type == "no-payment-required":
            return await call_next(request)

        if result.type == "payment-error":
            response = result.response
            if response is None:
                return JSONResponse(content={"error": "Payment required"}, status_code=402)
            if response.is_html:
                return HTMLResponse(
                    content=response.body,
                    status_code=response.status,
                    headers=response.headers,
                )
            return JSONResponse(
                content=response.body or {},
                status_code=response.status,
                headers=response.headers,
            )

        if result.type == "payment-verified":
            request.state.payment_payload = result.payment_payload
            request.state.payment_requirements = result.payment_requirements
            dispatcher = result.cancellation_dispatcher
            transport_context = HTTPTransportContext(request=context)

            try:
                response = await call_next(request)
            except Exception as error:
                if dispatcher is not None:
                    await dispatcher.cancel(
                        VerifiedPaymentCancelOptions(reason="handler_threw", error=error)
                    )
                raise

            if response.status_code >= 400:
                if dispatcher is not None:
                    await dispatcher.cancel(
                        VerifiedPaymentCancelOptions(
                            reason="handler_failed",
                            response_status=response.status_code,
                        )
                    )
                return response

            body = b""
            async for chunk in response.body_iterator:
                body += chunk

            overrides = http_server._extract_settlement_overrides(dict(response.headers))
            if overrides is not None:
                for k in list(response.headers.keys()):
                    if k.lower() == SETTLEMENT_OVERRIDES_HEADER.lower():
                        del response.headers[k]

            transport_context.response_headers = dict(response.headers)

            # Source agentId from server config (authoritative), not the client. Stamped
            # into the settle-time requirements only — never sent in the 402.
            set_requirements_agent_id(result.payment_requirements, agent_id)

            try:
                settle_result = await http_server.process_settlement(
                    result.payment_payload,
                    result.payment_requirements,
                    context=context,
                    settlement_overrides=overrides,
                    declared_extensions=result.declared_extensions,
                    transport_context=transport_context,
                )

                if not settle_result.success:
                    resp = settle_result.response
                    if resp is None:
                        return JSONResponse(content={}, status_code=402)
                    if resp.is_html:
                        return Response(
                            content=resp.body,
                            status_code=resp.status,
                            headers=resp.headers,
                            media_type="text/html",
                        )
                    return JSONResponse(
                        content=resp.body or {},
                        status_code=resp.status,
                        headers=resp.headers,
                    )

                from x402.http.constants import PAYMENT_RESPONSE_HEADER, X_PAYMENT_RESPONSE_HEADER
                from x402.http.utils import decode_payment_response_header

                headers = dict(response.headers)
                headers.update(settle_result.headers)

                pay_hdr = headers.get(PAYMENT_RESPONSE_HEADER) or headers.get(
                    X_PAYMENT_RESPONSE_HEADER
                )
                settle_resp = None
                ticket_id_raw = None
                if pay_hdr:
                    try:
                        settle_resp = decode_payment_response_header(pay_hdr)
                        ticket_id_raw = (settle_resp.extensions or {}).get("erc8004", {}).get(
                            "ticketId"
                        )
                    except Exception:
                        pass

                if ticket_id_raw is not None and settle_resp is not None:
                    try:
                        att = create_interaction_attestation(
                            agent_owner,
                            wrapper_address=wrapper_address,
                            requirements=result.payment_requirements,
                            ticket_id=int(ticket_id_raw),
                            method=request.method,
                            url=str(request.url),
                            request_body=b"",
                            response_body=body,
                            response_status=response.status_code,
                        )
                        headers = attach_interaction_attestation_header(headers, att)
                    except Exception:
                        pass  # best-effort per spec — never block the paid 200

                return Response(
                    content=body,
                    status_code=response.status_code,
                    headers=headers,
                    media_type=response.media_type,
                )

            except FacilitatorResponseError as error:
                return _facilitator_error_response(error)
            except Exception:
                return JSONResponse(content={}, status_code=402)

        return await call_next(request)

    return middleware
