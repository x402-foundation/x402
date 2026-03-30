"""x402Client base classes and internal types.

Contains shared logic for client implementations.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Generator
from dataclasses import dataclass, field
from typing import Any, Literal

from typing_extensions import Self

from .interfaces import SchemeNetworkClient, SchemeNetworkClientV1
from .schemas import (
    AbortResult,
    Network,
    NoMatchingRequirementsError,
    PaymentCreatedContext,
    PaymentCreationContext,
    PaymentCreationFailureContext,
    PaymentPayload,
    PaymentPayloadV1,
    PaymentRequired,
    PaymentRequiredV1,
    PaymentRequirements,
    PaymentRequirementsV1,
    RecoveredPayloadResult,
    ResourceInfo,
    SchemeNotFoundError,
    find_schemes_by_network,
)

# ============================================================================
# Type Aliases
# ============================================================================

# V2 types
Requirements = PaymentRequirements
RequirementsView = PaymentRequirements | PaymentRequirementsV1

# Policy: filter requirements list (e.g., prefer_network, max_amount)
PaymentPolicy = Callable[[int, list[RequirementsView]], list[RequirementsView]]

# Selector: choose final requirement from filtered list
PaymentRequirementsSelector = Callable[[int, list[RequirementsView]], RequirementsView]


# ============================================================================
# Configuration Types
# ============================================================================


@dataclass
class SchemeRegistration:
    """Configuration for registering a payment scheme with a specific network."""

    network: Network
    client: SchemeNetworkClient | SchemeNetworkClientV1
    x402_version: int = 2


@dataclass
class x402ClientConfig:
    """Configuration options for creating x402Client from config."""

    schemes: list[SchemeRegistration]
    policies: list[PaymentPolicy] | None = None
    payment_requirements_selector: PaymentRequirementsSelector | None = field(default=None)


# Hook types - support both sync and async (for async class auto-detection)
BeforePaymentCreationHook = Callable[
    [PaymentCreationContext], Awaitable[AbortResult | None] | AbortResult | None
]
AfterPaymentCreationHook = Callable[[PaymentCreatedContext], Awaitable[None] | None]
OnPaymentCreationFailureHook = Callable[
    [PaymentCreationFailureContext],
    Awaitable[RecoveredPayloadResult | None] | RecoveredPayloadResult | None,
]

# Sync-only hook types (for sync class)
SyncBeforePaymentCreationHook = Callable[[PaymentCreationContext], AbortResult | None]
SyncAfterPaymentCreationHook = Callable[[PaymentCreatedContext], None]
SyncOnPaymentCreationFailureHook = Callable[
    [PaymentCreationFailureContext], RecoveredPayloadResult | None
]

# Hook command type for generator-based implementation
HookPhase = Literal["before", "after", "failure"]
HookCommand = tuple[HookPhase, Any, Any]  # (phase, hook, context)


# ============================================================================
# Default Implementations
# ============================================================================


def default_payment_selector(
    version: int,
    requirements: list[RequirementsView],
) -> RequirementsView:
    """Default selector: return first requirement."""
    return requirements[0]


# ============================================================================
# Built-in Policies
# ============================================================================


def prefer_network(network: Network) -> PaymentPolicy:
    """Create policy that prefers a specific network."""

    def policy(version: int, reqs: list[RequirementsView]) -> list[RequirementsView]:
        preferred = [r for r in reqs if r.network == network]
        others = [r for r in reqs if r.network != network]
        return preferred + others

    return policy


def prefer_scheme(scheme: str) -> PaymentPolicy:
    """Create policy that prefers a specific scheme."""

    def policy(version: int, reqs: list[RequirementsView]) -> list[RequirementsView]:
        preferred = [r for r in reqs if r.scheme == scheme]
        others = [r for r in reqs if r.scheme != scheme]
        return preferred + others

    return policy


def max_amount(max_value: int) -> PaymentPolicy:
    """Create policy that filters by maximum amount."""

    def policy(version: int, reqs: list[RequirementsView]) -> list[RequirementsView]:
        return [r for r in reqs if int(r.get_amount()) <= max_value]

    return policy


# ============================================================================
# Base Client Class (Shared Logic)
# ============================================================================


class x402ClientBase:
    """Base class with shared logic for x402 clients.

    Contains registration, policies, selection, and generator-based
    payment creation logic.
    """

    def __init__(
        self,
        payment_requirements_selector: PaymentRequirementsSelector | None = None,
    ) -> None:
        """Initialize base client."""
        self._selector = payment_requirements_selector or default_payment_selector
        self._schemes: dict[Network, dict[str, SchemeNetworkClient]] = {}
        self._schemes_v1: dict[Network, dict[str, SchemeNetworkClientV1]] = {}
        self._policies: list[PaymentPolicy] = []

        # Hooks (typed in subclasses)
        self._before_payment_creation_hooks: list[Any] = []
        self._after_payment_creation_hooks: list[Any] = []
        self._on_payment_creation_failure_hooks: list[Any] = []

    # ========================================================================
    # Registration
    # ========================================================================

    def register(self, network: Network, client: SchemeNetworkClient) -> Self:
        """Register a V2 scheme client for a network."""
        if network not in self._schemes:
            self._schemes[network] = {}
        self._schemes[network][client.scheme] = client
        return self

    def register_v1(self, network: Network, client: SchemeNetworkClientV1) -> Self:
        """Register a V1 scheme client for a network."""
        if network not in self._schemes_v1:
            self._schemes_v1[network] = {}
        self._schemes_v1[network][client.scheme] = client
        return self

    def register_policy(self, policy: PaymentPolicy) -> Self:
        """Add a requirement filter policy."""
        self._policies.append(policy)
        return self

    # ========================================================================
    # Selection (Shared)
    # ========================================================================

    def _select_requirements_v2(
        self,
        requirements: list[PaymentRequirements],
    ) -> PaymentRequirements:
        """Select V2 requirements using policies and selector."""
        # Filter to supported schemes
        supported = []
        for req in requirements:
            schemes = find_schemes_by_network(self._schemes, req.network)
            if schemes and req.scheme in schemes:
                supported.append(req)

        if not supported:
            raise NoMatchingRequirementsError("No payment requirements match registered schemes")

        # Apply policies
        filtered: list[RequirementsView] = list(supported)
        for policy in self._policies:
            filtered = policy(2, filtered)
            if not filtered:
                raise NoMatchingRequirementsError("All requirements filtered out by policies")

        # Select final
        return self._selector(2, filtered)  # type: ignore[return-value]

    def _select_requirements_v1(
        self,
        requirements: list[PaymentRequirementsV1],
    ) -> PaymentRequirementsV1:
        """Select V1 requirements using policies and selector."""
        # Filter to supported schemes
        supported = []
        for req in requirements:
            schemes = find_schemes_by_network(self._schemes_v1, req.network)
            if schemes and req.scheme in schemes:
                supported.append(req)

        if not supported:
            raise NoMatchingRequirementsError("No payment requirements match registered schemes")

        # Apply policies
        filtered: list[RequirementsView] = list(supported)
        for policy in self._policies:
            filtered = policy(1, filtered)
            if not filtered:
                raise NoMatchingRequirementsError("All requirements filtered out by policies")

        # Select final
        return self._selector(1, filtered)  # type: ignore[return-value]

    # ========================================================================
    # Introspection
    # ========================================================================

    def get_registered_schemes(
        self,
    ) -> dict[int, list[dict[str, str]]]:
        """Get list of registered schemes for debugging."""
        result: dict[int, list[dict[str, str]]] = {1: [], 2: []}

        for network, schemes in self._schemes.items():
            for scheme in schemes:
                result[2].append({"network": network, "scheme": scheme})

        for network, schemes in self._schemes_v1.items():
            for scheme in schemes:
                result[1].append({"network": network, "scheme": scheme})

        return result

    # ========================================================================
    # Core Logic Generators (shared between async/sync)
    # ========================================================================

    def _create_payment_payload_v2_core(
        self,
        payment_required: PaymentRequired,
        resource: ResourceInfo | None,
        extensions: dict[str, Any] | None,
    ) -> Generator[HookCommand, Any, PaymentPayload]:
        """Core V2 payment creation logic as generator.

        Yields (phase, hook, context) tuples for hook execution.
        """
        # 1. Select requirements
        selected = self._select_requirements_v2(payment_required.accepts)

        # 2. Build context
        context = PaymentCreationContext(
            payment_required=payment_required,
            selected_requirements=selected,
        )

        # 3. Execute before hooks
        for hook in self._before_payment_creation_hooks:
            result = yield ("before", hook, context)
            if isinstance(result, AbortResult):
                from .schemas import PaymentAbortedError

                raise PaymentAbortedError(result.reason)

        try:
            # 4. Find scheme client
            schemes = find_schemes_by_network(self._schemes, selected.network)
            if schemes is None or selected.scheme not in schemes:
                raise SchemeNotFoundError(selected.scheme, selected.network)

            client = schemes[selected.scheme]

            # 5. Create inner payload (pass extensions for enrichment if scheme supports it)
            server_extensions = payment_required.extensions
            sig = inspect.signature(client.create_payment_payload)
            if "extensions" in sig.parameters:
                inner_payload = client.create_payment_payload(
                    selected, extensions=server_extensions
                )
            else:
                inner_payload = client.create_payment_payload(selected)

            # 5b. Extract scheme-generated extensions (e.g. gas sponsoring)
            scheme_extensions = inner_payload.pop("__extensions", None)
            final_extensions = extensions or payment_required.extensions or {}
            if scheme_extensions:
                final_extensions = {**final_extensions, **scheme_extensions}

            # 6. Wrap into full PaymentPayload
            payload = PaymentPayload(
                x402_version=2,
                payload=inner_payload,
                accepted=selected,
                resource=resource or payment_required.resource,
                extensions=final_extensions or None,
            )

            # 7. Execute after hooks
            result_context = PaymentCreatedContext(
                payment_required=payment_required,
                selected_requirements=selected,
                payment_payload=payload,
            )
            for hook in self._after_payment_creation_hooks:
                yield ("after", hook, result_context)

            return payload

        except Exception as e:
            # Execute failure hooks
            failure_context = PaymentCreationFailureContext(
                payment_required=payment_required,
                selected_requirements=selected,
                error=e,
            )
            for hook in self._on_payment_creation_failure_hooks:
                result = yield ("failure", hook, failure_context)
                if isinstance(result, RecoveredPayloadResult):
                    return result.payload  # type: ignore[return-value]

            raise

    def _create_payment_payload_v1_core(
        self,
        payment_required: PaymentRequiredV1,
    ) -> Generator[HookCommand, Any, PaymentPayloadV1]:
        """Core V1 payment creation logic as generator.

        Yields (phase, hook, context) tuples for hook execution.
        """
        # 1. Select requirements
        selected = self._select_requirements_v1(payment_required.accepts)

        # 2. Build context
        context = PaymentCreationContext(
            payment_required=payment_required,
            selected_requirements=selected,
        )

        # 3. Execute before hooks
        for hook in self._before_payment_creation_hooks:
            result = yield ("before", hook, context)
            if isinstance(result, AbortResult):
                from .schemas import PaymentAbortedError

                raise PaymentAbortedError(result.reason)

        try:
            # 4. Find scheme client
            schemes = find_schemes_by_network(self._schemes_v1, selected.network)
            if schemes is None or selected.scheme not in schemes:
                raise SchemeNotFoundError(selected.scheme, selected.network)

            client = schemes[selected.scheme]

            # 5. Create inner payload
            inner_payload = client.create_payment_payload(selected)

            # 6. Wrap into full PaymentPayloadV1
            payload = PaymentPayloadV1(
                x402_version=1,
                scheme=selected.scheme,
                network=selected.network,
                payload=inner_payload,
            )

            # 7. Execute after hooks
            result_context = PaymentCreatedContext(
                payment_required=payment_required,
                selected_requirements=selected,
                payment_payload=payload,
            )
            for hook in self._after_payment_creation_hooks:
                yield ("after", hook, result_context)

            return payload

        except Exception as e:
            # Execute failure hooks
            failure_context = PaymentCreationFailureContext(
                payment_required=payment_required,
                selected_requirements=selected,
                error=e,
            )
            for hook in self._on_payment_creation_failure_hooks:
                result = yield ("failure", hook, failure_context)
                if isinstance(result, RecoveredPayloadResult):
                    return result.payload  # type: ignore[return-value]

            raise
