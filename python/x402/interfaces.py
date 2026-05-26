"""Scheme protocol definitions for the x402 Python SDK.

This module defines the Protocol interfaces that payment schemes must implement
to integrate with x402Client, x402ResourceServer, and x402Facilitator.

Note: All protocols are sync-first (matching legacy SDK pattern).
"""

from __future__ import annotations

from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Any, Protocol

from .schemas import (
    AssetAmount,
    Network,
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    PaymentRequirementsV1,
    Price,
    ResourceInfo,
    SettleResponse,
    SettleResultContext,
    SupportedKind,
    VerifyResponse,
)
from .schemas.hooks import (
    AbortResult,
    RecoveredSettleResult,
    RecoveredVerifyResult,
    SettleContext,
    SettleFailureContext,
    SkipHandlerResult,
    SkipSettleResult,
    SkipVerifyResult,
    VerifiedPaymentCanceledContext,
    VerifyContext,
    VerifyFailureContext,
    VerifyResultContext,
)

# ============================================================================
# Facilitator Extension Types
# ============================================================================


@dataclass(frozen=True)
class FacilitatorExtension:
    """Base type for extensions registered with x402Facilitator.

    Extensions are stored by key and made available to mechanism implementations
    via FacilitatorContext. Specific extensions subclass this to add capabilities.

    frozen=True makes this hashable so it can be used as a dict key.
    """

    key: str


class FacilitatorContext:
    """Provides access to registered facilitator extensions.

    Passed to SchemeNetworkFacilitator.verify/settle so mechanism implementations
    can retrieve extension-provided capabilities.
    """

    def __init__(self, extensions: dict[str, FacilitatorExtension]) -> None:
        self._extensions = extensions

    def get_extension(self, key: str) -> FacilitatorExtension | None:
        """Get a registered extension by key.

        Args:
            key: The extension key to look up.

        Returns:
            The extension object, or None if not registered.
        """
        return self._extensions.get(key)


# ============================================================================
# Client-Side Protocols
# ============================================================================


class SchemeNetworkClient(Protocol):
    """V2 client-side payment mechanism.

    Implementations create signed payment payloads for specific schemes.
    Returns inner payload dict, which x402Client wraps into full PaymentPayload.

    Example:
        ```python
        class ExactEvmScheme:
            scheme = "exact"

            def __init__(self, signer: ClientEvmSigner):
                self._signer = signer

            def create_payment_payload(
                self, requirements: PaymentRequirements
            ) -> dict[str, Any]:
                # Create EIP-3009 authorization and sign it
                return {"authorization": {...}, "signature": "0x..."}
        ```
    """

    @property
    def scheme(self) -> str:
        """Payment scheme identifier (e.g., 'exact')."""
        ...

    def create_payment_payload(
        self,
        requirements: PaymentRequirements,
    ) -> dict[str, Any]:
        """Create the scheme-specific inner payload dict.

        Args:
            requirements: The payment requirements to fulfill.

        Returns:
            Scheme-specific payload dict. x402Client wraps this into
            a full PaymentPayload with x402_version, accepted, etc.
        """
        ...


class SchemeNetworkClientV1(Protocol):
    """V1 (legacy) client-side payment mechanism.

    Same as SchemeNetworkClient but for V1 protocol format.
    """

    @property
    def scheme(self) -> str:
        """Payment scheme identifier."""
        ...

    def create_payment_payload(
        self,
        requirements: PaymentRequirementsV1,
    ) -> dict[str, Any]:
        """Create the scheme-specific inner payload dict for V1.

        Args:
            requirements: The V1 payment requirements to fulfill.

        Returns:
            Scheme-specific payload dict. x402Client wraps this into
            a full PaymentPayloadV1.
        """
        ...


# ============================================================================
# Server-Side Protocols
# ============================================================================


