"""Scheme and extension lifecycle hook adapters (manual → scheme → extension)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from .interfaces import SchemeNetworkClient, SchemeNetworkServer
from .schemas.helpers import find_schemes_by_network

ResourceServerHookPhase = Literal[
    "before_verify",
    "after_verify",
    "on_verify_failure",
    "before_settle",
    "after_settle",
    "on_settle_failure",
    "on_verified_payment_canceled",
]

ClientHookPhase = Literal[
    "before_payment_creation",
    "after_payment_creation",
    "on_payment_creation_failure",
    "on_payment_response",
]

_SERVER_MANUAL_HOOKS: dict[ResourceServerHookPhase, str] = {
    "before_verify": "_before_verify_hooks",
    "after_verify": "_after_verify_hooks",
    "on_verify_failure": "_on_verify_failure_hooks",
    "before_settle": "_before_settle_hooks",
    "after_settle": "_after_settle_hooks",
    "on_settle_failure": "_on_settle_failure_hooks",
    "on_verified_payment_canceled": "_on_verified_payment_canceled_hooks",
}

_CLIENT_MANUAL_HOOKS: dict[ClientHookPhase, str] = {
    "before_payment_creation": "_before_payment_creation_hooks",
    "after_payment_creation": "_after_payment_creation_hooks",
    "on_payment_creation_failure": "_on_payment_creation_failure_hooks",
    "on_payment_response": "_payment_response_hooks",
}

_SERVER_SCHEME_HOOK_ATTRS: dict[str, ResourceServerHookPhase] = {
    "on_before_verify": "before_verify",
    "onBeforeVerify": "before_verify",
    "before_verify": "before_verify",
    "on_after_verify": "after_verify",
    "onAfterVerify": "after_verify",
    "after_verify": "after_verify",
    "on_verify_failure": "on_verify_failure",
    "onVerifyFailure": "on_verify_failure",
    "on_before_settle": "before_settle",
    "onBeforeSettle": "before_settle",
    "before_settle": "before_settle",
    "on_after_settle": "after_settle",
    "onAfterSettle": "after_settle",
    "after_settle": "after_settle",
    "on_settle_failure": "on_settle_failure",
    "onSettleFailure": "on_settle_failure",
    "on_verified_payment_canceled": "on_verified_payment_canceled",
    "onVerifiedPaymentCanceled": "on_verified_payment_canceled",
}

_CLIENT_SCHEME_HOOK_ATTRS: dict[str, ClientHookPhase] = {
    "on_before_payment_creation": "before_payment_creation",
    "onBeforePaymentCreation": "before_payment_creation",
    "before_payment_creation": "before_payment_creation",
    "on_after_payment_creation": "after_payment_creation",
    "onAfterPaymentCreation": "after_payment_creation",
    "after_payment_creation": "after_payment_creation",
    "on_payment_creation_failure": "on_payment_creation_failure",
    "onPaymentCreationFailure": "on_payment_creation_failure",
    "on_payment_response": "on_payment_response",
    "onPaymentResponse": "on_payment_response",
}

_CLIENT_EXTENSION_HOOK_METHODS: dict[ClientHookPhase, str] = {
    "before_payment_creation": "on_before_payment_creation",
    "after_payment_creation": "on_after_payment_creation",
    "on_payment_creation_failure": "on_payment_creation_failure",
    "on_payment_response": "on_payment_response",
}

_SERVER_EXTENSION_HOOK_METHODS: dict[ResourceServerHookPhase, str] = {
    "before_verify": "on_before_verify",
    "after_verify": "on_after_verify",
    "on_verify_failure": "on_verify_failure",
    "before_settle": "on_before_settle",
    "after_settle": "on_after_settle",
    "on_settle_failure": "on_settle_failure",
    "on_verified_payment_canceled": "on_verified_payment_canceled",
}


@dataclass
class HookAdapterHandles:
    before_verify: Callable[..., Any] | None = None
    after_verify: Callable[..., Any] | None = None
    on_verify_failure: Callable[..., Any] | None = None
    before_settle: Callable[..., Any] | None = None
    after_settle: Callable[..., Any] | None = None
    on_settle_failure: Callable[..., Any] | None = None
    on_verified_payment_canceled: Callable[..., Any] | None = None

    def is_empty(self) -> bool:
        return all(
            getattr(self, phase) is None
            for phase in (
                "before_verify",
                "after_verify",
                "on_verify_failure",
                "before_settle",
                "after_settle",
                "on_settle_failure",
                "on_verified_payment_canceled",
            )
        )


@dataclass
class ClientHookAdapterHandles:
    before_payment_creation: Callable[..., Any] | None = None
    after_payment_creation: Callable[..., Any] | None = None
    on_payment_creation_failure: Callable[..., Any] | None = None
    on_payment_response: Callable[..., Any] | None = None

    def is_empty(self) -> bool:
        return all(
            getattr(self, phase) is None
            for phase in (
                "before_payment_creation",
                "after_payment_creation",
                "on_payment_creation_failure",
                "on_payment_response",
            )
        )


def bind_extension_hook(
    extension_key: str,
    hook: Callable[..., Any],
) -> Callable[[Any], Any]:
    """Wrap an extension hook so it runs only when the key is declared."""

    def wrapped(ctx: Any) -> Any:
        declared = getattr(ctx, "declared_extensions", None) or {}
        if extension_key not in declared:
            return None
        return hook(declared[extension_key], ctx)

    return wrapped


def bind_client_extension_hook(
    extension_key: str,
    hook: Callable[..., Any],
) -> Callable[[Any], Any]:
    """Wrap a client extension hook gated on payment_required.extensions."""

    def wrapped(ctx: Any) -> Any:
        declared = _client_extension_declarations(ctx)
        if extension_key not in declared:
            return None
        return hook(declared[extension_key], ctx)

    return wrapped


def _client_extension_declarations(ctx: Any) -> dict[str, Any]:
    payment_required = getattr(ctx, "payment_required", None)
    if payment_required is None:
        return {}
    extensions = getattr(payment_required, "extensions", None)
    return extensions if isinstance(extensions, dict) else {}


def _merge_scheme_hook_attrs(
    handles: HookAdapterHandles | ClientHookAdapterHandles,
    scheme_hooks: Any,
    attr_map: dict[str, str],
) -> None:
    for attr_name, phase in attr_map.items():
        if isinstance(scheme_hooks, dict):
            hook = scheme_hooks.get(attr_name)
        else:
            hook = getattr(scheme_hooks, attr_name, None)
        if hook is None:
            continue
        setattr(handles, phase, hook)


def collect_scheme_server_hook_handles(server: SchemeNetworkServer) -> HookAdapterHandles:
    handles = HookAdapterHandles()
    for phase, method_name in (
        ("before_verify", "before_verify"),
        ("after_verify", "after_verify"),
        ("on_verify_failure", "on_verify_failure"),
        ("before_settle", "before_settle"),
        ("after_settle", "after_settle"),
        ("on_settle_failure", "on_settle_failure"),
        ("on_verified_payment_canceled", "on_verified_payment_canceled"),
    ):
        hook = getattr(server, method_name, None)
        if callable(hook):
            setattr(handles, phase, hook)

    scheme_hooks = getattr(server, "scheme_hooks", None)
    if scheme_hooks is not None:
        _merge_scheme_hook_attrs(handles, scheme_hooks, _SERVER_SCHEME_HOOK_ATTRS)
    return handles


def collect_client_scheme_hook_handles(client: SchemeNetworkClient) -> ClientHookAdapterHandles:
    handles = ClientHookAdapterHandles()
    scheme_hooks = getattr(client, "scheme_hooks", None)
    if scheme_hooks is not None:
        _merge_scheme_hook_attrs(handles, scheme_hooks, _CLIENT_SCHEME_HOOK_ATTRS)
    return handles


def build_extension_server_hook_handles(
    extension_key: str,
    extension_hooks: Any,
) -> HookAdapterHandles:
    handles = HookAdapterHandles()
    for phase, method_name in _SERVER_EXTENSION_HOOK_METHODS.items():
        impl = getattr(extension_hooks, method_name, None)
        if impl is None:
            continue
        setattr(handles, phase, bind_extension_hook(extension_key, impl))
    return handles


def get_labeled_server_hooks(
    phase: ResourceServerHookPhase,
    server: Any,
    extension_keys_in_use: list[str],
    matched_scheme: dict[str, str] | None = None,
) -> list[tuple[str, Callable[..., Any]]]:
    manual_attr = _SERVER_MANUAL_HOOKS[phase]
    manual: list[Callable[..., Any]] = getattr(server, manual_attr)
    out: list[tuple[str, Callable[..., Any]]] = []
    for index, hook in enumerate(manual):
        out.append((f"manual {phase} hook #{index}", hook))

    if matched_scheme is not None:
        network = matched_scheme["network"]
        scheme = matched_scheme["scheme"]
        adapters_by_network: dict[str, dict[str, HookAdapterHandles]] = server._scheme_hook_adapters
        scheme_handles = None
        by_scheme = adapters_by_network.get(network)
        if by_scheme is not None:
            scheme_handles = by_scheme.get(scheme)
        if scheme_handles is None:
            by_scheme = find_schemes_by_network(adapters_by_network, network)
            if by_scheme is not None:
                scheme_handles = by_scheme.get(scheme)
        hook = getattr(scheme_handles, phase, None) if scheme_handles else None
        if hook is not None:
            out.append((f'scheme "{scheme}" {phase}', hook))

    in_use = set(extension_keys_in_use)
    for extension_key, adapter_handles in server._extension_hook_adapters.items():
        if extension_key not in in_use:
            continue
        hook = getattr(adapter_handles, phase, None)
        if hook is not None:
            out.append((f'extension "{extension_key}" {phase}', hook))
    return out


def get_labeled_client_hooks(
    phase: ClientHookPhase,
    client: Any,
    x402_version: int,
    requirements: Any,
    declared_extensions: dict[str, Any] | None,
) -> list[tuple[str, Callable[..., Any]]]:
    manual_attr = _CLIENT_MANUAL_HOOKS[phase]
    manual: list[Callable[..., Any]] = getattr(client, manual_attr)
    out: list[tuple[str, Callable[..., Any]]] = []
    for index, hook in enumerate(manual):
        out.append((f"manual {phase} hook #{index}", hook))

    adapters_by_version: dict[int, dict[str, dict[str, ClientHookAdapterHandles]]] = (
        client._scheme_client_hook_adapters
    )
    adapters_by_network = adapters_by_version.get(x402_version)
    scheme_handles = None
    if adapters_by_network is not None:
        by_scheme = adapters_by_network.get(requirements.network)
        if by_scheme is not None:
            scheme_handles = by_scheme.get(requirements.scheme)
        if scheme_handles is None:
            by_scheme = find_schemes_by_network(adapters_by_network, requirements.network)
            if by_scheme is not None:
                scheme_handles = by_scheme.get(requirements.scheme)
    hook = getattr(scheme_handles, phase, None) if scheme_handles else None
    if hook is not None:
        out.append((f'scheme "{requirements.scheme}" {phase}', hook))

    if not declared_extensions:
        return out

    method_name = _CLIENT_EXTENSION_HOOK_METHODS[phase]
    for extension_key, extension in client._registered_extensions.items():
        if extension_key not in declared_extensions:
            continue
        extension_hooks = getattr(extension, "hooks", None)
        if extension_hooks is None:
            continue
        impl = getattr(extension_hooks, method_name, None)
        if impl is None:
            continue
        out.append(
            (
                f'extension "{extension_key}" {phase}',
                bind_client_extension_hook(extension_key, impl),
            )
        )
    return out
