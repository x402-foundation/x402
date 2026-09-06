"""x402Facilitator base classes and internal types.

Contains shared logic for facilitator implementations.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Generator
from dataclasses import dataclass
from typing import Any, Generic, Literal, TypeVar

from .interfaces import (
    FacilitatorContext,
    FacilitatorExtension,
    SchemeNetworkFacilitator,
    SchemeNetworkFacilitatorV1,
)
from .schemas import (
    AbortResult,
    Network,
    PaymentPayload,
    PaymentPayloadV1,
    PaymentRequirements,
    PaymentRequirementsV1,
    RecoveredSettleResult,
    RecoveredVerifyResult,
    SchemeNotFoundError,
    SettleContext,
    SettleFailureContext,
    SettleResponse,
    SettleResultContext,
    SupportedKind,
    SupportedResponse,
    VerifyContext,
    VerifyFailureContext,
    VerifyResponse,
    VerifyResultContext,
    derive_network_pattern,
    matches_network_pattern,
)

# ============================================================================
# Type Aliases - Support both sync and async hooks
# ============================================================================

T = TypeVar("T")

BeforeVerifyHook = Callable[[VerifyContext], Awaitable[AbortResult | None] | AbortResult | None]
AfterVerifyHook = Callable[[VerifyResultContext], Awaitable[None] | None]
OnVerifyFailureHook = Callable[
    [VerifyFailureContext],
    Awaitable[RecoveredVerifyResult | None] | RecoveredVerifyResult | None,
]

BeforeSettleHook = Callable[[SettleContext], Awaitable[AbortResult | None] | AbortResult | None]
AfterSettleHook = Callable[[SettleResultContext], Awaitable[None] | None]
OnSettleFailureHook = Callable[
    [SettleFailureContext],
    Awaitable[RecoveredSettleResult | None] | RecoveredSettleResult | None,
]

# Sync-only hook types (for sync class)
SyncBeforeVerifyHook = Callable[[VerifyContext], AbortResult | None]
SyncAfterVerifyHook = Callable[[VerifyResultContext], None]
SyncOnVerifyFailureHook = Callable[[VerifyFailureContext], RecoveredVerifyResult | None]

SyncBeforeSettleHook = Callable[[SettleContext], AbortResult | None]
SyncAfterSettleHook = Callable[[SettleResultContext], None]
SyncOnSettleFailureHook = Callable[[SettleFailureContext], RecoveredSettleResult | None]

# Hook command type for generator-based implementation
HookPhase = Literal["before", "after", "failure"]
HookCommand = tuple[HookPhase, Any, Any]  # (phase, hook, context)


# ============================================================================
# Internal Types
# ============================================================================


@dataclass
class SchemeData(Generic[T]):
    """Internal storage for registered schemes."""

    facilitator: T
    networks: set[Network]
    pattern: Network  # Wildcard like "eip155:*"


# ============================================================================
# Base Facilitator Class (Shared Logic)
# ============================================================================


class x402FacilitatorBase:
    """Base class with shared logic for x402 facilitators.

    Contains registration, routing, and get_supported logic.
    Subclasses implement sync/async verify/settle methods.
    """

    def __init__(self) -> None:
        """Initialize base facilitator."""
        self._schemes: list[SchemeData[SchemeNetworkFacilitator]] = []
        self._schemes_v1: list[SchemeData[SchemeNetworkFacilitatorV1]] = []
        self._extensions: dict[str, FacilitatorExtension] = {}

        # Hooks (typed in subclasses)
        self._before_verify_hooks: list[Any] = []
        self._after_verify_hooks: list[Any] = []
        self._on_verify_failure_hooks: list[Any] = []

        self._before_settle_hooks: list[Any] = []
        self._after_settle_hooks: list[Any] = []
        self._on_settle_failure_hooks: list[Any] = []

    # ========================================================================
    # Registration
    # ========================================================================

    def register(
        self,
        networks: list[Network],
        facilitator: SchemeNetworkFacilitator,
    ) -> x402FacilitatorBase:
        """Register a V2 facilitator for one or more networks.

        Args:
            networks: List of networks to register for.
            facilitator: Scheme facilitator implementation.

        Returns:
            Self for chaining.
        """
        pattern = derive_network_pattern(networks)
        self._schemes.append(
            SchemeData(
                facilitator=facilitator,
                networks=set(networks),
                pattern=pattern,
            )
        )
        return self

    def register_v1(
        self,
        networks: list[Network],
        facilitator: SchemeNetworkFacilitatorV1,
    ) -> x402FacilitatorBase:
        """Register a V1 facilitator for one or more networks.

        Args:
            networks: List of networks to register for.
            facilitator: V1 scheme facilitator implementation.

        Returns:
            Self for chaining.
        """
        pattern = derive_network_pattern(networks)
        self._schemes_v1.append(
            SchemeData(
                facilitator=facilitator,
                networks=set(networks),
                pattern=pattern,
            )
        )
        return self

    def register_extension(self, extension: FacilitatorExtension) -> x402FacilitatorBase:
        """Register a facilitator extension.

        Args:
            extension: FacilitatorExtension object with a key property.

        Returns:
            Self for chaining.
        """
        self._extensions[extension.key] = extension
        return self

    def get_extension(self, key: str) -> FacilitatorExtension | None:
        """Get a registered extension by key.

        Args:
            key: The extension key to look up.

        Returns:
            The extension object, or None if not registered.
        """
        return self._extensions.get(key)

    # ========================================================================
    # Supported
    # ========================================================================

    def get_supported(self) -> SupportedResponse:
        """Get supported payment kinds and extensions.

        Returns:
            SupportedResponse with kinds, extensions, and signers.
        """
        kinds: list[SupportedKind] = []
        signers: dict[str, list[str]] = {}

        # V2 schemes
        for scheme_data in self._schemes:
            facilitator = scheme_data.facilitator

            for network in scheme_data.networks:
                kinds.append(
                    SupportedKind(
                        x402_version=2,
                        scheme=facilitator.scheme,
                        network=network,
                        extra=facilitator.get_extra(network),
                    )
                )

                # Collect signers by CAIP family
                caip_family = facilitator.caip_family
                network_signers = facilitator.get_signers(network)
                if caip_family not in signers:
                    signers[caip_family] = []
                for signer in network_signers:
                    if signer not in signers[caip_family]:
                        signers[caip_family].append(signer)

        # V1 schemes
        for scheme_data in self._schemes_v1:
            facilitator = scheme_data.facilitator

            for network in scheme_data.networks:
                kinds.append(
                    SupportedKind(
                        x402_version=1,
                        scheme=facilitator.scheme,
                        network=network,
                        extra=facilitator.get_extra(network),
                    )
                )

                # Collect signers
                caip_family = facilitator.caip_family
                network_signers = facilitator.get_signers(network)
                if caip_family not in signers:
                    signers[caip_family] = []
                for signer in network_signers:
                    if signer not in signers[caip_family]:
                        signers[caip_family].append(signer)

        return SupportedResponse(
            kinds=kinds,
            extensions=list(self._extensions.keys()),
            signers=signers,
        )

    def get_extensions(self) -> list[str]:
        """Get registered extension keys.

        Returns:
            List of extension key strings.
        """
        return list(self._extensions.keys())

    # ========================================================================
    # Internal Helpers
    # ========================================================================

    def _find_facilitator(
        self,
        scheme: str,
        network: Network,
    ) -> SchemeNetworkFacilitator | None:
        """Find V2 facilitator for scheme/network."""
        for scheme_data in self._schemes:
            if scheme_data.facilitator.scheme != scheme:
                continue

            # Check if network matches
            if network in scheme_data.networks:
                return scheme_data.facilitator

            # Check wildcard pattern
            if matches_network_pattern(network, scheme_data.pattern):
                return scheme_data.facilitator

        return None

    def _find_facilitator_v1(
        self,
        scheme: str,
        network: Network,
    ) -> SchemeNetworkFacilitatorV1 | None:
        """Find V1 facilitator for scheme/network."""
        for scheme_data in self._schemes_v1:
            if scheme_data.facilitator.scheme != scheme:
                continue

            # Check if network matches
            if network in scheme_data.networks:
                return scheme_data.facilitator

            # Check wildcard pattern
            if matches_network_pattern(network, scheme_data.pattern):
                return scheme_data.facilitator

        return None

    def _build_facilitator_context(self) -> FacilitatorContext:
        """Build a FacilitatorContext from the registered extensions."""
        return FacilitatorContext(self._extensions)

    def _verify_v2(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> VerifyResponse:
        """Verify V2 payment."""
        scheme = payload.get_scheme()
        network = payload.get_network()

        facilitator = self._find_facilitator(scheme, network)
        if facilitator is None:
            raise SchemeNotFoundError(scheme, network)

        return facilitator.verify(payload, requirements, self._build_facilitator_context())

    def _verify_v1(
        self,
        payload: PaymentPayloadV1,
        requirements: PaymentRequirementsV1,
    ) -> VerifyResponse:
        """Verify V1 payment."""
        scheme = payload.get_scheme()
        network = payload.get_network()

        facilitator = self._find_facilitator_v1(scheme, network)
        if facilitator is None:
            raise SchemeNotFoundError(scheme, network)

        return facilitator.verify(payload, requirements, self._build_facilitator_context())

    def _settle_v2(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> SettleResponse:
        """Settle V2 payment."""
        scheme = payload.get_scheme()
        network = payload.get_network()

        facilitator = self._find_facilitator(scheme, network)
        if facilitator is None:
            raise SchemeNotFoundError(scheme, network)

        return facilitator.settle(payload, requirements, self._build_facilitator_context())

    def _settle_v1(
        self,
        payload: PaymentPayloadV1,
        requirements: PaymentRequirementsV1,
    ) -> SettleResponse:
        """Settle V1 payment."""
        scheme = payload.get_scheme()
        network = payload.get_network()

        facilitator = self._find_facilitator_v1(scheme, network)
        if facilitator is None:
            raise SchemeNotFoundError(scheme, network)

        return facilitator.settle(payload, requirements, self._build_facilitator_context())

    # ========================================================================
    # Core Logic Generators (shared between async/sync)
    # ========================================================================

    def _verify_core(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
        payload_bytes: bytes | None,
        requirements_bytes: bytes | None,
    ) -> Generator[HookCommand, Any, VerifyResponse]:
        """Core verify logic as generator.

        Yields (phase, hook, context) tuples for hook execution.
        The caller drives the generator and handles sync/async execution.

        Args:
            payload: Payment payload to verify.
            requirements: Requirements to verify against.
            payload_bytes: Raw payload bytes (escape hatch).
            requirements_bytes: Raw requirements bytes (escape hatch).

        Yields:
            HookCommand tuples: (phase, hook, context)

        Returns:
            VerifyResponse with verification result.
        """
        context = VerifyContext(
            payment_payload=payload,
            requirements=requirements,
            payload_bytes=payload_bytes,
            requirements_bytes=requirements_bytes,
        )

        # Execute before hooks
        for hook in self._before_verify_hooks:
            result = yield ("before", hook, context)
            if isinstance(result, AbortResult):
                from .schemas import PaymentAbortedError

                raise PaymentAbortedError(result.reason)

        try:
            # Route by version
            if payload.x402_version == 1:
                verify_result = self._verify_v1(
                    payload,  # type: ignore[arg-type]
                    requirements,  # type: ignore[arg-type]
                )
            else:
                verify_result = self._verify_v2(
                    payload,  # type: ignore[arg-type]
                    requirements,  # type: ignore[arg-type]
                )

            # Check if verification failed
            if not verify_result.is_valid:
                failure_context = VerifyFailureContext(
                    payment_payload=payload,
                    requirements=requirements,
                    payload_bytes=payload_bytes,
                    requirements_bytes=requirements_bytes,
                    error=Exception(verify_result.invalid_reason or "Verification failed"),
                )
                for hook in self._on_verify_failure_hooks:
                    result = yield ("failure", hook, failure_context)
                    if isinstance(result, RecoveredVerifyResult):
                        # Execute after hooks with recovered result
                        result_context = VerifyResultContext(
                            payment_payload=payload,
                            requirements=requirements,
                            payload_bytes=payload_bytes,
                            requirements_bytes=requirements_bytes,
                            result=result.result,
                        )
                        for after_hook in self._after_verify_hooks:
                            yield ("after", after_hook, result_context)
                        return result.result

                return verify_result

            # Execute after hooks for success
            result_context = VerifyResultContext(
                payment_payload=payload,
                requirements=requirements,
                payload_bytes=payload_bytes,
                requirements_bytes=requirements_bytes,
                result=verify_result,
            )
            for hook in self._after_verify_hooks:
                yield ("after", hook, result_context)

            return verify_result

        except Exception as e:
            # Execute failure hooks
            failure_context = VerifyFailureContext(
                payment_payload=payload,
                requirements=requirements,
                payload_bytes=payload_bytes,
                requirements_bytes=requirements_bytes,
                error=e,
            )
            for hook in self._on_verify_failure_hooks:
                result = yield ("failure", hook, failure_context)
                if isinstance(result, RecoveredVerifyResult):
                    return result.result

            raise

    def _settle_core(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
        payload_bytes: bytes | None,
        requirements_bytes: bytes | None,
    ) -> Generator[HookCommand, Any, SettleResponse]:
        """Core settle logic as generator.

        Yields (phase, hook, context) tuples for hook execution.
        The caller drives the generator and handles sync/async execution.

        Args:
            payload: Payment payload to settle.
            requirements: Requirements for settlement.
            payload_bytes: Raw payload bytes (escape hatch).
            requirements_bytes: Raw requirements bytes (escape hatch).

        Yields:
            HookCommand tuples: (phase, hook, context)

        Returns:
            SettleResponse with settlement result.
        """
        context = SettleContext(
            payment_payload=payload,
            requirements=requirements,
            payload_bytes=payload_bytes,
            requirements_bytes=requirements_bytes,
        )

        # Execute before hooks
        for hook in self._before_settle_hooks:
            result = yield ("before", hook, context)
            if isinstance(result, AbortResult):
                from .schemas import PaymentAbortedError

                raise PaymentAbortedError(result.reason)

        try:
            # Route by version
            if payload.x402_version == 1:
                settle_result = self._settle_v1(
                    payload,  # type: ignore[arg-type]
                    requirements,  # type: ignore[arg-type]
                )
            else:
                settle_result = self._settle_v2(
                    payload,  # type: ignore[arg-type]
                    requirements,  # type: ignore[arg-type]
                )

            # Check if settlement failed
            if not settle_result.success:
                failure_context = SettleFailureContext(
                    payment_payload=payload,
                    requirements=requirements,
                    payload_bytes=payload_bytes,
                    requirements_bytes=requirements_bytes,
                    error=Exception(settle_result.error_reason or "Settlement failed"),
                )
                for hook in self._on_settle_failure_hooks:
                    result = yield ("failure", hook, failure_context)
                    if isinstance(result, RecoveredSettleResult):
                        # Execute after hooks with recovered result
                        result_context = SettleResultContext(
                            payment_payload=payload,
                            requirements=requirements,
                            payload_bytes=payload_bytes,
                            requirements_bytes=requirements_bytes,
                            result=result.result,
                        )
                        for after_hook in self._after_settle_hooks:
                            yield ("after", after_hook, result_context)
                        return result.result

                return settle_result

            # Execute after hooks for success
            result_context = SettleResultContext(
                payment_payload=payload,
                requirements=requirements,
                payload_bytes=payload_bytes,
                requirements_bytes=requirements_bytes,
                result=settle_result,
            )
            for hook in self._after_settle_hooks:
                yield ("after", hook, result_context)

            return settle_result

        except Exception as e:
            # Execute failure hooks
            failure_context = SettleFailureContext(
                payment_payload=payload,
                requirements=requirements,
                payload_bytes=payload_bytes,
                requirements_bytes=requirements_bytes,
                error=e,
            )
            for hook in self._on_settle_failure_hooks:
                result = yield ("failure", hook, failure_context)
                if isinstance(result, RecoveredSettleResult):
                    return result.result

            raise
