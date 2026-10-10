"""httpx e2e test client using x402 v2 SDK."""

import asyncio
import json
import logging

import httpx
from client import create_e2e_client, refund_batch_channel, run_client_scenario

from x402.http import decode_payment_response_header
from x402.http.clients import x402_httpx_transport

logging.basicConfig(
    level=logging.INFO,
    format="%(name)s %(levelname)s: %(message)s",
    stream=__import__("sys").stderr,
)
logging.getLogger("x402.signers").setLevel(logging.DEBUG)
logging.getLogger("x402.permit2").setLevel(logging.DEBUG)


async def main():
    ctx = create_e2e_client()
    timeout = httpx.Timeout(30.0, connect=10.0)
    async with httpx.AsyncClient(
        base_url=ctx.base_url,
        timeout=timeout,
        transport=x402_httpx_transport(ctx.client),
    ) as http_client:

        async def issue_request() -> dict:
            response = await http_client.get(ctx.endpoint_path)
            response_data = json.loads(response.content.decode())
            result = {
                "success": 200 <= response.status_code < 300,
                "data": response_data,
                "status_code": response.status_code,
                "payment_response": None,
            }
            payment_header = response.headers.get("PAYMENT-RESPONSE") or response.headers.get(
                "X-PAYMENT-RESPONSE"
            )
            if payment_header:
                payment_response = decode_payment_response_header(payment_header)
                result["payment_response"] = payment_response.model_dump()
                if not payment_response.success:
                    result["success"] = False
            return result

        async def refund(url: str):
            return await asyncio.to_thread(refund_batch_channel, ctx, url)

        try:
            await run_client_scenario(ctx, issue_request, refund=refund)
        except Exception as e:
            error_result = {
                "success": False,
                "error": str(e),
                "status_code": getattr(getattr(e, "response", None), "status_code", None),
            }
            print(json.dumps(error_result))
            raise SystemExit(1) from e


if __name__ == "__main__":
    asyncio.run(main())
