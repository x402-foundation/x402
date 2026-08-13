"""HTTP-based facilitator client for x402 protocol.

Provides both async (HTTPFacilitatorClient) and sync (HTTPFacilitatorClientSync)
implementations for communicating with remote facilitator services.
"""

from __future__ import annotations

import base64
import json
import logging
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


def _response_excerpt(response: Any, limit: int = 200) -> str:
    """Build a compact response preview for parse errors."""
    text = str(getattr(response, "text", "") or "").strip()
    if not text:
        return "<empty response>"

    compact = " ".join(text.split())
    if len(compact) <= limit:
        return compact
    return f"{compact[: limit - 3]}..."


def _parse_facilitator_response(
    response: Any,
    model_cls: type[_ResponseModelT],
    operation: str,
) -> _ResponseModelT:
    """Parse facilitator JSON into a validated response model."""
    try:
        response_data = response.json()
    except (json.JSONDecodeError, ValueError, TypeError) as exc:
        raise FacilitatorResponseError(
            f"Facilitator {operation} returned invalid JSON: {_response_excerpt(response)}"
        ) from exc

    try:
        return model_cls.model_validate(response_data)
    except (ValidationError, ValueError, TypeError) as exc:
        raise FacilitatorResponseError(
            f"Facilitator {operation} returned invalid data: {_response_excerpt(response)}"
        ) from exc


_logger = logging.getLogger("x402")

_EXTENSION_RESPONSE_LOG_FIELD_ALLOWLIST = ["status", "rejectedReason", "reason", "code"]


def _log_extension_responses_header(response: Any) -> None:
    """Read the EXTENSION-RESPONSES header and log allowlisted fields.

    Silently ignores malformed headers.

    Args:
        response: The HTTP response object (httpx.Response).
    """
    header = response.headers.get("EXTENSION-RESPONSES") or response.headers.get(
        "extension-responses"
    )
    if not header:
        return
    try:
        decoded = base64.b64decode(header).decode("utf-8")
        header_extensions: dict[str, Any] = json.loads(decoded)
        if not isinstance(header_extensions, dict):
            return
        sanitized: dict[str, dict[str, Any]] = {}
        for extension_key, payload in header_extensions.items():
            filtered: dict[str, Any] = {}
            if isinstance(payload, dict):
                for field in _EXTENSION_RESPONSE_LOG_FIELD_ALLOWLIST:
                    if field in payload:
                        filtered[field] = payload[field]
            sanitized[extension_key] = filtered
        _logger.info(
            "[x402] extension responses: %s",
            json.dumps(sanitized),
        )
    except Exception:
        pass


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
            response = client.get(
                f"{self._url}/supported",
                headers=self._get_supported_headers(),
            )

            if response.status_code != 200:
                raise ValueError(
                    f"Facilitator get_supported failed ({response.status_code}): {response.text}"
                )

            return _parse_facilitator_response(response, SupportedResponse, "supported")

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

        response = await client.post(
            f"{self._url}/verify",
            headers=self._get_verify_headers(),
            json=request_body,
        )

        if response.status_code != 200:
            raise ValueError(f"Facilitator verify failed ({response.status_code}): {response.text}")

        result = _parse_facilitator_response(response, VerifyResponse, "verify")
        _log_extension_responses_header(response)
        return result

    async def _settle_http(
        self,
        version: int,
        payload_dict: dict[str, Any],
        requirements_dict: dict[str, Any],
    ) -> SettleResponse:
        """Internal settle via HTTP (async)."""
        client = self._get_async_client()
        request_body = self._build_request_body(version, payload_dict, requirements_dict)

        response = await client.post(
            f"{self._url}/settle",
            headers=self._get_settle_headers(),
            json=request_body,
        )

        if response.status_code != 200:
            raise ValueError(f"Facilitator settle failed ({response.status_code}): {response.text}")

        result = _parse_facilitator_response(response, SettleResponse, "settle")
        _log_extension_responses_header(response)
        return result


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

        response = client.get(
            f"{self._url}/supported",
            headers=self._get_supported_headers(),
        )

        if response.status_code != 200:
            raise ValueError(
                f"Facilitator get_supported failed ({response.status_code}): {response.text}"
            )

        return _parse_facilitator_response(response, SupportedResponse, "supported")

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

        response = client.post(
            f"{self._url}/verify",
            headers=self._get_verify_headers(),
            json=request_body,
        )

        if response.status_code != 200:
            raise ValueError(f"Facilitator verify failed ({response.status_code}): {response.text}")

        result = _parse_facilitator_response(response, VerifyResponse, "verify")
        _log_extension_responses_header(response)
        return result

    def _settle_http(
        self,
        version: int,
        payload_dict: dict[str, Any],
        requirements_dict: dict[str, Any],
    ) -> SettleResponse:
        """Internal settle via HTTP."""
        client = self._get_client()
        request_body = self._build_request_body(version, payload_dict, requirements_dict)

        response = client.post(
            f"{self._url}/settle",
            headers=self._get_settle_headers(),
            json=request_body,
        )

        if response.status_code != 200:
            raise ValueError(f"Facilitator settle failed ({response.status_code}): {response.text}")

        result = _parse_facilitator_response(response, SettleResponse, "settle")
        _log_extension_responses_header(response)
        return result
