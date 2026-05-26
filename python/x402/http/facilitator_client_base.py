"""HTTP facilitator client base classes and types.

Contains shared logic for HTTPFacilitatorClient implementations.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

from ..schemas import (
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    SupportedResponse,
    VerifyResponse,
)
from ..schemas.v1 import PaymentPayloadV1, PaymentRequirementsV1
from .constants import DEFAULT_FACILITATOR_URL

if TYPE_CHECKING:
    pass


# ============================================================================
# Auth Provider Protocol
# ============================================================================


@dataclass
class AuthHeaders:
    """Authentication headers for facilitator endpoints."""

    verify: dict[str, str] = field(default_factory=dict)
    settle: dict[str, str] = field(default_factory=dict)
    supported: dict[str, str] = field(default_factory=dict)
    bazaar: dict[str, str] = field(default_factory=dict)


class AuthProvider(Protocol):
    """Generates authentication headers for facilitator requests."""

    def get_auth_headers(self) -> AuthHeaders:
        """Get authentication headers for each endpoint."""
        ...


class CreateHeadersAuthProvider:
    """AuthProvider that wraps a create_headers callable.

    Adapts the dict-style create_headers function (as used by CDP SDK)
    to the AuthProvider protocol.
    """

    def __init__(self, create_headers: Callable[[], dict[str, dict[str, str]]]) -> None:
        self._create_headers = create_headers

    def get_auth_headers(self) -> AuthHeaders:
        """Get authentication headers by calling the create_headers function."""
        result = self._create_headers()
        return AuthHeaders(
            verify=result.get("verify", {}),
            settle=result.get("settle", {}),
            supported=result.get("supported", result.get("list", {})),
            bazaar=result.get("bazaar", {}),
        )


class FacilitatorResponseError(ValueError):
    """Facilitator returned malformed or schema-invalid response data."""


# ============================================================================
# FacilitatorClient Protocols
# ============================================================================


class FacilitatorClient(Protocol):
    """Protocol for async facilitator clients."""

    async def verify(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
    ) -> VerifyResponse:
        """Verify a payment."""
        ...

    async def settle(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
    ) -> SettleResponse:
        """Settle a payment."""
        ...

    def get_supported(self) -> SupportedResponse:
        """Get supported payment kinds (sync - used during initialization)."""
        ...


class FacilitatorClientSync(Protocol):
    """Protocol for sync facilitator clients."""

    def verify(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
    ) -> VerifyResponse:
        """Verify a payment."""
        ...

    def settle(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
    ) -> SettleResponse:
        """Settle a payment."""
        ...

    def get_supported(self) -> SupportedResponse:
        """Get supported payment kinds."""
        ...


# ============================================================================
# Configuration
# ============================================================================


@dataclass
class FacilitatorConfig:
    """Configuration for HTTP facilitator client."""

    url: str = DEFAULT_FACILITATOR_URL
    timeout: float = 30.0
    http_client: Any = None  # Optional httpx.Client or httpx.AsyncClient
    auth_provider: AuthProvider | None = None
    identifier: str | None = None


# ============================================================================
# Base HTTP Facilitator Client
# ============================================================================


class HTTPFacilitatorClientBase:
    """Base class with shared logic for HTTP facilitator clients."""

    def __init__(self, config: FacilitatorConfig | dict[str, Any] | None = None) -> None:
        """Create HTTP facilitator client."""
        if isinstance(config, dict):
            url = config.get("url", DEFAULT_FACILITATOR_URL)
            create_headers = config.get("create_headers")
            auth_provider = CreateHeadersAuthProvider(create_headers) if create_headers else None

            self._url = url.rstrip("/")
            self._timeout = 30.0
            self._auth_provider = auth_provider
            self._identifier = self._url
            self._http_client = None
            self._owns_client = True
        else:
            config = config or FacilitatorConfig()

            self._url = config.url.rstrip("/")
            self._timeout = config.timeout
            self._auth_provider = config.auth_provider
            self._identifier = config.identifier or self._url
            self._http_client = config.http_client
            self._owns_client = config.http_client is None

    @property
    def url(self) -> str:
        """Get facilitator URL."""
        return self._url

    @property
    def identifier(self) -> str:
        """Get facilitator identifier."""
        return self._identifier

    @staticmethod
    def _to_json_safe(obj: Any) -> Any:
        """Convert object to JSON-safe format (handles bigints)."""
        return json.loads(
            json.dumps(
                obj,
                default=lambda x: str(x) if isinstance(x, int) and x > 2**53 else x,
            )
        )

    def _build_request_body(
        self,
        version: int,
        payload_dict: dict[str, Any],
        requirements_dict: dict[str, Any],
    ) -> dict[str, Any]:
        """Build request body for verify/settle."""
        return {
            "x402Version": version,
            "paymentPayload": self._to_json_safe(payload_dict),
            "paymentRequirements": self._to_json_safe(requirements_dict),
        }

    def _get_verify_headers(self) -> dict[str, str]:
        """Get headers for verify request."""
        headers = {"Content-Type": "application/json"}
        if self._auth_provider:
            auth = self._auth_provider.get_auth_headers()
            headers.update(auth.verify)
        return headers

    def _get_settle_headers(self) -> dict[str, str]:
        """Get headers for settle request."""
        headers = {"Content-Type": "application/json"}
        if self._auth_provider:
            auth = self._auth_provider.get_auth_headers()
            headers.update(auth.settle)
        return headers

    def _get_supported_headers(self) -> dict[str, str]:
        """Get headers for supported request."""
        headers = {"Content-Type": "application/json"}
        if self._auth_provider:
            auth = self._auth_provider.get_auth_headers()
            headers.update(auth.supported)
        return headers