@dataclass(frozen=True)
class SchemePaymentRequiredContext:
    """Context for scheme enrich_payment_required_response hooks."""

    requirements: list[PaymentRequirements]
    resource_info: ResourceInfo | None
    error: str | None
    payment_required_response: PaymentRequired
    transport_context: Any = None
    payment_payload: PaymentPayload | None = None


class EnrichPaymentRequiredProvider(Protocol):
    """Optional scheme hook to enrich 402 accepts."""

    def enrich_payment_required_response(
        self,
        context: SchemePaymentRequiredContext,
    ) -> list[PaymentRequirements] | None | Awaitable[list[PaymentRequirements] | None]: ...


class EnrichSettlementPayloadProvider(Protocol):
    """Optional scheme hook to enrich settlement payload before facilitator settle."""

    def enrich_settlement_payload(
        self,
        context: SettleContext,
    ) -> dict[str, Any] | None | Awaitable[dict[str, Any] | None]: ...


class EnrichSettlementResponseProvider(Protocol):
    """Optional scheme hook to enrich settlement response extra fields."""

    def enrich_settlement_response(
        self,
        context: SettleResultContext,
    ) -> dict[str, Any] | None | Awaitable[dict[str, Any] | None]: ...


class BeforeVerifyHookProvider(Protocol):
    def before_verify(
        self, context: VerifyContext
    ) -> (
        AbortResult | SkipVerifyResult | None | Awaitable[AbortResult | SkipVerifyResult | None]
    ): ...


class AfterVerifyHookProvider(Protocol):
    def after_verify(
        self, context: VerifyResultContext
    ) -> SkipHandlerResult | None | Awaitable[SkipHandlerResult | None]: ...


class OnVerifyFailureHookProvider(Protocol):
    def on_verify_failure(
        self, context: VerifyFailureContext
    ) -> RecoveredVerifyResult | None | Awaitable[RecoveredVerifyResult | None]: ...


class BeforeSettleHookProvider(Protocol):
    def before_settle(
        self, context: SettleContext
    ) -> (
        AbortResult | SkipSettleResult | None | Awaitable[AbortResult | SkipSettleResult | None]
    ): ...


class AfterSettleHookProvider(Protocol):
    def after_settle(self, context: SettleResultContext) -> None | Awaitable[None]: ...


class OnSettleFailureHookProvider(Protocol):
    def on_settle_failure(
        self,
        context: SettleFailureContext,
    ) -> RecoveredSettleResult | None | Awaitable[RecoveredSettleResult | None]: ...


class OnVerifiedPaymentCanceledHookProvider(Protocol):
    def on_verified_payment_canceled(
        self, context: VerifiedPaymentCanceledContext
    ) -> None | Awaitable[None]: ...


class SchemeNetworkServer(Protocol):
    """V2 server-side payment mechanism.

    Implementations handle price parsing and requirement enhancement for specific schemes.
    Does NOT verify/settle - that's delegated to FacilitatorClient.

    Note: parse_price handles USD→atomic conversion for the scheme.
    This logic lives in the scheme implementation (e.g., EVM), not standalone.

    Example:
        ```python
        class ExactEvmScheme:
            scheme = "exact"

            def parse_price(self, price: Price, network: Network) -> AssetAmount:
                # Convert "$1.50" to {"amount": "1500000", "asset": "0x..."}
                ...

            def enhance_payment_requirements(
                self,
                requirements: PaymentRequirements,
                supported_kind: SupportedKind,
                extensions: list[str],
            ) -> PaymentRequirements:
                # Add EIP-712 domain params to extra
                ...
        ```
    """

    @property
    def scheme(self) -> str:
        """Payment scheme identifier."""
        ...

    def parse_price(self, price: Price, network: Network) -> AssetAmount:
        """Convert Money or AssetAmount to normalized AssetAmount.

        USD→atomic conversion logic lives here, not as a standalone utility.

        Args:
            price: Price as Money ("$1.50", 1.50) or AssetAmount.
            network: Target network.

        Returns:
            Normalized AssetAmount with amount in smallest unit.
        """
        ...

    def enhance_payment_requirements(
        self,
        requirements: PaymentRequirements,
        supported_kind: SupportedKind,
        extensions: list[str],
    ) -> PaymentRequirements:
        """Add scheme-specific fields to payment requirements.

        For EVM, this adds EIP-712 domain parameters (name, version).

        Args:
            requirements: Base payment requirements.
            supported_kind: The supported kind from facilitator.
            extensions: List of enabled extension keys.

        Returns:
            Enhanced payment requirements.
        """
        ...


