"""MCP E2E Test Client with x402 Payment Support.

Thin MCP transport over the same multi-network `x402Client` the HTTP
clients share (see `client.py`): connects to the MCP server over SSE,
calls the tool named by `ENDPOINT_PATH` with no arguments, and outputs a
structured JSON result for the e2e test framework to parse.
"""

from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import dataclass, field
from typing import Any

from client import create_e2e_client, run_client_scenario


def _parse_tool_data(content: list[Any]) -> Any:
    """Parse the first content item of an MCP tool result into response body JSON."""
    if not content:
        return None
    first = content[0]
    text = first.get("text") if isinstance(first, dict) else getattr(first, "text", None)
    if text is None:
        return first
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return {"text": text}


@dataclass
class _McpFetchResponse:
    """Duck-typed stand-in for `refund_channel`'s `_RefundResponse` (status + headers)."""

    status: int
    headers: dict[str, str] = field(default_factory=dict)

    def header(self, name: str) -> str | None:
        return self.headers.get(name)


async def main() -> None:
    from x402.http import (
        decode_payment_signature_header,
        encode_payment_required_header,
        encode_payment_response_header,
    )
    from x402.mcp import create_x402_mcp_client
    from x402.mcp.constants import MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY
    from x402.mcp.utils import convert_mcp_result, extract_payment_required_from_result
    from x402.mechanisms.evm.batch_settlement.client import RefundOptions

    ctx = create_e2e_client()
    tool_name = ctx.endpoint_path
    tool_resource_url = f"mcp://tool/{tool_name}"

    async with create_x402_mcp_client(ctx.client, ctx.base_url, auto_payment=True) as mcp:
        loop = asyncio.get_running_loop()
        raw_session = mcp._session  # underlying `mcp.ClientSession`; no separate connection needed

        async def issue_request() -> dict[str, Any]:
            result = await mcp.call_tool(tool_name, {})
            payment_response = result.payment_response
            return {
                "success": not result.is_error,
                "data": _parse_tool_data(result.content),
                "status_code": 402 if result.is_error else 200,
                "payment_response": (
                    payment_response.model_dump(by_alias=True)
                    if hasattr(payment_response, "model_dump")
                    else payment_response
                ),
            }

        def mcp_refund_fetch(url: str, headers: dict[str, str]) -> _McpFetchResponse:
            """Bridges `BatchSettlementEvmScheme.refund()`'s sync HTTP `fetch` dependency
            onto MCP tool calls, so the same cooperative-refund flow used by the HTTP
            clients works unmodified over the MCP transport. Runs on the refund's worker
            thread (via `asyncio.to_thread`), so async MCP calls are scheduled back onto
            the main event loop with `run_coroutine_threadsafe`.
            """

            async def do_fetch() -> _McpFetchResponse:
                payment_header = headers.get("PAYMENT-SIGNATURE")
                if not payment_header:
                    probe = await raw_session.call_tool(name=tool_name, arguments={})
                    if not probe.isError:
                        return _McpFetchResponse(status=200)
                    payment_required = extract_payment_required_from_result(
                        convert_mcp_result(probe)
                    )
                    if payment_required is None:
                        return _McpFetchResponse(status=200)
                    return _McpFetchResponse(
                        status=402,
                        headers={"PAYMENT-REQUIRED": encode_payment_required_header(payment_required)},
                    )

                payment_payload = decode_payment_signature_header(payment_header)
                result = await raw_session.call_tool(
                    name=tool_name,
                    arguments={},
                    meta={
                        MCP_PAYMENT_META_KEY: payment_payload.model_dump(
                            by_alias=True, exclude_none=True
                        )
                    },
                )

                settle_data = (dict(result.meta) if result.meta else {}).get(
                    MCP_PAYMENT_RESPONSE_META_KEY
                )
                if settle_data is not None:
                    from x402.schemas import SettleResponse

                    settle_response = SettleResponse(**settle_data)
                    return _McpFetchResponse(
                        status=200,
                        headers={
                            "PAYMENT-RESPONSE": encode_payment_response_header(settle_response)
                        },
                    )

                if result.isError:
                    payment_required = extract_payment_required_from_result(
                        convert_mcp_result(result)
                    )
                    if payment_required is not None:
                        return _McpFetchResponse(
                            status=402,
                            headers={
                                "PAYMENT-REQUIRED": encode_payment_required_header(
                                    payment_required
                                )
                            },
                        )

                return _McpFetchResponse(status=500 if result.isError else 200)

            future = asyncio.run_coroutine_threadsafe(do_fetch(), loop)
            return future.result()

        async def refund(_url: str) -> Any:
            options = RefundOptions(fetch=mcp_refund_fetch)
            return await asyncio.to_thread(ctx.batch_scheme.refund, tool_resource_url, options)

        await run_client_scenario(ctx, issue_request, refund=refund)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except SystemExit:
        raise
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e), "status_code": 500}))
        sys.exit(1)
