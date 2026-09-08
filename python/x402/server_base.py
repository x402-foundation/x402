"""x402ResourceServer base classes and internal types.

Contains shared logic for server implementations.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Generator
from dataclasses import asdict, dataclass, is_dataclass
from typing import TYPE_CHECKING, Any, Literal, Protocol

from pydantic import BaseModel
from typing_extensions import Self

from .hook_adapters import (
    build_extension_server_hook_handles,
    collect_scheme_server_hook_handles,
    get_labeled_server_hooks,
)
from .hook_policy import (
    assert_accepts_additive_extra_after_scheme_enrich,
    assert_accepts_allowlisted_after_extension_enrich,
    assert_additive_payload_enrichment,
    assert_additive_settlement_extra,
    assert_settle_response_core_unchanged,
    merge_additive_settlement_extra,
    snapshot_payment_requirements_list,
    snapshot_settle_response_core,
)
from .interfaces import PaymentFlowName, SchemeNetworkServer, SchemePaymentRequiredContext
from .payment_flow import (
    apply_payment_flow_wire_extra,
    resolve_payment_flow,
    resolve_payment_flow_phases,
)
from .pending_settlement_store import ERR_SETTLEMENT_PENDING
from .schemas import (
    X402_VERSION,
    AbortResult,
    FacilitatorCapabilityError,
    Network,
    PaymentCancellationDispatcher,
    PaymentPayload,
    PaymentPayloadV1,
    PaymentRequired,
    PaymentRequirements,
    PaymentRequirementsV1,
    RecoveredSettleResult,
    RecoveredVerifyResult,
    ResourceInfo,
    ResourceServerExtension,
    ResourceVerifyResponse,
    SchemeNotFoundError,
    ServerPaymentRequiredContext,
    SettleContext,
    SettleFailureContext,
    SettlePhase,
    SettleResponse,
    SettleResultContext,
    SkipHandlerDirective,
    SkipHandlerResult,
    SkipSettleResult,
    SkipVerifyResult,
    SupportedKind,
    SupportedResponse,
    VerifiedPaymentCanceledContext,
    VerifiedPaymentCancelOptions,
    VerifyContext,
    VerifyFailureContext,
    VerifyResponse,
    VerifyResultContext,
    find_schemes_by_network,
)

logger = logging.getLogger("x402")

if TYPE_CHECKING:
    pass

# Invalid reason returned when a client's echoed extension info drops or changes a
# server-advertised (non-dynamic) field.
ERR_EXTENSION_ECHO_MISMATCH = "extension_echo_mismatch"


@dataclass(frozen=True)
class ExtensionValidationResult:
    """Outcome of validating client extension echoes against server declarations."""

    valid: bool
    invalid_reason: str | None = None
    extension_key: str | None = None


def _normalize_extension_value(value: Any) -> Any:
    """Reduce a declaration/echo to plain dict/list/scalar values for comparison.

    Server declarations may be typed (pydantic models or dataclasses) while client
    echoes are JSON-decoded plain values; normalizing both makes them comparable.
    """
    if isinstance(value, BaseModel):
        return _normalize_extension_value(value.model_dump(by_alias=True))
    if is_dataclass(value) and not isinstance(value, type):
        return _normalize_extension_value(asdict(value))
    if isinstance(value, dict):
        return {key: _normalize_extension_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalize_extension_value(item) for item in value]
    return value


def _get_extension_info(value: Any) -> Any:
    """Return the nested ``info`` envelope when present, otherwise ``value``."""
    if isinstance(value, dict) and "info" in value:
        return value["info"]
    return value


def _server_owned_info_fields_match(
    advertised: Any,
    echoed: Any,
    server_owned_fields: set[str],
) -> bool:
    """Return whether client-echoed server-owned fields match the advertisement.

    When the server did not declare the extension, ``advertised`` is treated as
    empty so clients cannot invent fields such as builder-code ``a``.
    """
    if not isinstance(echoed, dict):
        return True

    advertised_record = advertised if isinstance(advertised, dict) else {}

    for field in server_owned_fields:
        if field not in echoed:
            continue
        echoed_value = echoed[field]
        if field not in advertised_record or advertised_record[field] != echoed_value:
            return False

    return True


def _omit_fields(value: Any, fields: list[str] | None) -> Any:
    """Return a copy of ``value`` without the named dynamic fields."""
    if not fields or not isinstance(value, dict):
        return value
    return {key: item for key, item in value.items() if key not in fields}


def _to_comparable_list(value: Any) -> list[Any] | None:
    """Coerce a value for additive list comparison.

    A list passes through unchanged; a bare scalar is wrapped as a
    single-element list so it can compare against a list on the other side
    (e.g. builder-code ``s`` accepts a string or a list of strings). Returns
    ``None`` for values that cannot participate (``None``, dicts).
    """
    if isinstance(value, list):
        return value
    if value is None or isinstance(value, dict):
        return None
    return [value]


# Extension info fields, keyed by extension key, where a conflicting list value
# declared by both server and client is additive rather than exclusive:
# client_base._merge_extensions concatenates both sides (client first, deduped)
# and validate_extensions accepts any echo that is a superset of the advertised
# value. Scoped narrowly per extension + field so unrelated extensions (e.g.
# sign-in-with-x's "resources") keep exact list matching in both directions.
_ADDITIVE_LIST_INFO_FIELDS: dict[str, set[str]] = {
    "builder-code": {"s"},
}

# Extension info fields, keyed by extension key, that only the resource server
# may declare. Clients MUST NOT invent these on echo; this package has no
# dependency on extension packages, so the key/field list is duplicated here
# (same as _ADDITIVE_LIST_INFO_FIELDS).
_SERVER_OWNED_INFO_FIELDS: dict[str, set[str]] = {
    "builder-code": {"a"},
}

# Caps the combined echoed length of an additive list field (see
# _ADDITIVE_LIST_INFO_FIELDS) so a hand-crafted payload cannot pad the field
# past the sum of every party's own reservation and later crowd out a
# legitimately declared entry once truncated further downstream (e.g. by a
# facilitator extension). This package has no dependency on extension
# packages, so this value (builder-code's MAX_CLIENT_SERVICE_CODES +
# MAX_SERVER_SERVICE_CODES) is duplicated from
# x402/extensions/builder_code/types.py and must be kept in sync by hand.
_ADDITIVE_LIST_MAX_LENGTHS: dict[str, dict[str, int]] = {
    "builder-code": {"s": 10},
}


def _object_contains_subset(
    expected: Any,
    actual: Any,
    additive_fields: set[str] | None = None,
    max_lengths: dict[str, int] | None = None,
    field_key: str | None = None,
) -> bool:
    """Return whether ``actual`` contains every field/value from ``expected``.

    Object values may add fields. When ``field_key`` names a field in
    ``additive_fields`` (e.g. builder-code's ``s``) and either side is a list,
    the list is additive: every element of ``expected`` must appear in
    ``actual``, and a bare scalar on either side is treated as a single-element
    list. When ``field_key`` also has an entry in ``max_lengths``, ``actual``
    is rejected outright if it exceeds that combined length, rather than being
    accepted and silently truncated downstream. Every other list field must
    match exactly. Primitives must match exactly.
    """
    if (
        field_key is not None
        and additive_fields
        and field_key in additive_fields
        and (isinstance(expected, list) or isinstance(actual, list))
    ):
        expected_list = _to_comparable_list(expected)
        actual_list = _to_comparable_list(actual)
        if expected_list is None or actual_list is None:
            return False
        max_length = (max_lengths or {}).get(field_key)
        if max_length is not None and len(actual_list) > max_length:
            return False
        return all(
            any(exp_item == act_item for act_item in actual_list) for exp_item in expected_list
        )
    if not isinstance(expected, dict):
        return expected == actual
    if not isinstance(actual, dict):
        return False
    for key, value in expected.items():
        if key not in actual:
            if value is None:
                continue
            return False
        if not _object_contains_subset(value, actual[key], additive_fields, max_lengths, key):
            return False
    return True


def _payment_requirements_match_accepted(
    required: PaymentRequirements,
    accepted: PaymentRequirements,
    dynamic_extra_fields: list[str] | None = None,
) -> bool:
    """Return whether a client-selected requirement satisfies a server-advertised one.

    Core payment terms must match exactly. Server-declared ``extra`` fields must
    be a subset of the client's ``accepted.extra``. Fields listed in
    ``dynamic_extra_fields`` are excluded from the extra comparison.
    """
    if (
        required.scheme != accepted.scheme
        or required.network != accepted.network
        or required.amount != accepted.amount
        or required.asset != accepted.asset
        or required.pay_to != accepted.pay_to
        or required.max_timeout_seconds != accepted.max_timeout_seconds
    ):
        return False

    required_extra = required.extra or {}
    if not required_extra:
        return True

    return _object_contains_subset(
        _omit_fields(required_extra, dynamic_extra_fields),
        _omit_fields(accepted.extra or {}, dynamic_extra_fields),
    )


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
# Single automatic settle retry on settlement_pending
# ============================================================================
#
# When a settle attempt's receipt/confirmation wait fails, a mechanism (see
# PendingSettlementStore in pending_settlement_store.py) returns success=False
# with error_reason="settlement_pending" and a populated `transaction` hash.
# The resource server resends the identical payload/requirements exactly once
# so the mechanism's own PendingSettlementStore check reconciles against the
# already-broadcast transaction instead of verifying and broadcasting a
# second one. No mutation, backoff, or sleep here — the mechanism layer owns
# any bounded waiting. Any other outcome (success, or a different failure
# reason) short-circuits after the first call, and this is capped at exactly
# one retry regardless of the second outcome, so it can never loop.
#
# This lives once, above all scheme/network dispatch, in the driver loops
# that call `client.settle(...)` at the "call_facilitator" phase of the
# settle generator (see `settle_payment` in server.py, both sync and async).


def is_retryable_settlement_pending(result: SettleResponse) -> bool:
    """Report whether a settle result is a retryable settlement_pending.

    True when the result is a non-terminal settlement_pending failure that
    carries a broadcast transaction hash to reconcile against.
    """
    return (
        not result.success
        and result.error_reason == ERR_SETTLEMENT_PENDING
        and bool(result.transaction)
    )


def settle_with_pending_retry(
    client: FacilitatorClientSync,
    payload: PaymentPayload | PaymentPayloadV1,
    requirements: PaymentRequirements | PaymentRequirementsV1,
) -> SettleResponse:
    """Call client.settle once, retrying exactly once on settlement_pending.

    See the module-level comment above for the retry semantics.
    """
    result = client.settle(payload, requirements)
    if not is_retryable_settlement_pending(result):
        return result
    return client.settle(payload, requirements)


async def settle_with_pending_retry_async(
    client: FacilitatorClient,
    payload: PaymentPayload | PaymentPayloadV1,
    requirements: PaymentRequirements | PaymentRequirementsV1,
) -> SettleResponse:
    """Async counterpart of settle_with_pending_retry."""
    result = await client.settle(payload, requirements)
    if not is_retryable_settlement_pending(result):
        return result
    return await client.settle(payload, requirements)


# ============================================================================
# Type Aliases - Support both sync and async hooks
# ============================================================================

BeforeVerifyHook = Callable[
    [VerifyContext],
    Awaitable[AbortResult | SkipVerifyResult | None] | AbortResult | SkipVerifyResult | None,
]
AfterVerifyHook = Callable[
    [VerifyResultContext],
    Awaitable[AbortResult | SkipHandlerResult | None] | AbortResult | SkipHandlerResult | None,
]
OnVerifyFailureHook = Callable[
    [VerifyFailureContext],
    Awaitable[RecoveredVerifyResult | None] | RecoveredVerifyResult | None,
]

BeforeSettleHook = Callable[
    [SettleContext],
    Awaitable[AbortResult | SkipSettleResult | None] | AbortResult | SkipSettleResult | None,
]
AfterSettleHook = Callable[[SettleResultContext], Awaitable[None] | None]
OnSettleFailureHook = Callable[
    [SettleFailureContext],
    Awaitable[RecoveredSettleResult | None] | RecoveredSettleResult | None,
]
OnVerifiedPaymentCanceledHook = Callable[
    [VerifiedPaymentCanceledContext],
    Awaitable[None] | None,
]

# Sync-only hook types (for sync class)
SyncBeforeVerifyHook = Callable[[VerifyContext], AbortResult | SkipVerifyResult | None]
SyncAfterVerifyHook = Callable[[VerifyResultContext], AbortResult | SkipHandlerResult | None]
SyncOnVerifyFailureHook = Callable[[VerifyFailureContext], RecoveredVerifyResult | None]

SyncBeforeSettleHook = Callable[[SettleContext], AbortResult | SkipSettleResult | None]
SyncAfterSettleHook = Callable[[SettleResultContext], None]
SyncOnSettleFailureHook = Callable[[SettleFailureContext], RecoveredSettleResult | None]
SyncOnVerifiedPaymentCanceledHook = Callable[[VerifiedPaymentCanceledContext], None]

# Hook command type for generator-based implementation
HookPhase = Literal["before", "after", "failure", "call_facilitator", "dispatch_cancel"]
HookCommand = tuple[HookPhase, Any, Any]  # (phase, hook|client|options, context)

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
        self._scheme_hook_adapters: dict[Network, dict[str, Any]] = {}
        self._extension_hook_adapters: dict[str, Any] = {}

        # Hooks (typed in subclasses)
        self._before_verify_hooks: list[Any] = []
        self._after_verify_hooks: list[Any] = []
        self._on_verify_failure_hooks: list[Any] = []

        self._before_settle_hooks: list[Any] = []
        self._after_settle_hooks: list[Any] = []
        self._on_settle_failure_hooks: list[Any] = []
        self._on_verified_payment_canceled_hooks: list[Any] = []

        self._initialized = False

    # ========================================================================
    # Registration
    # ========================================================================

    def register(self, network: Network, server: SchemeNetworkServer) -> Self:
        """Register a V2 scheme server for a network."""
        if network not in self._schemes:
            self._schemes[network] = {}
        self._schemes[network][server.scheme] = server

        handles = collect_scheme_server_hook_handles(server)
        if handles.is_empty():
            by_scheme = self._scheme_hook_adapters.get(network)
            if by_scheme is not None:
                by_scheme.pop(server.scheme, None)
                if not by_scheme:
                    self._scheme_hook_adapters.pop(network, None)
        else:
            if network not in self._scheme_hook_adapters:
                self._scheme_hook_adapters[network] = {}
            self._scheme_hook_adapters[network][server.scheme] = handles
        return self

    def register_extension(self, extension: ResourceServerExtension) -> Self:
        """Register a resource server extension."""
        self._extensions[extension.key] = extension
        extension_hooks = getattr(extension, "hooks", None)
        if extension_hooks is None:
            self._extension_hook_adapters.pop(extension.key, None)
            return self

        handles = build_extension_server_hook_handles(extension.key, extension_hooks)
        if handles.is_empty():
            self._extension_hook_adapters.pop(extension.key, None)
        else:
            self._extension_hook_adapters[extension.key] = handles
        return self

    def get_extensions(self) -> list[ResourceServerExtension]:
        """Return all registered resource server extensions."""
        return list(self._extensions.values())

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

    def get_registered_scheme(self, network: Network, scheme: str) -> SchemeNetworkServer | None:
        """Return the registered scheme server for a network, if any."""
        return self._find_registered_scheme(scheme, network)

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

        # Empty /supported is transient (timeout, deploy blip) and must stay
        # retryable. Route validation would otherwise raise RouteConfigurationError
        # (missing_facilitator) and HTTP adapters would treat that as fatal.
        if not self._supported_responses:
            raise RuntimeError(
                "Failed to initialize: no supported payment kinds loaded from any facilitator."
            )

        self._validate_facilitator_capabilities()
        self._initialized = True

    def _validate_facilitator_capabilities(self) -> None:
        """Fail fast when a registered scheme's config is incompatible with the
        facilitator capabilities advertised for the scheme/network it supports.

        Only schemes the facilitator actually supports are validated, and only
        schemes exposing a `validate_facilitator_support` hook participate.

        Raises:
            FacilitatorCapabilityError: Listing every capability problem when one or more are reported.
        """
        problems: list[str] = []

        for network, scheme_map in self._schemes.items():
            for scheme, server in scheme_map.items():
                validate = getattr(server, "validate_facilitator_support", None)
                if validate is None:
                    continue

                supported_kind = self.get_supported_kind(X402_VERSION, network, scheme)
                if supported_kind is None:
                    continue

                extensions = self._facilitator_extensions(network, scheme)
                problem = validate(network, supported_kind, extensions)
                if problem:
                    problems.append(f"{scheme} on {network}: {problem}")

        if problems:
            raise FacilitatorCapabilityError(problems)

    def _facilitator_extensions(self, network: Network, scheme: str) -> list[str]:
        """Return the extensions a facilitator advertises for a scheme/network."""
        supported = self._supported_responses.get(network, {}).get(scheme)
        if supported is None:
            prefix = network.split(":")[0]
            wildcard = f"{prefix}:*"
            supported = self._supported_responses.get(wildcard, {}).get(scheme)
        return list(supported.extensions) if supported else []

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

        resolved = resolve_payment_flow(server, enhanced)
        enhanced.extra = apply_payment_flow_wire_extra(dict(enhanced.extra or {}), resolved)

        return [enhanced]

    def create_payment_required_response(
        self,
        requirements: list[PaymentRequirements],
        resource: ResourceInfo | None = None,
        error: str | None = None,
        extensions: dict[str, Any] | None = None,
        transport_context: Any = None,
        payment_payload: PaymentPayload | None = None,
    ) -> PaymentRequired:
        """Create a 402 Payment Required response with scheme/extension enrichment."""
        return self._build_payment_required_response(
            requirements,
            resource,
            error,
            extensions,
            transport_context,
            payment_payload,
            self._run_enrich_hook_sync,
        )

    def _build_payment_required_response(
        self,
        requirements: list[PaymentRequirements],
        resource: ResourceInfo | None,
        error: str | None,
        extensions: dict[str, Any] | None,
        transport_context: Any,
        payment_payload: PaymentPayload | None,
        run_hook: Callable[..., Any],
    ) -> PaymentRequired:
        working_accepts = snapshot_payment_requirements_list(requirements)
        baseline_accepts = snapshot_payment_requirements_list(working_accepts)

        response = PaymentRequired(
            x402_version=2,
            error=error,
            resource=resource,
            accepts=working_accepts,
            extensions=extensions if extensions else None,
        )

        for accept in working_accepts:
            scheme_server = self._find_registered_scheme(accept.scheme, accept.network)
            enrich = getattr(scheme_server, "enrich_payment_required_response", None)
            if enrich is None:
                continue

            context = SchemePaymentRequiredContext(
                requirements=working_accepts,
                payment_payload=payment_payload,
                resource_info=resource,
                error=error,
                payment_required_response=response,
                transport_context=transport_context,
            )
            try:
                enriched_accepts = run_hook(enrich, context)
            except Exception as hook_error:
                label = f'scheme "{accept.scheme}" enrich_payment_required_response'
                self._warn_resource_server_hook_failure(
                    "enrichPaymentRequiredResponse",
                    label,
                    hook_error,
                )
                enriched_accepts = None

            if enriched_accepts is not None:
                working_accepts = enriched_accepts
                response = response.model_copy(update={"accepts": working_accepts})

            assert_accepts_additive_extra_after_scheme_enrich(
                baseline_accepts,
                response.accepts,
                accept.scheme,
                accept.network,
            )
            baseline_accepts = snapshot_payment_requirements_list(response.accepts)

        if extensions:
            for key, declaration in extensions.items():
                extension = self._extensions.get(key)
                enrich = getattr(extension, "enrich_payment_required_response", None)
                if enrich is None:
                    continue

                context = ServerPaymentRequiredContext(
                    requirements=working_accepts,
                    resource_info=resource,
                    error=error,
                    payment_required_response=response,
                    transport_context=transport_context,
                    payment_payload=payment_payload,
                )
                try:
                    extension_data = run_hook(enrich, declaration, context)
                except Exception as hook_error:
                    self._warn_extension_hook_failure(
                        key, "enrichPaymentRequiredResponse", hook_error
                    )
                    extension_data = None

                if extension_data is not None:
                    merged_extensions = dict(response.extensions or {})
                    merged_extensions[key] = extension_data
                    response = response.model_copy(update={"extensions": merged_extensions})

                assert_accepts_allowlisted_after_extension_enrich(
                    baseline_accepts, working_accepts, key
                )
                baseline_accepts = snapshot_payment_requirements_list(working_accepts)

        return response

    async def _build_payment_required_response_async(
        self,
        requirements: list[PaymentRequirements],
        resource: ResourceInfo | None,
        error: str | None,
        extensions: dict[str, Any] | None,
        transport_context: Any,
        payment_payload: PaymentPayload | None,
    ) -> PaymentRequired:
        import asyncio

        async def invoke(hook: Any, *args: Any) -> Any:
            result = hook(*args)
            if asyncio.iscoroutine(result) or asyncio.isfuture(result):
                return await result
            return result

        working_accepts = snapshot_payment_requirements_list(requirements)
        baseline_accepts = snapshot_payment_requirements_list(working_accepts)

        response = PaymentRequired(
            x402_version=2,
            error=error,
            resource=resource,
            accepts=working_accepts,
            extensions=extensions if extensions else None,
        )

        for accept in working_accepts:
            scheme_server = self._find_registered_scheme(accept.scheme, accept.network)
            enrich = getattr(scheme_server, "enrich_payment_required_response", None)
            if enrich is None:
                continue

            context = SchemePaymentRequiredContext(
                requirements=working_accepts,
                payment_payload=payment_payload,
                resource_info=resource,
                error=error,
                payment_required_response=response,
                transport_context=transport_context,
            )
            try:
                enriched_accepts = await invoke(enrich, context)
            except Exception as hook_error:
                label = f'scheme "{accept.scheme}" enrich_payment_required_response'
                self._warn_resource_server_hook_failure(
                    "enrichPaymentRequiredResponse",
                    label,
                    hook_error,
                )
                enriched_accepts = None

            if enriched_accepts is not None:
                working_accepts = enriched_accepts
                response = response.model_copy(update={"accepts": working_accepts})

            assert_accepts_additive_extra_after_scheme_enrich(
                baseline_accepts,
                response.accepts,
                accept.scheme,
                accept.network,
            )
            baseline_accepts = snapshot_payment_requirements_list(response.accepts)

        if extensions:
            for key, declaration in extensions.items():
                extension = self._extensions.get(key)
                enrich = getattr(extension, "enrich_payment_required_response", None)
                if enrich is None:
                    continue

                context = ServerPaymentRequiredContext(
                    requirements=working_accepts,
                    resource_info=resource,
                    error=error,
                    payment_required_response=response,
                    transport_context=transport_context,
                    payment_payload=payment_payload,
                )
                try:
                    extension_data = await invoke(enrich, declaration, context)
                except Exception as hook_error:
                    self._warn_extension_hook_failure(
                        key, "enrichPaymentRequiredResponse", hook_error
                    )
                    extension_data = None

                if extension_data is not None:
                    merged_extensions = dict(response.extensions or {})
                    merged_extensions[key] = extension_data
                    response = response.model_copy(update={"extensions": merged_extensions})

                assert_accepts_allowlisted_after_extension_enrich(
                    baseline_accepts, working_accepts, key
                )
                baseline_accepts = snapshot_payment_requirements_list(working_accepts)

        return response

    def _enrich_settlement_response(
        self,
        settle_result: SettleResponse,
        context: SettleResultContext,
        declared_extensions: dict[str, Any],
        matched_scheme: dict[str, str],
        run_hook: Callable[..., Any],
    ) -> None:
        if not settle_result.success:
            return

        if declared_extensions:
            settle_core_snapshot = snapshot_settle_response_core(settle_result)
            for key, declaration in declared_extensions.items():
                extension = self._extensions.get(key)
                enrich = getattr(extension, "enrich_settlement_response", None)
                if enrich is None:
                    continue

                try:
                    extension_data = run_hook(enrich, declaration, context)
                except Exception as hook_error:
                    self._warn_extension_hook_failure(key, "enrichSettlementResponse", hook_error)
                    extension_data = None

                if extension_data is not None:
                    merged_extensions = dict(settle_result.extensions or {})
                    merged_extensions[key] = extension_data
                    settle_result.extensions = merged_extensions

                assert_settle_response_core_unchanged(settle_core_snapshot, settle_result, key)

        scheme_server = self._find_registered_scheme(
            matched_scheme["scheme"], matched_scheme["network"]
        )
        enrich = getattr(scheme_server, "enrich_settlement_response", None)
        if enrich is None:
            return

        label = f'scheme "{matched_scheme["scheme"]}" enrichSettlementResponse'
        try:
            enrichment = run_hook(enrich, context)
        except Exception as hook_error:
            self._warn_resource_server_hook_failure("enrichSettlementResponse", label, hook_error)
            return

        if enrichment is None:
            return

        extra = dict(settle_result.extra or {})
        assert_additive_settlement_extra(extra, enrichment, label)
        settle_result.extra = merge_additive_settlement_extra(extra, enrichment)

    async def _enrich_settlement_response_async(
        self,
        settle_result: SettleResponse,
        context: SettleResultContext,
        declared_extensions: dict[str, Any],
        matched_scheme: dict[str, str],
    ) -> None:
        import asyncio

        async def invoke(hook: Any, *args: Any) -> Any:
            result = hook(*args)
            if asyncio.iscoroutine(result) or asyncio.isfuture(result):
                return await result
            return result

        if not settle_result.success:
            return

        if declared_extensions:
            settle_core_snapshot = snapshot_settle_response_core(settle_result)
            for key, declaration in declared_extensions.items():
                extension = self._extensions.get(key)
                enrich = getattr(extension, "enrich_settlement_response", None)
                if enrich is None:
                    continue

                try:
                    extension_data = await invoke(enrich, declaration, context)
                except Exception as hook_error:
                    self._warn_extension_hook_failure(key, "enrichSettlementResponse", hook_error)
                    extension_data = None

                if extension_data is not None:
                    merged_extensions = dict(settle_result.extensions or {})
                    merged_extensions[key] = extension_data
                    settle_result.extensions = merged_extensions

                assert_settle_response_core_unchanged(settle_core_snapshot, settle_result, key)

        scheme_server = self._find_registered_scheme(
            matched_scheme["scheme"], matched_scheme["network"]
        )
        enrich = getattr(scheme_server, "enrich_settlement_response", None)
        if enrich is None:
            return

        label = f'scheme "{matched_scheme["scheme"]}" enrichSettlementResponse'
        try:
            enrichment = await invoke(enrich, context)
        except Exception as hook_error:
            self._warn_resource_server_hook_failure("enrichSettlementResponse", label, hook_error)
            return

        if enrichment is None:
            return

        extra = dict(settle_result.extra or {})
        assert_additive_settlement_extra(extra, enrichment, label)
        settle_result.extra = merge_additive_settlement_extra(extra, enrichment)

    def _find_registered_scheme(self, scheme: str, network: Network) -> SchemeNetworkServer | None:
        schemes = find_schemes_by_network(self._schemes, network)
        if schemes is None:
            return None
        return schemes.get(scheme)

    @staticmethod
    def _run_enrich_hook_sync(hook: Any, *args: Any) -> Any:
        import inspect

        result = hook(*args)
        if inspect.iscoroutine(result):
            result.close()
            raise TypeError(
                "Async enrichment hooks are not supported in x402ResourceServerSync. "
                "Use x402ResourceServer for async enrichment hook support."
            )
        return result

    @staticmethod
    def _warn_extension_hook_failure(extension_key: str, hook_name: str, error: Exception) -> None:
        logger.warning(
            '[x402] Extension "%s" %s hook threw: %s',
            extension_key,
            hook_name,
            error,
        )

    # ========================================================================
    # Find Matching Requirements
    # ========================================================================

    def validate_extensions(
        self,
        payment_required: PaymentRequired,
        payment_payload: PaymentPayload | PaymentPayloadV1,
    ) -> ExtensionValidationResult:
        """Validate optional client extension echoes against server declarations.

        Skips v1, and passes when the client omits extensions. For each key the
        server declared, the echoed ``info`` must contain every advertised field
        (clients may add their own). Server-owned fields (e.g. builder-code ``a``)
        must also match the advertisement when present, including when the server
        did not declare the extension. Fields listed by a registered extension's
        ``dynamic_info_fields`` are regenerated per response and dropped before
        comparison; every other advertised field stays strict.
        """
        if getattr(payment_payload, "x402_version", None) != 2:
            return ExtensionValidationResult(valid=True)

        server_extensions = payment_required.extensions
        client_extensions = getattr(payment_payload, "extensions", None)
        if not client_extensions:
            return ExtensionValidationResult(valid=True)

        for key, echoed_value in client_extensions.items():
            advertised_info = _get_extension_info(
                _normalize_extension_value(
                    server_extensions.get(key) if server_extensions else None
                )
            )
            echoed_info = _get_extension_info(_normalize_extension_value(echoed_value))

            if server_extensions and key in server_extensions:
                extension = self._extensions.get(key)
                dynamic_fields = getattr(extension, "dynamic_info_fields", None)
                additive_fields = _ADDITIVE_LIST_INFO_FIELDS.get(key)
                max_lengths = _ADDITIVE_LIST_MAX_LENGTHS.get(key)

                if not _object_contains_subset(
                    _omit_fields(advertised_info, dynamic_fields),
                    _omit_fields(echoed_info, dynamic_fields),
                    additive_fields,
                    max_lengths,
                ):
                    return ExtensionValidationResult(
                        valid=False,
                        invalid_reason=ERR_EXTENSION_ECHO_MISMATCH,
                        extension_key=key,
                    )

            server_owned_fields = _SERVER_OWNED_INFO_FIELDS.get(key)
            if server_owned_fields and not _server_owned_info_fields_match(
                advertised_info, echoed_info, server_owned_fields
            ):
                return ExtensionValidationResult(
                    valid=False,
                    invalid_reason=ERR_EXTENSION_ECHO_MISMATCH,
                    extension_key=key,
                )

        return ExtensionValidationResult(valid=True)

    def find_matching_requirements(
        self,
        available: list[PaymentRequirements],
        payload: PaymentPayload,
    ) -> PaymentRequirements | None:
        """Find the server-advertised requirement that matches a client payload.

        For v2, all server-declared fields must match, including ``extra``
        (subset check). Scheme-declared ``dynamic_extra_fields`` are omitted
        from the extra comparison.
        """
        for req in available:
            scheme = self._find_registered_scheme(req.scheme, req.network)
            dynamic_extra_fields = getattr(scheme, "dynamic_extra_fields", None) if scheme else None
            if _payment_requirements_match_accepted(
                req,
                payload.accepted,
                dynamic_extra_fields,
            ):
                return req

        return None

    def get_payment_flow(
        self,
        _payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> PaymentFlowName:
        """Resolve the payment flow name for a payload/requirements pair.

        Flow is requirements-driven. Raises when no scheme is registered.
        """
        scheme = self._find_registered_scheme(requirements.scheme, requirements.network)
        if scheme is None:
            raise ValueError(
                "[x402] No server implementation registered for scheme: "
                f"{requirements.scheme}, network: {requirements.network}"
            )
        return resolve_payment_flow(scheme, requirements).payment_flow

    # ========================================================================
    # Extensions
    # ========================================================================

    def _finalize_settle_result(
        self,
        settle_result: SettleResponse,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
        payload_bytes: bytes | None,
        requirements_bytes: bytes | None,
        declared_extensions: dict[str, Any] | None,
        transport_context: Any,
        run_hook: Callable[..., Any],
        phase: SettlePhase = "after-handler",
    ) -> SettleResponse:
        if not settle_result.success:
            return settle_result

        result_context = SettleResultContext(
            payment_payload=payload,
            requirements=requirements,
            payload_bytes=payload_bytes,
            requirements_bytes=requirements_bytes,
            declared_extensions=declared_extensions or {},
            transport_context=transport_context,
            phase=phase,
            result=settle_result,
        )
        matched_scheme = {
            "scheme": requirements.scheme,
            "network": requirements.network,
        }
        self._enrich_settlement_response(
            settle_result,
            result_context,
            declared_extensions or {},
            matched_scheme,
            run_hook,
        )
        return settle_result

    async def _finalize_settle_result_async(
        self,
        settle_result: SettleResponse,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
        payload_bytes: bytes | None,
        requirements_bytes: bytes | None,
        declared_extensions: dict[str, Any] | None,
        transport_context: Any,
        phase: SettlePhase = "after-handler",
    ) -> SettleResponse:
        if not settle_result.success:
            return settle_result

        result_context = SettleResultContext(
            payment_payload=payload,
            requirements=requirements,
            payload_bytes=payload_bytes,
            requirements_bytes=requirements_bytes,
            declared_extensions=declared_extensions or {},
            transport_context=transport_context,
            phase=phase,
            result=settle_result,
        )
        matched_scheme = {
            "scheme": requirements.scheme,
            "network": requirements.network,
        }
        await self._enrich_settlement_response_async(
            settle_result,
            result_context,
            declared_extensions or {},
            matched_scheme,
        )
        return settle_result

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

    def create_payment_cancellation_dispatcher(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
        declared_extensions: dict[str, Any] | None = None,
        transport_context: Any = None,
        settled_phases: list[SettlePhase] | None = None,
    ) -> PaymentCancellationDispatcher:
        """Create cancellation controls for a verified payment attempt."""
        return PaymentCancellationDispatcher(
            self,
            payload,
            requirements,
            declared_extensions,
            transport_context,
            settled_phases,
        )

    @staticmethod
    def _warn_resource_server_hook_failure(phase: str, label: str, error: Exception) -> None:
        logger.warning(
            "[x402] Resource server %s hook threw (%s): %s",
            phase,
            label,
            error,
        )

    def _verified_payment_canceled_hooks(
        self,
        declared_extensions: dict[str, Any] | None,
        requirements: PaymentRequirements | PaymentRequirementsV1,
    ) -> list[tuple[str, Any]]:
        declared = declared_extensions or {}
        return get_labeled_server_hooks(
            "on_verified_payment_canceled",
            self,
            list(declared.keys()),
            {"network": requirements.network, "scheme": requirements.scheme},
        )

    def _build_verified_payment_canceled_context(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
        declared_extensions: dict[str, Any] | None,
        options: VerifiedPaymentCancelOptions,
        transport_context: Any,
        settled_phases: tuple[SettlePhase, ...] | list[SettlePhase] | None = None,
    ) -> VerifiedPaymentCanceledContext:
        return VerifiedPaymentCanceledContext(
            payment_payload=payload,
            requirements=requirements,
            declared_extensions=declared_extensions or {},
            transport_context=transport_context,
            phase="cancel",
            reason=options.reason,
            error=options.error,
            response_status=options.response_status,
            settled_phases=tuple(settled_phases or ()),
        )

    # ========================================================================
    # Core Logic Generators (shared between async/sync)
    # ========================================================================

    def _verify_payment_core(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
        payload_bytes: bytes | None,
        requirements_bytes: bytes | None,
        declared_extensions: dict[str, Any] | None = None,
        transport_context: Any = None,
    ) -> Generator[HookCommand, Any, ResourceVerifyResponse]:
        """Core verify logic as generator.

        Yields (phase, hook, context) tuples for hook execution.
        Also yields ("call_facilitator", client, (payload, requirements)) for the actual call.
        """
        if not self._initialized:
            raise RuntimeError("Server not initialized. Call initialize() first.")

        declared = declared_extensions or {}
        context = VerifyContext(
            payment_payload=payload,
            requirements=requirements,
            payload_bytes=payload_bytes,
            requirements_bytes=requirements_bytes,
            declared_extensions=declared,
            transport_context=transport_context,
        )
        matched_scheme = {
            "network": requirements.network,
            "scheme": requirements.scheme,
        }
        extension_keys = list(declared.keys())

        # Execute before hooks
        for _label, hook in get_labeled_server_hooks(
            "before_verify",
            self,
            extension_keys,
            matched_scheme,
        ):
            result = yield ("before", hook, context)
            if isinstance(result, AbortResult):
                from .schemas import PaymentAbortedError

                raise PaymentAbortedError(result.reason)
            if isinstance(result, SkipVerifyResult):
                verify_response = yield from self._run_after_verify_hooks(
                    payload,
                    requirements,
                    payload_bytes,
                    requirements_bytes,
                    declared_extensions,
                    transport_context,
                    result.result,
                    matched_scheme,
                    extension_keys,
                )
                return verify_response

        if isinstance(requirements, PaymentRequirements) and not isinstance(
            requirements, PaymentRequirementsV1
        ):
            flow = self.get_payment_flow(payload, requirements)  # type: ignore[arg-type]
            phases = resolve_payment_flow_phases(flow)
            if not phases.verify_before_handler:
                return ResourceVerifyResponse(verify=VerifyResponse(is_valid=True))

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
                    declared_extensions=declared_extensions or {},
                    transport_context=transport_context,
                    error=Exception(verify_result.invalid_reason or "Verification failed"),
                )
                for _label, hook in get_labeled_server_hooks(
                    "on_verify_failure",
                    self,
                    extension_keys,
                    matched_scheme,
                ):
                    result = yield ("failure", hook, failure_context)
                    if isinstance(result, RecoveredVerifyResult):
                        verify_response = yield from self._run_after_verify_hooks(
                            payload,
                            requirements,
                            payload_bytes,
                            requirements_bytes,
                            declared_extensions,
                            transport_context,
                            result.result,
                            matched_scheme,
                            extension_keys,
                        )
                        return verify_response

                return ResourceVerifyResponse(verify=verify_result)

            verify_response = yield from self._run_after_verify_hooks(
                payload,
                requirements,
                payload_bytes,
                requirements_bytes,
                declared_extensions,
                transport_context,
                verify_result,
                matched_scheme,
                extension_keys,
            )
            return verify_response

        except Exception as e:
            failure_context = VerifyFailureContext(
                payment_payload=payload,
                requirements=requirements,
                payload_bytes=payload_bytes,
                requirements_bytes=requirements_bytes,
                declared_extensions=declared,
                transport_context=transport_context,
                error=e,
            )
            for _label, hook in get_labeled_server_hooks(
                "on_verify_failure",
                self,
                extension_keys,
                matched_scheme,
            ):
                result = yield ("failure", hook, failure_context)
                if isinstance(result, RecoveredVerifyResult):
                    verify_response = yield from self._run_after_verify_hooks(
                        payload,
                        requirements,
                        payload_bytes,
                        requirements_bytes,
                        declared_extensions,
                        transport_context,
                        result.result,
                        matched_scheme,
                        extension_keys,
                    )
                    return verify_response

            raise

    def _run_after_verify_hooks(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
        payload_bytes: bytes | None,
        requirements_bytes: bytes | None,
        declared_extensions: dict[str, Any] | None,
        transport_context: Any,
        verify_result: VerifyResponse,
        matched_scheme: dict[str, str] | None = None,
        extension_keys: list[str] | None = None,
    ) -> Generator[HookCommand, Any, ResourceVerifyResponse]:
        """Run after-verify hooks and attach any skip-handler directive.

        On AbortResult: stop remaining hooks, dispatch after_verify_aborted
        cancellation, and return an invalid verify response.
        """
        skip_handler: SkipHandlerDirective | None = None
        declared = declared_extensions or {}
        result_context = VerifyResultContext(
            payment_payload=payload,
            requirements=requirements,
            payload_bytes=payload_bytes,
            requirements_bytes=requirements_bytes,
            declared_extensions=declared,
            transport_context=transport_context,
            result=verify_result,
        )
        scheme = matched_scheme or {
            "network": requirements.network,
            "scheme": requirements.scheme,
        }
        keys = extension_keys if extension_keys is not None else list(declared.keys())
        for _label, hook in get_labeled_server_hooks(
            "after_verify",
            self,
            keys,
            scheme,
        ):
            hook_result = yield ("after", hook, result_context)
            if isinstance(hook_result, AbortResult):
                yield (
                    "dispatch_cancel",
                    VerifiedPaymentCancelOptions(reason="after_verify_aborted"),
                    (payload, requirements, declared_extensions, transport_context),
                )
                return ResourceVerifyResponse(
                    verify=VerifyResponse(
                        is_valid=False,
                        invalid_reason=hook_result.reason,
                        invalid_message=hook_result.message,
                    )
                )
            if isinstance(hook_result, SkipHandlerResult):
                skip_handler = hook_result.response or SkipHandlerDirective()

        return ResourceVerifyResponse(verify=verify_result, skip_handler=skip_handler)

    def _settle_payment_core(
        self,
        payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements | PaymentRequirementsV1,
        payload_bytes: bytes | None,
        requirements_bytes: bytes | None,
        declared_extensions: dict[str, Any] | None = None,
        transport_context: Any = None,
        phase: SettlePhase = "after-handler",
    ) -> Generator[HookCommand, Any, SettleResponse]:
        """Core settle logic as generator.

        Yields (phase, hook, context) tuples for hook execution.
        Also yields ("call_facilitator", client, (payload, requirements)) for the actual call.
        """
        if not self._initialized:
            raise RuntimeError("Server not initialized. Call initialize() first.")

        declared = declared_extensions or {}
        context = SettleContext(
            payment_payload=payload,
            requirements=requirements,
            payload_bytes=payload_bytes,
            requirements_bytes=requirements_bytes,
            declared_extensions=declared,
            transport_context=transport_context,
            phase=phase,
        )
        matched_scheme = {
            "network": requirements.network,
            "scheme": requirements.scheme,
        }
        extension_keys = list(declared.keys())

        # Execute before hooks
        for _label, hook in get_labeled_server_hooks(
            "before_settle",
            self,
            extension_keys,
            matched_scheme,
        ):
            result = yield ("before", hook, context)
            if isinstance(result, AbortResult):
                from .schemas import PaymentAbortedError

                raise PaymentAbortedError(result.reason)
            if isinstance(result, SkipSettleResult):
                result_context = SettleResultContext(
                    payment_payload=payload,
                    requirements=requirements,
                    payload_bytes=payload_bytes,
                    requirements_bytes=requirements_bytes,
                    declared_extensions=declared_extensions or {},
                    transport_context=transport_context,
                    phase=phase,
                    result=result.result,
                )
                for _label, after_hook in get_labeled_server_hooks(
                    "after_settle",
                    self,
                    extension_keys,
                    matched_scheme,
                ):
                    yield ("after", after_hook, result_context)
                return result.result

        try:
            # Get scheme and network
            scheme = payload.get_scheme()
            network = payload.get_network()

            # Enrich the settlement payload before sending to facilitator (e.g. refund enrichment).
            # Use a separate facilitator_payload so hooks always operate on the original payload
            # (they key request contexts by id(payload), which model_copy changes).
            facilitator_payload = payload
            scheme_server = self._find_registered_scheme(scheme, network)
            enrich_payload = getattr(scheme_server, "enrich_settlement_payload", None)
            if enrich_payload is not None:
                enrichment = enrich_payload(context)
                if enrichment is not None:
                    label = f'scheme "{scheme}" enrich_settlement_payload'
                    assert_additive_payload_enrichment(payload.payload, enrichment, label)
                    facilitator_payload = payload.model_copy(
                        update={"payload": {**payload.payload, **enrichment}}
                    )

            # Find facilitator client
            client = self._facilitator_clients_map.get(network, {}).get(scheme)
            if client is None:
                raise SchemeNotFoundError(scheme, network)

            # Yield for facilitator call (caller handles sync/async)
            settle_result: SettleResponse = yield (
                "call_facilitator",
                client,
                ("settle", facilitator_payload, requirements),
            )

            # Check if settlement failed
            if not settle_result.success:
                failure_context = SettleFailureContext(
                    payment_payload=payload,
                    requirements=requirements,
                    payload_bytes=payload_bytes,
                    requirements_bytes=requirements_bytes,
                    declared_extensions=declared_extensions or {},
                    transport_context=transport_context,
                    phase=phase,
                    error=Exception(settle_result.error_reason or "Settlement failed"),
                )
                for _label, hook in get_labeled_server_hooks(
                    "on_settle_failure",
                    self,
                    extension_keys,
                    matched_scheme,
                ):
                    result = yield ("failure", hook, failure_context)
                    if isinstance(result, RecoveredSettleResult):
                        result_context = SettleResultContext(
                            payment_payload=payload,
                            requirements=requirements,
                            payload_bytes=payload_bytes,
                            requirements_bytes=requirements_bytes,
                            declared_extensions=declared,
                            transport_context=transport_context,
                            phase=phase,
                            result=result.result,
                        )
                        for _after_label, after_hook in get_labeled_server_hooks(
                            "after_settle",
                            self,
                            extension_keys,
                            matched_scheme,
                        ):
                            yield ("after", after_hook, result_context)
                        return result.result

                return settle_result

            # Execute after hooks for success
            result_context = SettleResultContext(
                payment_payload=payload,
                requirements=requirements,
                payload_bytes=payload_bytes,
                requirements_bytes=requirements_bytes,
                declared_extensions=declared,
                transport_context=transport_context,
                phase=phase,
                result=settle_result,
            )
            for _label, hook in get_labeled_server_hooks(
                "after_settle",
                self,
                extension_keys,
                matched_scheme,
            ):
                yield ("after", hook, result_context)

            return settle_result

        except Exception as e:
            failure_context = SettleFailureContext(
                payment_payload=payload,
                requirements=requirements,
                payload_bytes=payload_bytes,
                requirements_bytes=requirements_bytes,
                declared_extensions=declared,
                transport_context=transport_context,
                phase=phase,
                error=e,
            )
            for _label, hook in get_labeled_server_hooks(
                "on_settle_failure",
                self,
                extension_keys,
                matched_scheme,
            ):
                result = yield ("failure", hook, failure_context)
                if isinstance(result, RecoveredSettleResult):
                    return result.result

            raise
