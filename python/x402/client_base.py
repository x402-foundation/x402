"""x402Client base classes and internal types.

Contains shared logic for client implementations.
"""

from __future__ import annotations

import asyncio
import inspect
import re
from collections.abc import Awaitable, Callable, Generator
from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

from typing_extensions import Self

from .hook_adapters import collect_client_scheme_hook_handles, get_labeled_client_hooks
from .interfaces import SchemeNetworkClient, SchemeNetworkClientV1
from .schemas import (
    AbortResult,
    Money,
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
    PaymentResponseContext,
    RecoveredPayloadResult,
    RecoveredResponseResult,
    ResourceInfo,
    SchemeNotFoundError,
    find_schemes_by_network,
    matches_network_pattern,
)
from .schemas.extensions import ClientExtension
from .schemas.helpers import convert_to_token_amount, parse_money
from .server_base import _ADDITIVE_LIST_INFO_FIELDS

# ============================================================================
# Extension merging
# ============================================================================


def _merge_extensions(
    server_extensions: dict[str, Any] | None,
    client_extensions: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Deep-merge server-declared extensions with client/scheme extension data.

    Mirrors the TypeScript ``x402Client.mergeExtensions`` semantics so payment
    payloads are structurally identical across language implementations. The
    server's declared extension entry (e.g. ``info.description`` and the
    ``schema`` object) is preserved, while the client overlays only NEW fields
    it populates (e.g. the signed ``from``/``signature``/... permit data). For
    conflicting leaf fields the server value wins, except fields listed in
    ``_ADDITIVE_LIST_INFO_FIELDS`` (e.g. builder-code ``s``): a conflicting
    list there is concatenated with client entries first (so a downstream
    length cap trims server entries rather than the client's) and duplicates
    removed, with a bare scalar on either side treated as a single-element
    list.

    Without this, a shallow ``{**server, **client}`` replace would drop the
    server's ``schema`` from gas-sponsoring extensions, which strict Go/TS
    resource servers reject before the payment reaches the facilitator.

    Args:
        server_extensions: Extensions declared by the server in the 402 response.
        client_extensions: Extensions provided by the client or scheme.

    Returns:
        The merged extensions object, or ``None`` if both inputs are empty.
    """
    if not client_extensions:
        return server_extensions or None
    if not server_extensions:
        return client_extensions or None

    def _is_mergeable(value: Any) -> bool:
        return isinstance(value, dict)

    merged: dict[str, Any] = {**server_extensions}
    for key, client_value in client_extensions.items():
        server_value = merged.get(key)
        if not _is_mergeable(server_value) or not _is_mergeable(client_value):
            merged[key] = client_value
            continue
        additive_fields = _ADDITIVE_LIST_INFO_FIELDS.get(key)
        merged[key] = _deep_overlay(server_value, client_value, additive_fields)
    return merged


def _merge_lists_unique(client: list[Any], server: list[Any]) -> list[Any]:
    """Concatenate ``client`` then ``server``, dropping duplicates wherever they
    occur, including within either input list.

    Client entries lead so a downstream length cap (e.g. builder-code's
    MAX_SERVICE_CODES) trims excess server entries rather than the client's.
    """
    merged: list[Any] = []
    for item in [*client, *server]:
        if item not in merged:
            merged.append(item)
    return merged


def _scalar_to_list(value: Any) -> list[Any] | None:
    """Wrap a bare scalar as a single-element list for merging against a list
    field on the other side (e.g. builder-code ``s`` accepts a string or a
    list of strings). Returns ``None`` for values that cannot participate
    (missing, dict).
    """
    if value is None or isinstance(value, dict):
        return None
    return [value]


def _deep_overlay(
    target: dict[str, Any],
    source: dict[str, Any],
    additive_fields: set[str] | None = None,
) -> dict[str, Any]:
    """Recursively overlay ``source`` onto a copy of ``target``.

    Nested dicts are merged recursively. When ``field_key`` is in
    ``additive_fields`` (e.g. builder-code's ``s``) and either side is a
    list, conflicting lists are concatenated (client first, deduped), with a
    bare scalar on either side treated as a single-element list. For every
    other leaf field, including non-additive list conflicts, the existing
    ``target`` (server) value is kept and only missing keys are added from
    ``source`` (client). Matches the TS ``mergeExtensions`` inner loop.
    """
    result: dict[str, Any] = {**target}
    for field_key, source_value in source.items():
        target_value = result.get(field_key)
        if isinstance(target_value, dict) and isinstance(source_value, dict):
            result[field_key] = _deep_overlay(target_value, source_value, additive_fields)
        elif (
            additive_fields
            and field_key in additive_fields
            and (isinstance(target_value, list) or isinstance(source_value, list))
        ):
            target_list = (
                target_value if isinstance(target_value, list) else _scalar_to_list(target_value)
            )
            source_list = (
                source_value if isinstance(source_value, list) else _scalar_to_list(source_value)
            )
            if target_list is not None and source_list is not None:
                result[field_key] = _merge_lists_unique(source_list, target_list)
            elif field_key not in result:
                result[field_key] = source_value
        elif field_key not in result:
            result[field_key] = source_value
    return result


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


# Default USD cap for recognized default assets. Override via SpendControls.
DEFAULT_MAX_AMOUNT_PER_PAYMENT: Money = "$1"

_ATOMIC_AMOUNT = re.compile(r"^\d+$")


class _SpendControlAssetRequired(TypedDict):
    network: Network
    asset: str


class SpendControlAsset(_SpendControlAssetRequired, total=False):
    """Opt-in asset for SpendControls.allowed_assets.

    Default assets are always allowed; list non-default tokens here (and optional
    integer atomic caps, e.g. ``"2000000"``, not ``"$1"``).
    """

    max_amount_per_payment: str


class SpendControls(TypedDict, total=False):
    """Client spend controls (enforced before policies).

    By default only assets ``find_default_asset`` recognizes are allowed, capped at
    ``DEFAULT_MAX_AMOUNT_PER_PAYMENT``. Pass ``spend_controls=False`` to disable
    all spend controls (any asset, no caps).
    """

    max_amount_per_payment: Money | Literal[False]
    allowed_assets: Literal[True] | list[SpendControlAsset]


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
    spend_controls: SpendControls | Literal[False] | None = None
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

OnPaymentResponseHook = Callable[
    [PaymentResponseContext],
    Awaitable[RecoveredResponseResult | None] | RecoveredResponseResult | None,
]
SyncOnPaymentResponseHook = Callable[[PaymentResponseContext], RecoveredResponseResult | None]

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
        self._spend_controls: SpendControls | Literal[False] = {}
        self._registered_extensions: dict[str, ClientExtension] = {}
        self._scheme_client_hook_adapters: dict[int, dict[Network, dict[str, Any]]] = {}

        # Hooks (typed in subclasses)
        self._before_payment_creation_hooks: list[Any] = []
        self._after_payment_creation_hooks: list[Any] = []
        self._on_payment_creation_failure_hooks: list[Any] = []
        self._payment_response_hooks: list[Any] = []

    # ========================================================================
    # Registration
    # ========================================================================

    def register(self, network: Network, client: SchemeNetworkClient) -> Self:
        """Register a V2 scheme client for a network."""
        if network not in self._schemes:
            self._schemes[network] = {}
        self._schemes[network][client.scheme] = client

        handles = collect_client_scheme_hook_handles(client)
        if handles.is_empty():
            by_scheme = self._scheme_client_hook_adapters.get(2, {}).get(network)
            if by_scheme is not None:
                by_scheme.pop(client.scheme, None)
                if not by_scheme:
                    self._scheme_client_hook_adapters.get(2, {}).pop(network, None)
        else:
            if 2 not in self._scheme_client_hook_adapters:
                self._scheme_client_hook_adapters[2] = {}
            if network not in self._scheme_client_hook_adapters[2]:
                self._scheme_client_hook_adapters[2][network] = {}
            self._scheme_client_hook_adapters[2][network][client.scheme] = handles
        return self

    def register_v1(self, network: Network, client: SchemeNetworkClientV1) -> Self:
        """Register a V1 scheme client for a network."""
        if network not in self._schemes_v1:
            self._schemes_v1[network] = {}
        self._schemes_v1[network][client.scheme] = client

        handles = collect_client_scheme_hook_handles(client)  # type: ignore[arg-type]
        if handles.is_empty():
            by_scheme = self._scheme_client_hook_adapters.get(1, {}).get(network)
            if by_scheme is not None:
                by_scheme.pop(client.scheme, None)
                if not by_scheme:
                    self._scheme_client_hook_adapters.get(1, {}).pop(network, None)
        else:
            if 1 not in self._scheme_client_hook_adapters:
                self._scheme_client_hook_adapters[1] = {}
            if network not in self._scheme_client_hook_adapters[1]:
                self._scheme_client_hook_adapters[1][network] = {}
            self._scheme_client_hook_adapters[1][network][client.scheme] = handles
        return self

    def register_extension(self, extension: ClientExtension) -> Self:
        """Register a client extension that can enrich payment payloads.

        Every registered extension's ``enrich_payment_payload`` hook is called
        after the scheme creates the base payload. Server-declared fields are
        preserved via merge after enrichment.
        """
        self._registered_extensions[extension.key] = extension
        return self

    def get_extensions(self) -> list[ClientExtension]:
        """Return all registered client extensions."""
        return list(self._registered_extensions.values())

    def register_policy(self, policy: PaymentPolicy) -> Self:
        """Add a requirement filter policy."""
        self._policies.append(policy)
        return self

    def set_spend_controls(self, controls: SpendControls | Literal[False]) -> Self:
        """Replace spend controls. Pass ``False`` to disable all spend controls.

        When an object is passed, omitted ``max_amount_per_payment`` still defaults to
        ``DEFAULT_MAX_AMOUNT_PER_PAYMENT``.
        """
        self._spend_controls = controls
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

        # Enforce spend controls, then apply policies
        filtered: list[RequirementsView] = self._apply_spend_controls(2, supported, self._schemes)
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

        # Enforce spend controls, then apply policies
        filtered: list[RequirementsView] = self._apply_spend_controls(
            1, supported, self._schemes_v1
        )
        for policy in self._policies:
            filtered = policy(1, filtered)
            if not filtered:
                raise NoMatchingRequirementsError("All requirements filtered out by policies")

        # Select final
        return self._selector(1, filtered)  # type: ignore[return-value]

    def _apply_spend_controls(
        self,
        x402_version: int,
        requirements: list[RequirementsView],
        client_schemes_by_network: dict[Network, dict[str, Any]],
    ) -> list[RequirementsView]:
        """Filter by spend controls (default-asset allowlist → opt-in assets → caps).

        Keeps any accept that fits so a mixed offer can still pay the affordable option.
        """
        controls = self._spend_controls
        if controls is False:
            return list(requirements)

        def raw_amount_of(requirement: RequirementsView) -> str:
            return requirement.get_amount()

        def amount_of(requirement: RequirementsView) -> int:
            return int(raw_amount_of(requirement))

        def scheme_for(requirement: RequirementsView) -> Any:
            schemes = find_schemes_by_network(client_schemes_by_network, requirement.network)
            if schemes is None:
                return None
            return schemes.get(requirement.scheme)

        def default_asset_for(requirement: RequirementsView) -> dict[str, Any] | None:
            scheme = scheme_for(requirement)
            finder = getattr(scheme, "find_default_asset", None) if scheme is not None else None
            if not callable(finder):
                return None
            return finder(requirement.asset, requirement.network)

        def matches_asset_entry(entry: SpendControlAsset, requirement: RequirementsView) -> bool:
            if not matches_network_pattern(requirement.network, entry["network"]):
                return False
            if entry["asset"].lower() == requirement.asset.lower():
                return True
            default_asset = default_asset_for(requirement)
            return (
                default_asset is not None
                and default_asset["symbol"].lower() == entry["asset"].lower()
            )

        asset_entries = (
            None if controls.get("allowed_assets") is True else controls.get("allowed_assets")
        )
        allow_any_asset = controls.get("allowed_assets") is True

        def find_asset_entry(requirement: RequirementsView) -> SpendControlAsset | None:
            if not asset_entries:
                return None
            for entry in asset_entries:
                if matches_asset_entry(entry, requirement):
                    return entry
            return None

        if allow_any_asset:
            filtered = list(requirements)
        else:
            filtered = [
                requirement
                for requirement in requirements
                if default_asset_for(requirement) is not None
                or find_asset_entry(requirement) is not None
            ]
        if not filtered:
            raise NoMatchingRequirementsError(
                "All payment requirements were rejected by spend_controls: only default assets "
                "or entries in spend_controls.allowed_assets are allowed. Add an allowed_assets "
                "entry for non-default tokens, set allowed_assets: True, or set spend_controls: False."
            )

        usd_limit: Money | Literal[False]
        if controls.get("max_amount_per_payment") is False:
            usd_limit = False
        else:
            usd_limit = controls.get("max_amount_per_payment", DEFAULT_MAX_AMOUNT_PER_PAYMENT)

        before_amount_caps = filtered
        rejected_by_asset_cap = False
        rejected_usd_symbol: str | None = None

        kept: list[RequirementsView] = []
        for requirement in filtered:
            asset_entry = find_asset_entry(requirement)
            if asset_entry is not None and asset_entry.get("max_amount_per_payment") is not None:
                cap = asset_entry["max_amount_per_payment"]
                if not _ATOMIC_AMOUNT.fullmatch(cap):
                    raise ValueError(
                        "spend_controls.allowed_assets[].max_amount_per_payment must be an "
                        f"integer atomic amount, not a dollar value; got {cap!r}"
                    )
                if not _ATOMIC_AMOUNT.fullmatch(raw_amount_of(requirement)):
                    rejected_by_asset_cap = True
                    continue
                ok = amount_of(requirement) <= int(cap)
                if not ok:
                    rejected_by_asset_cap = True
                else:
                    kept.append(requirement)
                continue

            default_asset = default_asset_for(requirement)
            if not default_asset:
                kept.append(requirement)
                continue

            if usd_limit is False:
                kept.append(requirement)
                continue

            raw_amount = raw_amount_of(requirement)
            if not _ATOMIC_AMOUNT.fullmatch(raw_amount):
                value_scaled = int(convert_to_token_amount(raw_amount, 18))
                cap_scaled = int(convert_to_token_amount(parse_money(usd_limit)["amount"], 18))
                ok = value_scaled <= cap_scaled
                if not ok:
                    rejected_usd_symbol = default_asset["symbol"]
                else:
                    kept.append(requirement)
                continue

            max_atomic = int(
                convert_to_token_amount(
                    parse_money(usd_limit)["amount"],
                    default_asset["decimals"],
                )
            )
            ok = amount_of(requirement) <= max_atomic
            if not ok:
                rejected_usd_symbol = default_asset["symbol"]
            else:
                kept.append(requirement)

        filtered = kept
        if not filtered:
            if rejected_by_asset_cap and all(
                (entry := find_asset_entry(requirement)) is not None
                and entry.get("max_amount_per_payment") is not None
                for requirement in before_amount_caps
            ):
                raise NoMatchingRequirementsError(
                    "All payment requirements were rejected by spend_controls.allowed_assets "
                    "max_amount_per_payment. Raise the per-asset cap, or omit max_amount_per_payment "
                    "to allow uncapped (default assets then fall back to the top-level USD cap)."
                )
            symbol_note = f", including {rejected_usd_symbol}" if rejected_usd_symbol else ""
            raise NoMatchingRequirementsError(
                f"All payment requirements were rejected by spend_controls.max_amount_per_payment "
                f"({usd_limit}{symbol_note}). "
                "Raise max_amount_per_payment, set it to False to disable, "
                "set allowed_assets[].max_amount_per_payment for a per-asset atomic cap, "
                "or set spend_controls: False to disable all spend controls."
            )

        return filtered

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

    def _enrich_payment_payload_with_extensions(
        self,
        payment_payload: PaymentPayload,
        payment_required: PaymentRequired,
    ) -> PaymentPayload:
        if not self._registered_extensions:
            return payment_payload

        enriched = payment_payload
        for extension in self._registered_extensions.values():
            enrich = getattr(extension, "enrich_payment_payload", None)
            if enrich is None:
                continue
            enriched = enrich(enriched, payment_required)

        # Re-merge so server-declared extension fields survive registered client
        # extensions: the server's declared entry is preserved while the client
        # overlays only the new fields it populated.
        return enriched.model_copy(
            update={
                "extensions": _merge_extensions(
                    payment_required.extensions,
                    enriched.extensions,
                )
            }
        )

    async def _enrich_payment_payload_with_extensions_async(
        self,
        payment_payload: PaymentPayload,
        payment_required: PaymentRequired,
    ) -> PaymentPayload:
        if not self._registered_extensions:
            return payment_payload

        enriched = payment_payload
        for extension in self._registered_extensions.values():
            enrich = getattr(extension, "enrich_payment_payload", None)
            if enrich is None:
                continue
            result = enrich(enriched, payment_required)
            if asyncio.iscoroutine(result) or asyncio.isfuture(result):
                enriched = await result
            else:
                enriched = result

        # Re-merge so server-declared extension fields survive registered client
        # extensions: the server's declared entry is preserved while the client
        # overlays only the new fields it populated.
        return enriched.model_copy(
            update={
                "extensions": _merge_extensions(
                    payment_required.extensions,
                    enriched.extensions,
                )
            }
        )

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
        declared_extensions = payment_required.extensions or {}

        # 3. Execute before hooks
        for _label, hook in get_labeled_client_hooks(
            "before_payment_creation",
            self,
            2,
            selected,
            declared_extensions,
        ):
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

            # 5b. Extract scheme-generated extensions (e.g. gas sponsoring) and
            # deep-merge them onto the server's declared extensions. This keeps
            # the server's `schema` (and `info.description`/`version`) intact
            # while overlaying the client's signed fields — matching the TS
            # client. A shallow replace would drop `schema`, which strict Go/TS
            # resource servers reject before reaching the facilitator.
            scheme_extensions = inner_payload.pop("__extensions", None)
            base_extensions = extensions or payment_required.extensions or {}
            final_extensions = _merge_extensions(base_extensions, scheme_extensions)

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
            for _label, hook in get_labeled_client_hooks(
                "after_payment_creation",
                self,
                2,
                selected,
                declared_extensions,
            ):
                yield ("after", hook, result_context)

            return payload

        except Exception as e:
            # Execute failure hooks
            failure_context = PaymentCreationFailureContext(
                payment_required=payment_required,
                selected_requirements=selected,
                error=e,
            )
            for _label, hook in get_labeled_client_hooks(
                "on_payment_creation_failure",
                self,
                2,
                selected,
                declared_extensions,
            ):
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
        declared_extensions = getattr(payment_required, "extensions", None) or {}

        # 3. Execute before hooks
        for _label, hook in get_labeled_client_hooks(
            "before_payment_creation",
            self,
            1,
            selected,
            declared_extensions,
        ):
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
            for _label, hook in get_labeled_client_hooks(
                "after_payment_creation",
                self,
                1,
                selected,
                declared_extensions,
            ):
                yield ("after", hook, result_context)

            return payload

        except Exception as e:
            # Execute failure hooks
            failure_context = PaymentCreationFailureContext(
                payment_required=payment_required,
                selected_requirements=selected,
                error=e,
            )
            for _label, hook in get_labeled_client_hooks(
                "on_payment_creation_failure",
                self,
                1,
                selected,
                declared_extensions,
            ):
                result = yield ("failure", hook, failure_context)
                if isinstance(result, RecoveredPayloadResult):
                    return result.payload  # type: ignore[return-value]

            raise
