"""x402ResourceServer base classes and internal types.

Contains shared logic for server implementations.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Generator
from typing import TYPE_CHECKING, Any, Literal, Protocol

from typing_extensions import Self

from .interfaces import SchemeNetworkServer
from .schemas import (
    AbortResult,
    Network,
    PaymentPayload,
    PaymentPayloadV1,
    PaymentRequired,
    PaymentRequirements,
    PaymentRequirementsV1,
    RecoveredSettleResult,
    RecoveredVerifyResult,
    ResourceInfo,
    ResourceServerExtension,
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
    find_schemes_by_network,
)

if TYPE_CHECKING:
    pass

# ============================================================================
# FacilitatorClient Protocols (Async and Sync)
# ============================================================================


class FacilitatorClient(Protocol):
    """Protocol for async facilitator clients."""

    async def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> VerifyResponse:
        """Verify a payment (async)."""
        ...

    async def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> SettleResponse:
        """Settle a payment (async)."""
        ...

    def get_supported(self) -> SupportedResponse:
        """Get supported payment kinds."""
        ...


class FacilitatorClientSync(Protocol):
    """Protocol for sync facilitator clients."""

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> VerifyResponse:
        """Verify a payment."""
        ...

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> SettleResponse:
        """Settle a payment."""
        ...

    def get_supported(self) -> SupportedResponse:
        """Get supported payment kinds."""
        ...


# ============================================================================
# Type Aliases - Support both sync and async hooks
# ============================================================================

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

# Type alias for facilitator clients (either async or sync)
_AnyFacilitatorClient = FacilitatorClient | FacilitatorClientSync


# ============================================================================
# Base Server Class (Shared Logic)
# ============================================================================


class x402ResourceServerBase:
    """Base class with shared logic for x402 resource servers.

    Contains registration, initialization, requirement building, and
    generator-based verify/settle logic.
    """

    def __init__(
        self,
        facilitator_clients: (_AnyFacilitatorClient | list[_AnyFacilitatorClient] | None) = None,
    ) -> None:
        """Initialize base server."""
        # Normalize to list
        if facilitator_clients is None:
            self._facilitator_clients: list[_AnyFacilitatorClient] = []
        elif isinstance(facilitator_clients, list):
            self._facilitator_clients = facilitator_clients
        else:
            self._facilitator_clients = [facilitator_clients]

        # Scheme servers
        self._schemes: dict[Network, dict[str, SchemeNetworkServer]] = {}

        # Facilitator client map: network -> scheme -> client
        self._facilitator_clients_map: dict[Network, dict[str, _AnyFacilitatorClient]] = {}

        # Supported responses from facilitators
        self._supported_responses: dict[Network, dict[str, SupportedResponse]] = {}

        # Extensions
        self._extensions: dict[str, ResourceServerExtension] = {}

        # Hooks (typed in subclasses)
        self._before_verify_hooks: list[Any] = []
        self._after_verify_hooks: list[Any] = []
        self._on_verify_failure_hooks: list[Any] = []

        self._before_settle_hooks: list[Any] = []
        self._after_settle_hooks: list[Any] = []
        self._on_settle_failure_hooks: list[Any] = []

        self._initialized = False

    # ========================================================================
    # Registration
    # ========================================================================

    def register(self, network: Network, server: SchemeNetworkServer) -> Self:
        """Register a V2 scheme server for a network."""
        if network not in self._schemes:
            self._schemes[network] = {}
        self._schemes[network][server.scheme] = server
        return self

    def register_extension(self, extension: ResourceServerExtension) -> Self:
        """Register a resource server extension."""
        self._extensions[extension.key] = extension
        return self

    def has_registered_scheme(self, network: Network, scheme: str) -> bool:
        """Check if a scheme is registered for a network."""
        # Check exact network match
        if network in self._schemes:
            if scheme in self._schemes[network]:
                return True

        # Check wildcard (e.g., eip155:* for eip155:84532)
        prefix = network.split(":")[0]
        wildcard = f"{prefix}:*"
        if wildcard in self._schemes:
            if scheme in self._schemes[wildcard]:
                return True

        return False

    def get_supported_kind(
        self, version: int, network: Network, scheme: str
    ) -> SupportedKind | None:
        """Get SupportedKind from facilitator for a network/scheme."""
        # Check exact network match
        if network in self._supported_responses:
            if scheme in self._supported_responses[network]:
                supported = self._supported_responses[network][scheme]
                for kind in supported.kinds:
                    if (
                        kind.x402_version == version
                        and kind.scheme == scheme
                        and kind.network == network
                    ):
                        return kind

        # Check wildcard pattern (e.g., eip155:* for eip155:84532)
        prefix = network.split(":")[0]
        wildcard = f"{prefix}:*"
        if wildcard in self._supported_responses:
            if scheme in self._supported_responses[wildcard]:
                supported = self._supported_responses[wildcard][scheme]
                for kind in supported.kinds:
                    if kind.x402_version == version and kind.scheme == scheme:
                        # Wildcard kind matches any network in the family
                        if kind.network == wildcard or kind.network == network:
                            return kind

        # Check if any facilitator supports this network/scheme via wildcard pattern
        for schemes in self._supported_responses.values():
            if scheme in schemes:
                supported = schemes[scheme]
                for kind in supported.kinds:
                    if kind.x402_version == version and kind.scheme == scheme:
                        # Check if the kind's network is a wildcard that matches
                        if ":" in kind.network and kind.network.endswith(":*"):
                            kind_prefix = kind.network.split(":")[0]
                            if network.startswith(f"{kind_prefix}:"):
                                return kind

        return None

    # ========================================================================
    # Initialization
    # ========================================================================

    def initialize(self) -> None:
        """Initialize server by fetching supported from facilitators."""
        for client in self._facilitator_clients:
            supported = client.get_supported()

            for kind in supported.kinds:
                network = kind.network
                scheme = kind.scheme

                # Only add if not already registered (earlier takes precedence)
                if network not in self._facilitator_clients_map:
                    self._facilitator_clients_map[network] = {}

                if scheme not in self._facilitator_clients_map[network]:
                    self._facilitator_clients_map[network][scheme] = client

                # Store supported response
                if network not in self._supported_responses:
                    self._supported_responses[network] = {}

                if scheme not in self._supported_responses[network]:
                    self._supported_responses[network][scheme] = supported

        self._initialized = True

    # ========================================================================
    # Build Requirements
    # ========================================================================

    def build_payment_requirements(
        self,
        config: Any,  # ResourceConfig
        extensions: list[str] | None = None,
    ) -> list[PaymentRequirements]:
        """Build payment requirements for a protected resource."""
        if not self._initialized:
            raise RuntimeError("Server not initialized. Call initialize() first.")

        # Find scheme server
        schemes = find_schemes_by_network(self._schemes, config.network)
        if schemes is None or config.scheme not in schemes:
            raise SchemeNotFoundError(config.scheme, config.network)

        server = schemes[config.scheme]

        # Get supported kind
        supported = self._supported_responses.get(config.network, {}).get(config.scheme)
        if supported is None:
            raise SchemeNotFoundError(config.scheme, config.network)

        # Find matching kind
        supported_kind: SupportedKind | None = None
        for kind in supported.kinds:
            if kind.scheme == config.scheme and kind.network == config.network:
                supported_kind = kind
                break

        if supported_kind is None:
            raise SchemeNotFoundError(config.scheme, config.network)

        # Parse price
        asset_amount = server.parse_price(config.price, config.network)

        # Build base requirements
        requirements = PaymentRequirements(
            scheme=config.scheme,
            network=config.network,
            asset=asset_amount.asset,
            amount=asset_amount.amount,
            pay_to=config.pay_to,
            max_timeout_seconds=config.max_timeout_seconds or 300,
            extra={
                **(asset_amount.extra or {}),
                **(config.extra or {}),
            },
        )

        # Enhance with scheme-specific details
        enhanced = server.enhance_payment_requirements(
            requirements,
            supported_kind,
            extensions or [],
        )

        return [enhanced]

    def create_payment_required_response(
        self,
        requirements: list[PaymentRequirements],
        resource: ResourceInfo | None = None,
        error: str | None = None,
        extensions: dict[str, Any] | None = None,
    ) -> PaymentRequired:
        """Create a 402 Payment Required response."""
        return PaymentRequired(
            x402_version=2,
            error=error,
            resource=resource,
            accepts=requirements,
            extensions=extensions,
        )

    # ========================================================================
    # Find Matching Requirements
    # ========================================================================

    def find_matching_requirements(
        self,
        available: list[PaymentRequirements],
        payload: PaymentPayload,
    ) -> PaymentRequirements | None:
        """Find requirements that match a payment payload."""
        for req in available:
            if (
                payload.accepted.scheme == req.scheme
                and payload.accepted.network == req.network
                and payload.accepted.amount == req.amount
                and payload.accepted.asset == req.asset
                and payload.accepted.pay_to == req.pay_to
            ):
                return req

        return None

    # ========================================================================
    # Extensions
    # ========================================================================

    def enrich_extensions(
        self,
        declared: dict[str, Any],
        transport_context: Any,
    ) -> dict[str, Any]:
        """Enrich extension declarations with transport-specific data."""
        result = dict(declared)

        for key, extension in self._extensions.items():
            if key in declared:
                result[key] = extension.enrich_declaration(
                    declared[key],
                    transport_context,
                )

        return result

    # ========================================================================
    # Core Logic Generators (shared between async/sync)
    # ========================================================================

    def _verify_payment_core(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
        payload_bytes: bytes | None,
        requirements_bytes: bytes | None,
    ) -> Generator[HookCommand, Any, VerifyResponse]:
        """Core verify logic as generator.

        Yields (phase, hook, context) tuples for hook execution.
        Also yields ("call_facilitator", client, (payload, requirements)) for the actual call.
        """
        if not self._initialized:
            raise RuntimeError("Server not initialized. Call initialize() first.")

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
            # Get scheme and network
            scheme = payload.get_scheme()
            network = payload.get_network()

            # Find facilitator client
            client = self._facilitator_clients_map.get(network, {}).get(scheme)
            if client is None:
                raise SchemeNotFoundError(scheme, network)

            # Yield for facilitator call (caller handles sync/async)
            verify_result: VerifyResponse = yield (
                "call_facilitator",
                client,
                ("verify", payload, requirements),
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

    def _settle_payment_core(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
        payload_bytes: bytes | None,
        requirements_bytes: bytes | None,
    ) -> Generator[HookCommand, Any, SettleResponse]:
        """Core settle logic as generator.

        Yields (phase, hook, context) tuples for hook execution.
        Also yields ("call_facilitator", client, (payload, requirements)) for the actual call.
        """
        if not self._initialized:
            raise RuntimeError("Server not initialized. Call initialize() first.")

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
            # Get scheme and network
            scheme = payload.get_scheme()
            network = payload.get_network()

            # Find facilitator client
            client = self._facilitator_clients_map.get(network, {}).get(scheme)
            if client is None:
                raise SchemeNotFoundError(scheme, network)

            # Yield for facilitator call (caller handles sync/async)
            settle_result: SettleResponse = yield (
                "call_facilitator",
                client,
                ("settle", payload, requirements),
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
