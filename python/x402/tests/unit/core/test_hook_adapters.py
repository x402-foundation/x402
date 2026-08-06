"""Tests for scheme and extension lifecycle hook adapter ordering."""

from __future__ import annotations

from typing import Any

from x402.hook_adapters import (
    ClientHookAdapterHandles,
    bind_extension_hook,
    build_extension_server_hook_handles,
    get_labeled_client_hooks,
    get_labeled_server_hooks,
)
from x402.interfaces import BeforeVerifyHookProvider
from x402.schemas import AbortResult, PaymentRequired, PaymentRequirements, VerifyContext
from x402.schemas.extensions import ClientExtension
from x402.server import x402ResourceServer


class _ManualBeforeVerify:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, _ctx: VerifyContext) -> None:
        self.calls += 1


class _SchemeBeforeVerify:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, _ctx: VerifyContext) -> None:
        self.calls += 1


class _SchemeServer(BeforeVerifyHookProvider):
    scheme = "exact"

    def __init__(self) -> None:
        self.before_verify_hook = _SchemeBeforeVerify()

    def before_verify(self, _ctx: VerifyContext) -> None:
        self.before_verify_hook(_ctx)

    def parse_price(self, price: Any, network: str) -> Any:
        raise NotImplementedError

    def enhance_payment_requirements(
        self, requirements: Any, supported_kind: Any, extensions: list
    ) -> Any:
        return requirements


class _ExtensionHooks:
    def on_before_verify(self, _declaration: Any, _ctx: VerifyContext) -> None:
        pass


class _Extension:
    key = "ext-a"

    @property
    def hooks(self) -> _ExtensionHooks:
        return _ExtensionHooks()


def test_bind_extension_hook_skips_when_key_not_declared():
    calls: list[str] = []

    def hook(declaration: Any, _ctx: VerifyContext) -> None:
        calls.append(declaration)

    wrapped = bind_extension_hook("ext-a", hook)
    ctx = VerifyContext(
        payment_payload=None,  # type: ignore[arg-type]
        requirements=None,  # type: ignore[arg-type]
        declared_extensions={"other": {}},
    )
    assert wrapped(ctx) is None
    assert calls == []


def test_get_labeled_server_hooks_ordering():
    server = x402ResourceServer()
    manual = _ManualBeforeVerify()
    server.on_before_verify(manual)
    server.register("eip155:8453", _SchemeServer())
    server.register_extension(_Extension())

    labels = [
        label
        for label, _hook in get_labeled_server_hooks(
            "before_verify",
            server,
            ["ext-a"],
            {"network": "eip155:8453", "scheme": "exact"},
        )
    ]
    assert labels[0].startswith("manual before_verify hook #")
    assert labels[1] == 'scheme "exact" before_verify'
    assert labels[2] == 'extension "ext-a" before_verify'


def test_get_labeled_server_hooks_extension_gated_off_route():
    handles = build_extension_server_hook_handles("ext-a", _ExtensionHooks())
    server = x402ResourceServer()
    server._extension_hook_adapters["ext-a"] = handles

    labels = [
        label
        for label, _ in get_labeled_server_hooks(
            "before_verify",
            server,
            [],
            {"network": "eip155:8453", "scheme": "exact"},
        )
    ]
    assert not any("extension" in label for label in labels)


class _ClientExtensionImpl:
    key = "ext-b"

    class _Hooks:
        def on_before_payment_creation(self, _declaration: Any, _ctx: Any) -> None:
            pass

    @property
    def hooks(self) -> _Hooks:
        return self._Hooks()


class _ClientStub:
    _before_payment_creation_hooks: list[Any]
    _after_payment_creation_hooks: list[Any]
    _on_payment_creation_failure_hooks: list[Any]
    _payment_response_hooks: list[Any]
    _registered_extensions: dict[str, ClientExtension]
    _scheme_client_hook_adapters: dict[int, dict[str, dict[str, Any]]]

    def __init__(self) -> None:
        self._before_payment_creation_hooks = [lambda _ctx: AbortResult(reason="manual")]
        self._after_payment_creation_hooks = []
        self._on_payment_creation_failure_hooks = []
        self._payment_response_hooks = []
        self._registered_extensions = {"ext-b": _ClientExtensionImpl()}  # type: ignore[assignment]
        scheme_handles = ClientHookAdapterHandles(
            before_payment_creation=lambda _ctx: AbortResult(reason="scheme"),
        )
        self._scheme_client_hook_adapters = {2: {"eip155:8453": {"exact": scheme_handles}}}


def test_get_labeled_client_hooks_ordering():
    client = _ClientStub()
    requirements = PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0xusdc",
        amount="1000",
        pay_to="0xpay",
        max_timeout_seconds=300,
    )
    payment_required = PaymentRequired(
        x402_version=2, accepts=[requirements], extensions={"ext-b": {}}
    )
    labels = [
        label
        for label, hook in get_labeled_client_hooks(
            "before_payment_creation",
            client,
            2,
            requirements,
            payment_required.extensions,
        )
    ]
    assert labels[0].startswith("manual before_payment_creation hook #")
    assert labels[1] == 'scheme "exact" before_payment_creation'
    assert labels[2] == 'extension "ext-b" before_payment_creation'
