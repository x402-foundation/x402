"""HTTP-based facilitator client for x402 protocol.

Provides both async (HTTPFacilitatorClient) and sync (HTTPFacilitatorClientSync)
implementations for communicating with remote facilitator services.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, TypeVar

from pydantic import ValidationError

from ..schemas import (
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    SupportedResponse,
    VerifyResponse,
)
from ..schemas.v1 import PaymentPayloadV1, PaymentRequirementsV1
from .extension_responses import extract_extension_responses_header, log_extension_responses
from .facilitator_client_base import (
    AuthHeaders,
    AuthProvider,
    CreateHeadersAuthProvider,
    FacilitatorClient,
    FacilitatorClientSync,
    FacilitatorConfig,
    FacilitatorResponseError,
    HTTPFacilitatorClientBase,
)
from .utils import (
    ResponseBodyTooLargeError,
    aread_limited_body,
    read_limited_body,
)

if TYPE_CHECKING:
    import httpx

# Re-export for external use
__all__ = [
    "HTTPFacilitatorClient",
    "HTTPFacilitatorClientSync",
    "FacilitatorConfig",
    "FacilitatorResponseError",
    "FacilitatorClient",
    "FacilitatorClientSync",
    "AuthProvider",
    "AuthHeaders",
    "CreateHeadersAuthProvider",
]

_ResponseModelT = TypeVar(
    "_ResponseModelT",
    VerifyResponse,
    SettleResponse,
    SupportedResponse,
)
_ResponseWithSidechannelT = TypeVar("_ResponseWithSidechannelT", VerifyResponse, SettleResponse)


def _response_excerpt(body: bytes, limit: int = 200) -> str:
    """Build a compact response preview for parse errors."""
    text = body.decode("utf-8", errors="replace").strip()
    if not text:
        return "<empty response>"

    compact = " ".join(text.split())
    if len(compact) <= limit:
        return compact
    return f"{compact[: limit - 3]}..."


def _parse_facilitator_response(
    body: bytes,
    model_cls: type[_ResponseModelT],
    operation: str,
) -> _ResponseModelT:
    """Parse facilitator JSON into a validated response model."""
    try:
        response_data = json.loads(body)
    except (json.JSONDecodeError, ValueError, TypeError) as exc:
        raise FacilitatorResponseError(
            f"Facilitator {operation} returned invalid JSON: {_response_excerpt(body)}"
        ) from exc

    try:
        return model_cls.model_validate(response_data)
    except (ValidationError, ValueError, TypeError) as exc:
        raise FacilitatorResponseError(
            f"Facilitator {operation} returned invalid data: {_response_excerpt(body)}"
        ) from exc


def _decode_error_body(body: bytes) -> str:
    return body.decode("utf-8", errors="replace")


def _read_sync_response_body(response: Any) -> bytes:
    try:
        return read_limited_body(response.iter_bytes())
    except ResponseBodyTooLargeError:
        raise
    except Exception as err:
        raise ValueError("failed to read response body") from err
    finally:
        response.close()


async def _read_async_response_body(response: Any) -> bytes:
    try:
        return await aread_limited_body(response.aiter_bytes())
    except ResponseBodyTooLargeError:
        raise
    except Exception as err:
        raise ValueError("failed to read response body") from err
    finally:
        await response.aclose()


def _attach_extension_responses(
    result: _ResponseWithSidechannelT,
    response: Any,
) -> _ResponseWithSidechannelT:
    """Populate extension_responses from the HTTP sidechannel."""
    header_obj = extract_extension_responses_header(response)
    log_extension_responses(header_obj)
    return result.model_copy(update={"extension_responses": header_obj})


# ============================================================================
# Async HTTP Facilitator Client (Default)
# ============================================================================


class HTTPFacilitatorClient(HTTPFacilitatorClientBase):
    """Async HTTP-based facilitator client.

    Communicates with remote x402 facilitator services over HTTP using
    async httpx.AsyncClient. Use with x402ResourceServer (async).

    Example:
        ```python
        from x402.http import HTTPFacilitatorClient, FacilitatorConfig

        facilitator = HTTPFacilitatorClient(FacilitatorConfig(url="https://..."))

        # In async context
        result = await facilitator.verify(payload, requirements)
        ```
    """

    def _get_sync_client(self) -> httpx.Client:
        """Get or create sync HTTP client for get_supported (initialization)."""
        import httpx

        # Create temporary sync client for initialization
        return httpx.Client(timeout=self._timeout, follow_redirects=True)

    def _get_async_client(self) -> httpx.AsyncClient:
        """Get or create async HTTP client."""
        if self._http_client is None:
            import httpx

            self._http_client = httpx.AsyncClient(timeout=self._timeout, follow_redirects=True)
        return self._http_client

    async def aclose(self) -> None:
        """Close async HTTP client if we own it."""
        if self._owns_client and self._http_client:
            await self._http_client.aclose()
            self._http_client = None

    async def __aenter__(self) -> HTTPFacilitatorClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.aclose()

    # =========================================================================
    # FacilitatorClient Implementation (Async)
    # =========================================================================

    async def verify(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
    ) -> VerifyResponse:
        """Verify a payment with the facilitator (async).

        Args:
            payload: Payment payload to verify.
            requirements: Requirements to verify against.

        Returns:
            VerifyResponse.

        Raises:
            httpx.HTTPError: If request fails.
            ValueError: If response is invalid.
        """
        return await self._verify_http(
            payload.x402_version,
            payload.model_dump(by_alias=True, exclude_none=True),
            requirements.model_dump(by_alias=True, exclude_none=True),
        )

    async def settle(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
    ) -> SettleResponse:
        """Settle a payment with the facilitator (async).

        Args:
            payload: Payment payload to settle.
            requirements: Requirements for settlement.

        Returns:
            SettleResponse.

        Raises:
            httpx.HTTPError: If request fails.
            ValueError: If response is invalid.
        """
        return await self._settle_http(
            payload.x402_version,
            payload.model_dump(by_alias=True, exclude_none=True),
            requirements.model_dump(by_alias=True, exclude_none=True),
        )

    def get_supported(self) -> SupportedResponse:
        """Get supported payment kinds and extensions.

        Note: This is sync because it's called during initialization.

        Returns:
            SupportedResponse.

        Raises:
            httpx.HTTPError: If request fails.
        """
        # Use sync client for initialization (called from sync initialize())
        with self._get_sync_client() as client:
            request = client.build_request(
                "GET",
                f"{self._url}/supported",
                headers=self._get_supported_headers(),
            )
            response = client.send(request, stream=True)
            body = _read_sync_response_body(response)

            if response.status_code != 200:
                raise ValueError(
                    f"Facilitator get_supported failed ({response.status_code}): {_decode_error_body(body)}"
                )

            return _parse_facilitator_response(body, SupportedResponse, "supported")

    # =========================================================================
    # Bytes-Based Methods (Network Boundary)
    # =========================================================================

    async def verify_from_bytes(
        self,
        payload_bytes: bytes,
        requirements_bytes: bytes,
    ) -> VerifyResponse:
        """Verify payment from raw JSON bytes.

        Operates at network boundary - detects version from bytes.

        Args:
            payload_bytes: JSON bytes of payment payload.
            requirements_bytes: JSON bytes of requirements.

        Returns:
            VerifyResponse.
        """
        from ..schemas.helpers import detect_version

        version = detect_version(payload_bytes)
        payload_dict = json.loads(payload_bytes)
        requirements_dict = json.loads(requirements_bytes)

        return await self._verify_http(version, payload_dict, requirements_dict)

    async def settle_from_bytes(
        self,
        payload_bytes: bytes,
        requirements_bytes: bytes,
    ) -> SettleResponse:
        """Settle payment from raw JSON bytes.

        Operates at network boundary - detects version from bytes.

        Args:
            payload_bytes: JSON bytes of payment payload.
            requirements_bytes: JSON bytes of requirements.

        Returns:
            SettleResponse.
        """
        from ..schemas.helpers import detect_version

        version = detect_version(payload_bytes)
        payload_dict = json.loads(payload_bytes)
        requirements_dict = json.loads(requirements_bytes)

        return await self._settle_http(version, payload_dict, requirements_dict)

    # =========================================================================
    # Internal HTTP Methods (Async)
    # =========================================================================

    async def _verify_http(
        self,
        version: int,
        payload_dict: dict[str, Any],
        requirements_dict: dict[str, Any],
    ) -> VerifyResponse:
        """Internal verify via HTTP (async)."""
        client = self._get_async_client()
        request_body = self._build_request_body(version, payload_dict, requirements_dict)
        request = client.build_request(
            "POST",
            f"{self._url}/verify",
            headers=self._get_verify_headers(),
            json=request_body,
        )
        response = await client.send(request, stream=True)
        body = await _read_async_response_body(response)

        if response.status_code != 200:
            raise ValueError(
                f"Facilitator verify failed ({response.status_code}): {_decode_error_body(body)}"
            )

        result = _parse_facilitator_response(body, VerifyResponse, "verify")
        return _attach_extension_responses(result, response)

    async def _settle_http(
        self,
        version: int,
        payload_dict: dict[str, Any],
        requirements_dict: dict[str, Any],
    ) -> SettleResponse:
        """Internal settle via HTTP (async)."""
        client = self._get_async_client()
        request_body = self._build_request_body(version, payload_dict, requirements_dict)
        request = client.build_request(
            "POST",
            f"{self._url}/settle",
            headers=self._get_settle_headers(),
            json=request_body,
        )
        response = await client.send(request, stream=True)
        body = await _read_async_response_body(response)

        if response.status_code != 200:
            raise ValueError(
                f"Facilitator settle failed ({response.status_code}): {_decode_error_body(body)}"
            )

        result = _parse_facilitator_response(body, SettleResponse, "settle")
        return _attach_extension_responses(result, response)


# ============================================================================
# Sync HTTP Facilitator Client
# ============================================================================


class HTTPFacilitatorClientSync(HTTPFacilitatorClientBase):
    """Sync HTTP-based facilitator client.

    Communicates with remote x402 facilitator services over HTTP using
    sync httpx.Client. Use with x402ResourceServerSync (sync).

    Example:
        ```python
        from x402.http import HTTPFacilitatorClientSync, FacilitatorConfig

        facilitator = HTTPFacilitatorClientSync(FacilitatorConfig(url="https://..."))

        # Sync usage
        result = facilitator.verify(payload, requirements)
        ```
    """

    def _get_client(self) -> httpx.Client:
        """Get or create HTTP client."""
        if self._http_client is None:
            import httpx

            self._http_client = httpx.Client(timeout=self._timeout, follow_redirects=True)
        return self._http_client

    def close(self) -> None:
        """Close HTTP client if we own it."""
        if self._owns_client and self._http_client:
            self._http_client.close()
            self._http_client = None

    def __enter__(self) -> HTTPFacilitatorClientSync:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    # =========================================================================
    # FacilitatorClientSync Implementation
    # =========================================================================

    def verify(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
    ) -> VerifyResponse:
        """Verify a payment with the facilitator.

        Args:
            payload: Payment payload to verify.
            requirements: Requirements to verify against.

        Returns:
            VerifyResponse.

        Raises:
            httpx.HTTPError: If request fails.
            ValueError: If response is invalid.
        """
        return self._verify_http(
            payload.x402_version,
            payload.model_dump(by_alias=True, exclude_none=True),
            requirements.model_dump(by_alias=True, exclude_none=True),
        )

    def settle(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
    ) -> SettleResponse:
        """Settle a payment with the facilitator.

        Args:
            payload: Payment payload to settle.
            requirements: Requirements for settlement.

        Returns:
            SettleResponse.

        Raises:
            httpx.HTTPError: If request fails.
            ValueError: If response is invalid.
        """
        return self._settle_http(
            payload.x402_version,
            payload.model_dump(by_alias=True, exclude_none=True),
            requirements.model_dump(by_alias=True, exclude_none=True),
        )

    def get_supported(self) -> SupportedResponse:
        """Get supported payment kinds and extensions.

        Returns:
            SupportedResponse.

        Raises:
            httpx.HTTPError: If request fails.
        """
        client = self._get_client()
        request = client.build_request(
            "GET",
            f"{self._url}/supported",
            headers=self._get_supported_headers(),
        )
        response = client.send(request, stream=True)
        body = _read_sync_response_body(response)

        if response.status_code != 200:
            raise ValueError(
                f"Facilitator get_supported failed ({response.status_code}): {_decode_error_body(body)}"
            )

        return _parse_facilitator_response(body, SupportedResponse, "supported")

    # =========================================================================
    # Bytes-Based Methods (Network Boundary)
    # =========================================================================

    def verify_from_bytes(
        self,
        payload_bytes: bytes,
        requirements_bytes: bytes,
    ) -> VerifyResponse:
        """Verify payment from raw JSON bytes.

        Operates at network boundary - detects version from bytes.

        Args:
            payload_bytes: JSON bytes of payment payload.
            requirements_bytes: JSON bytes of requirements.

        Returns:
            VerifyResponse.
        """
        from ..schemas.helpers import detect_version

        version = detect_version(payload_bytes)
        payload_dict = json.loads(payload_bytes)
        requirements_dict = json.loads(requirements_bytes)

        return self._verify_http(version, payload_dict, requirements_dict)

    def settle_from_bytes(
        self,
        payload_bytes: bytes,
        requirements_bytes: bytes,
    ) -> SettleResponse:
        """Settle payment from raw JSON bytes.

        Operates at network boundary - detects version from bytes.

        Args:
            payload_bytes: JSON bytes of payment payload.
            requirements_bytes: JSON bytes of requirements.

        Returns:
            SettleResponse.
        """
        from ..schemas.helpers import detect_version

        version = detect_version(payload_bytes)
        payload_dict = json.loads(payload_bytes)
        requirements_dict = json.loads(requirements_bytes)

        return self._settle_http(version, payload_dict, requirements_dict)

    # =========================================================================
    # Internal HTTP Methods
    # =========================================================================

    def _verify_http(
        self,
        version: int,
        payload_dict: dict[str, Any],
        requirements_dict: dict[str, Any],
    ) -> VerifyResponse:
        """Internal verify via HTTP."""
        client = self._get_client()
        request_body = self._build_request_body(version, payload_dict, requirements_dict)
        request = client.build_request(
            "POST",
            f"{self._url}/verify",
            headers=self._get_verify_headers(),
            json=request_body,
        )
        response = client.send(request, stream=True)
        body = _read_sync_response_body(response)

        if response.status_code != 200:
            raise ValueError(
                f"Facilitator verify failed ({response.status_code}): {_decode_error_body(body)}"
            )

        result = _parse_facilitator_response(body, VerifyResponse, "verify")
        return _attach_extension_responses(result, response)

    def _settle_http(
        self,
        version: int,
        payload_dict: dict[str, Any],
        requirements_dict: dict[str, Any],
    ) -> SettleResponse:
        """Internal settle via HTTP."""
        client = self._get_client()
        request_body = self._build_request_body(version, payload_dict, requirements_dict)
        request = client.build_request(
            "POST",
            f"{self._url}/settle",
            headers=self._get_settle_headers(),
            json=request_body,
        )
        response = client.send(request, stream=True)
        body = _read_sync_response_body(response)

        if response.status_code != 200:
            raise ValueError(
                f"Facilitator settle failed ({response.status_code}): {_decode_error_body(body)}"
            )

        result = _parse_facilitator_response(body, SettleResponse, "settle")
        return _attach_extension_responses(result, response)
