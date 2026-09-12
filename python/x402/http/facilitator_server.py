"""HTTP facilitator server for x402 protocol.

Wraps an x402Facilitator (async or sync) in a FastAPI application that exposes
the standard facilitator endpoints: /supported, /verify, /settle.

This is the server-side counterpart to HTTPFacilitatorClient. While the client
sends requests to a remote facilitator, this module hosts one locally.

Example:
    ```python
    from x402 import x402Facilitator
    from x402.mechanisms.evm.exact import ExactEvmFacilitatorScheme
    from x402.http.facilitator_server import create_facilitator_app

    facilitator = x402Facilitator()
    facilitator.register(
        ["eip155:8453"],
        ExactEvmFacilitatorScheme(wallet=wallet),
    )

    app = create_facilitator_app(facilitator)

    # Run with uvicorn
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8402)
    ```
"""

import asyncio
import json
import logging
from typing import Any

from ..facilitator import x402Facilitator, x402FacilitatorSync
from ..schemas import (
    PaymentPayload,
    PaymentRequirements,
    SchemeNotFoundError,
    SettleResponse,
    SupportedResponse,
    VerifyResponse,
)
from ..schemas.v1 import PaymentPayloadV1, PaymentRequirementsV1

logger = logging.getLogger(__name__)


def _parse_request_body(
    body: dict[str, Any],
) -> tuple[
    int,
    PaymentPayload | PaymentPayloadV1,
    PaymentRequirements | PaymentRequirementsV1,
]:
    """Parse verify/settle request body into typed objects.

    Handles both V1 and V2 protocol versions based on x402Version field.

    Args:
        body: Raw JSON body with x402Version, paymentPayload, paymentRequirements.

    Returns:
        Tuple of (version, payload, requirements).

    Raises:
        ValueError: If body is missing required fields or version is unsupported.
    """
    version = body.get("x402Version")
    if version is None:
        raise ValueError("Missing x402Version in request body")

    raw_payload = body.get("paymentPayload")
    raw_requirements = body.get("paymentRequirements")

    if raw_payload is None or raw_requirements is None:
        raise ValueError("Missing paymentPayload or paymentRequirements in request body")

    if version == 1:
        payload = PaymentPayloadV1.model_validate(raw_payload)
        requirements = PaymentRequirementsV1.model_validate(raw_requirements)
    else:
        payload = PaymentPayload.model_validate(raw_payload)
        requirements = PaymentRequirements.model_validate(raw_requirements)

    return version, payload, requirements


def create_facilitator_app(
    facilitator: x402Facilitator | x402FacilitatorSync,
    *,
    title: str = "x402 Facilitator",
    description: str = "x402 payment verification and settlement service",
    cors_origins: list[str] | None = None,
) -> Any:
    """Create a FastAPI application wrapping an x402 facilitator.

    The returned app exposes the standard facilitator HTTP endpoints:
    - GET  /supported — capability discovery
    - POST /verify    — payment verification
    - POST /settle    — payment settlement
    - GET  /health    — liveness check

    Works with both async (x402Facilitator) and sync (x402FacilitatorSync)
    facilitator instances. Sync facilitators run in a thread pool to avoid
    blocking the event loop.

    Args:
        facilitator: Configured x402Facilitator or x402FacilitatorSync instance.
        title: OpenAPI title for the FastAPI app.
        description: OpenAPI description.
        cors_origins: Optional list of CORS allowed origins. If provided,
            CORSMiddleware is added to the app.

    Returns:
        A FastAPI application ready to serve with uvicorn.

    Raises:
        ImportError: If fastapi is not installed.
    """
    try:
        from fastapi import FastAPI, Request
        from fastapi.responses import JSONResponse
    except ImportError as e:
        raise ImportError(
            "fastapi is required for the facilitator server. "
            "Install with: pip install 'x402[fastapi]'"
        ) from e

    is_async = isinstance(facilitator, x402Facilitator)

    app = FastAPI(title=title, description=description)

    if cors_origins:
        from starlette.middleware.cors import CORSMiddleware

        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_methods=["GET", "POST"],
            allow_headers=["*"],
        )

    @app.get("/supported")
    def get_supported() -> dict[str, Any]:
        """Return supported payment kinds, extensions, and signers."""
        supported: SupportedResponse = facilitator.get_supported()
        return supported.model_dump(by_alias=True, exclude_none=True)

    @app.post("/verify")
    async def verify(request: Request) -> JSONResponse:
        """Verify a payment payload against requirements."""
        try:
            body = await request.json()
        except (json.JSONDecodeError, ValueError):
            return JSONResponse(
                status_code=400,
                content={"error": "Invalid JSON in request body"},
            )

        try:
            _, payload, requirements = _parse_request_body(body)
        except Exception as e:
            return JSONResponse(
                status_code=400,
                content={"error": f"Invalid request: {e}"},
            )

        try:
            if is_async:
                result: VerifyResponse = await facilitator.verify(payload, requirements)
            else:
                result = await asyncio.to_thread(facilitator.verify, payload, requirements)
        except SchemeNotFoundError as e:
            return JSONResponse(
                status_code=400,
                content={"error": f"Unsupported scheme/network: {e}"},
            )
        except Exception as e:
            logger.exception("Verify failed unexpectedly")
            return JSONResponse(
                status_code=500,
                content={"error": f"Internal error: {e}"},
            )

        return JSONResponse(
            content=result.model_dump(by_alias=True, exclude_none=True),
        )

    @app.post("/settle")
    async def settle(request: Request) -> JSONResponse:
        """Settle a verified payment."""
        try:
            body = await request.json()
        except (json.JSONDecodeError, ValueError):
            return JSONResponse(
                status_code=400,
                content={"error": "Invalid JSON in request body"},
            )

        try:
            _, payload, requirements = _parse_request_body(body)
        except Exception as e:
            return JSONResponse(
                status_code=400,
                content={"error": f"Invalid request: {e}"},
            )

        try:
            if is_async:
                result: SettleResponse = await facilitator.settle(payload, requirements)
            else:
                result = await asyncio.to_thread(facilitator.settle, payload, requirements)
        except SchemeNotFoundError as e:
            return JSONResponse(
                status_code=400,
                content={"error": f"Unsupported scheme/network: {e}"},
            )
        except Exception as e:
            logger.exception("Settle failed unexpectedly")
            return JSONResponse(
                status_code=500,
                content={"error": f"Internal error: {e}"},
            )

        return JSONResponse(
            content=result.model_dump(by_alias=True, exclude_none=True),
        )

    @app.get("/health")
    def health() -> dict[str, str]:
        """Liveness check."""
        return {"status": "ok"}

    return app