# ============================================================================
# Facilitator-Side Protocols
# ============================================================================


class SchemeNetworkFacilitator(Protocol):
    """V2 facilitator-side payment mechanism.

    Implementations verify and settle payments for specific schemes.

    Note: Returns VerifyResponse/SettleResponse objects with
    is_valid=False/success=False on failure, not exceptions.

    Example:
        ```python
        class ExactEvmScheme:
            scheme = "exact"
            caip_family = "eip155:*"

            def verify(
                self, payload: PaymentPayload, requirements: PaymentRequirements
            ) -> VerifyResponse:
                # Verify EIP-3009 signature
                ...

            def settle(
                self, payload: PaymentPayload, requirements: PaymentRequirements
            ) -> SettleResponse:
                # Execute transferWithAuthorization
                ...
        ```
    """

    @property
    def scheme(self) -> str:
        """Payment scheme identifier."""
        ...

    @property
    def caip_family(self) -> str:
        """CAIP family pattern (e.g., 'eip155:*' for EVM, 'solana:*' for SVM)."""
        ...

    def get_extra(self, network: Network) -> dict[str, Any] | None:
        """Get extra data for SupportedKind.

        Args:
            network: Target network.

        Returns:
            Extra data (e.g., {"feePayer": addr} for SVM), or None.
        """
        ...

    def get_signers(self, network: Network) -> list[str]:
        """Get signer addresses for this network.

        Args:
            network: Target network.

        Returns:
            List of signer addresses.
        """
        ...

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context: FacilitatorContext | None = None,
    ) -> VerifyResponse:
        """Verify a payment.

        Args:
            payload: Payment payload to verify.
            requirements: Requirements to verify against.
            context: Optional facilitator context with registered extensions.

        Returns:
            VerifyResponse with is_valid=True on success,
            or is_valid=False with invalid_reason on failure.
        """
        ...

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context: FacilitatorContext | None = None,
    ) -> SettleResponse:
        """Settle a payment.

        Args:
            payload: Payment payload to settle.
            requirements: Requirements for settlement.
            context: Optional facilitator context with registered extensions.

        Returns:
            SettleResponse with success=True and transaction on success,
            or success=False with error_reason on failure.
        """
        ...


class SchemeNetworkFacilitatorV1(Protocol):
    """V1 (legacy) facilitator-side payment mechanism.

    Same shape as SchemeNetworkFacilitator but with V1 types.
    """

    @property
    def scheme(self) -> str:
        """Payment scheme identifier."""
        ...

    @property
    def caip_family(self) -> str:
        """CAIP family pattern."""
        ...

    def get_extra(self, network: Network) -> dict[str, Any] | None:
        """Get extra data for SupportedKind."""
        ...

    def get_signers(self, network: Network) -> list[str]:
        """Get signer addresses."""
        ...

    def verify(
        self,
        payload: PaymentPayloadV1,
        requirements: PaymentRequirementsV1,
        context: FacilitatorContext | None = None,
    ) -> VerifyResponse:
        """Verify a V1 payment."""
        ...

    def settle(
        self,
        payload: PaymentPayloadV1,
        requirements: PaymentRequirementsV1,
        context: FacilitatorContext | None = None,
    ) -> SettleResponse:
        """Settle a V1 payment."""
        ...


# Import for type hints
from .schemas.v1 import PaymentPayloadV1  # noqa: E402
