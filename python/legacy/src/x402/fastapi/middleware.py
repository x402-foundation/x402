import base64
import json
import logging
from typing import Any, Callable, Optional, get_args, cast

from fastapi import Request
from fastapi.responses import JSONResponse, HTMLResponse
from pydantic import validate_call

from x402.common import (
    process_price_to_atomic_amount,
    x402_VERSION,
    find_matching_payment_requirements,
)
from x402.encoding import safe_base64_decode
from x402.facilitator import FacilitatorClient, FacilitatorConfig
from x402.path import path_is_match
from x402.paywall import is_browser_request, get_paywall_html
from x402.types import (
    PaymentPayload,
    PaymentRequirements,
    Price,
    x402PaymentRequiredResponse,
    PaywallConfig,
    SupportedNetworks,
    HTTPInputSchema,
)

logger = logging.getLogger(__name__)


@validate_call
def require_payment(
    price: Price,
    pay_to_address: str,
    path: str | list[str] = "*",
    description: str = "",
    mime_type: str = "",
    max_deadline_seconds: int = 60,
    input_schema: Optional[HTTPInputSchema] = None,
    output_schema: Optional[Any] = None,
    discoverable: Optional[bool] = True,
    facilitator_config: Optional[FacilitatorConfig] = None,
    network: str = "base-sepolia",
    resource: Optional[str] = None,
    paywall_config: Optional[PaywallConfig] = None,
    custom_paywall_html: Optional[str] = None,
):
    """Generate a FastAPI middleware that gates payments for an endpoint.

    Args:
        price (Price): Payment price. Can be:
            - Money: USD amount as string/int (e.g., "$3.10", 0.10, "0.001") - defaults to USDC
            - TokenAmount: Custom token amount with asset information
        pay_to_address (str): Ethereum address to receive the payment
        path (str | list[str], optional): Path to gate with payments. Defaults to "*" for all paths.
        description (str, optional): Description of what is being purchased. Defaults to "".
        mime_type (str, optional): MIME type of the resource. Defaults to "".
        max_deadline_seconds (int, optional): Maximum time allowed for payment. Defaults to 60.
        input_schema (Optional[HTTPInputSchema], optional): Schema for the request structure. Defaults to None.
        output_schema (Optional[Any], optional): Schema for the response. Defaults to None.
        discoverable (bool, optional): Whether the route is discoverable. Defaults to True.
        facilitator_config (Optional[Dict[str, Any]], optional): Configuration for the payment facilitator.
            If not provided, defaults to the public x402.org facilitator.
        network (str, optional): Ethereum network ID. Defaults to "base-sepolia" (Base Sepolia testnet).
        resource (Optional[str], optional): Resource URL. Defaults to None (uses request URL).
        paywall_config (Optional[PaywallConfig], optional): Configuration for paywall UI customization.
            Includes options like app_name, app_logo.
        custom_paywall_html (Optional[str], optional): Custom HTML to display for paywall instead of default.

    Returns:
        Callable: FastAPI middleware function that checks for valid payment before processing requests
    """

    # Validate network is supported
    supported_networks = get_args(SupportedNetworks)
    if network not in supported_networks:
        raise ValueError(
            f"Unsupported network: {network}. Must be one of: {supported_networks}"
        )

    try:
        max_amount_required, asset_address, eip712_domain = (
            process_price_to_atomic_amount(price, network)
        )
    except Exception as e:
        raise ValueError(f"Invalid price: {price}. Error: {e}")

    facilitator = FacilitatorClient(facilitator_config)

    async def middleware(request: Request, call_next: Callable):
        # Skip if the path is not the same as the path in the middleware
        if not path_is_match(path, request.url.path):
            return await call_next(request)

        # Get resource URL if not explicitly provided
        resource_url = resource or str(request.url)

        # Construct payment details
        payment_requirements = [
            PaymentRequirements(
                scheme="exact",
                network=cast(SupportedNetworks, network),
                asset=asset_address,
                max_amount_required=max_amount_required,
                resource=resource_url,
                description=description,
                mime_type=mime_type,
                pay_to=pay_to_address,
                max_timeout_seconds=max_deadline_seconds,
                # TODO: Rename output_schema to request_structure
                output_schema={
                    "input": {
                        "type": "http",
                        "method": request.method.upper(),
                        "discoverable": discoverable
                        if discoverable is not None
                        else True,
                        **(
                            input_schema.model_dump(exclude_none=True)
                            if input_schema
                            else {}
                        ),
                    },
                    "output": output_schema,
                },
                extra=eip712_domain,
            )
        ]

        def x402_response(error: str):
            """Create a 402 response with payment requirements."""
            request_headers = dict(request.headers)
            status_code = 402

            if is_browser_request(request_headers):
                html_content = custom_paywall_html or get_paywall_html(
                    error, payment_requirements, paywall_config
                )
                headers = {"Content-Type": "text/html; charset=utf-8"}

                return HTMLResponse(
                    content=html_content,
                    status_code=status_code,
                    headers=headers,
                )
            else:
                response_data = x402PaymentRequiredResponse(
                    x402_version=x402_VERSION,
                    accepts=payment_requirements,
                    error=error,
                ).model_dump(by_alias=True)
                headers = {"Content-Type": "application/json"}

                return JSONResponse(
                    content=response_data,
                    status_code=status_code,
                    headers=headers,
                )

        # Check for payment header
        payment_header = request.headers.get("X-PAYMENT", "")

        if payment_header == "":
            return x402_response("No X-PAYMENT header provided")

        # Decode payment header
        try:
            payment_dict = json.loads(safe_base64_decode(payment_header))
            payment = PaymentPayload(**payment_dict)
        except Exception as e:
            logger.warning(
                f"Invalid payment header format from {request.client.host if request.client else 'unknown'}: {str(e)}"
            )
            return x402_response("Invalid payment header format")

        # Find matching payment requirements
        selected_payment_requirements = find_matching_payment_requirements(
            payment_requirements, payment
        )

        if not selected_payment_requirements:
            return x402_response("No matching payment requirements found")

        # Verify payment
        verify_response = await facilitator.verify(
            payment, selected_payment_requirements
        )

        if not verify_response.is_valid:
            error_reason = verify_response.invalid_reason or "Unknown error"
            return x402_response(f"Invalid payment: {error_reason}")

        request.state.payment_details = selected_payment_requirements
        request.state.verify_response = verify_response

        # Process the request
        response = await call_next(request)

        # Early return without settling if the response is not a 2xx
        if response.status_code < 200 or response.status_code >= 300:
            return response

        # Settle the payment
        try:
            settle_response = await facilitator.settle(
                payment, selected_payment_requirements
            )
            if settle_response.success:
                response.headers["X-PAYMENT-RESPONSE"] = base64.b64encode(
                    settle_response.model_dump_json(by_alias=True).encode("utf-8")
                ).decode("utf-8")
            else:
                return x402_response(
                    "Settle failed: "
                    + (settle_response.error_reason or "Unknown error")
                )
        except Exception:
            return x402_response("Settle failed")

        return response

    return middleware
