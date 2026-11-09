"""requests e2e test client using x402 v2 SDK."""

import json

from x402.http import decode_payment_response_header
from x402.http.clients import x402_requests
from client import create_e2e_client, run_client_scenario_sync


def main():
    ctx = create_e2e_client(sync=True)
    session = x402_requests(ctx.client)

    def issue_request() -> dict:
        response = session.get(f"{ctx.base_url}{ctx.endpoint_path}")
        response_data = json.loads(response.content.decode())
        result = {
            "success": True,
            "data": response_data,
            "status_code": response.status_code,
            "payment_response": None,
        }
        payment_header = response.headers.get(
            "PAYMENT-RESPONSE"
        ) or response.headers.get("X-PAYMENT-RESPONSE")
        if payment_header:
            payment_response = decode_payment_response_header(payment_header)
            result["payment_response"] = payment_response.model_dump()
            if not payment_response.success:
                result["success"] = False
        return result

    try:
        run_client_scenario_sync(
            ctx,
            issue_request,
            refund=(lambda url: ctx.batch_scheme.refund(url)),
        )
    except Exception as e:
        error_result = {
            "success": False,
            "error": str(e),
            "status_code": getattr(e, "response", {}).get("status_code", None)
            if hasattr(e, "response")
            else None,
        }
        print(json.dumps(error_result))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
