"""SIWX lifecycle hooks."""

from __future__ import annotations

import inspect
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from x402.http.types import HTTPRequestContext, PaymentOption, RouteConfig
from x402.schemas.extensions import ClientExtension
from x402.schemas.hooks import GrantAccessResult, PaymentRequiredHeadersResult

from .client import create_siwx_payload
from .encode import encode_siwx_header
from .parse import parse_siwx_header
from .solana import is_solana_signer
from .types import SIGN_IN_WITH_X, SignatureType, SIWxVerifyOptions
from .validate import validate_siwx_message
from .verify import verify_siwx_signature

SIWxHookEvent = dict[str, Any]


def normalize_configured_origin(origin: str) -> str:
    """Normalize and validate a configured SIWX origin."""
    parsed = urlparse(origin)

    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        if parsed.scheme and parsed.scheme not in ("http", "https"):
            raise ValueError(f'Invalid SIWX origin: "{origin}" must use http: or https:')
        raise ValueError(f'Invalid SIWX origin: "{origin}" is not a valid URL')

    if parsed.username or parsed.password:
        raise ValueError(f'Invalid SIWX origin: "{origin}" must not include credentials')

    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError(
            f'Invalid SIWX origin: "{origin}" must not include a path, query, or fragment'
        )

    return f"{parsed.scheme}://{parsed.netloc}"


@dataclass(kw_only=True)
class CreateSIWxSettleHookOptions:
    """Options for creating the SIWX settle hook."""

    storage: Any
    on_event: Callable[[SIWxHookEvent], None] | None = None


@dataclass(kw_only=True)
class CreateSIWxRequestHookOptions(CreateSIWxSettleHookOptions):
    """Options for creating the SIWX request hook and resource server extension."""

    origin: str
    verify_options: SIWxVerifyOptions | None = None


CreateSIWxHookOptions = CreateSIWxRequestHookOptions


@dataclass
class CreateSIWxClientExtensionOptions:
    """Options for creating the SIWX client extension."""

    signers: list[Any]


def create_siwx_settle_hook(options: CreateSIWxSettleHookOptions):
    """Create an onAfterSettle hook that records payments for SIWX."""

    async def hook(ctx: Any) -> None:
        if not ctx.result.success:
            return
        address = ctx.result.payer
        if not address:
            return
        resource = getattr(ctx.payment_payload, "resource", None)
        resource_url = resource.url if resource else None
        if not resource_url:
            return
        path = urlparse(resource_url).path
        storage = options.storage
        result = storage.record_payment(path, address)
        if inspect.isawaitable(result):
            await result
        if options.on_event:
            options.on_event({"type": "payment_recorded", "resource": path, "address": address})

    return hook


def create_siwx_request_hook(options: CreateSIWxRequestHookOptions):
    """Create an onProtectedRequest hook that validates SIWX auth."""
    configured_origin = normalize_configured_origin(options.origin)
    storage = options.storage
    has_used_nonce = callable(getattr(storage, "has_used_nonce", None))
    has_record_nonce = callable(getattr(storage, "has_record_nonce", None))
    if has_used_nonce != has_record_nonce:
        raise ValueError(
            "SIWxStorage nonce tracking requires both has_used_nonce and record_nonce "
            "to be implemented"
        )

    async def hook(
        context: HTTPRequestContext,
        route_config: RouteConfig | None = None,
    ) -> GrantAccessResult | None:
        adapter = context.adapter
        header = adapter.get_header(SIGN_IN_WITH_X) or adapter.get_header(SIGN_IN_WITH_X.lower())
        if not header:
            return None

        try:
            payload = parse_siwx_header(header)
            validation = await validate_siwx_message(payload, configured_origin)
            if not validation.valid:
                if options.on_event:
                    options.on_event(
                        {
                            "type": "validation_failed",
                            "resource": context.path,
                            "error": validation.error,
                        }
                    )
                return None

            verification = await verify_siwx_signature(payload, options.verify_options)
            if not verification.valid or not verification.address:
                if options.on_event:
                    options.on_event(
                        {
                            "type": "validation_failed",
                            "resource": context.path,
                            "error": verification.error,
                        }
                    )
                return None

            if has_used_nonce:
                nonce_used = storage.has_used_nonce(payload.nonce)
                if inspect.isawaitable(nonce_used):
                    nonce_used = await nonce_used
                if nonce_used:
                    if options.on_event:
                        options.on_event(
                            {
                                "type": "nonce_reused",
                                "resource": context.path,
                                "nonce": payload.nonce,
                            }
                        )
                    return None

            accepts = route_config.accepts if route_config else None
            if isinstance(accepts, PaymentOption):
                accept_list: list[Any] = [accepts]
            else:
                accept_list = list(accepts or [])
            is_auth_only = isinstance(accept_list, list) and len(accept_list) == 0

            has_paid = storage.has_paid(context.path, verification.address)
            if inspect.isawaitable(has_paid):
                has_paid = await has_paid
            should_grant = is_auth_only or has_paid
            if should_grant:
                if has_record_nonce:
                    record = storage.record_nonce(payload.nonce)
                    if inspect.isawaitable(record):
                        await record
                if options.on_event:
                    options.on_event(
                        {
                            "type": "access_granted",
                            "resource": context.path,
                            "address": verification.address,
                        }
                    )
                return GrantAccessResult()
        except Exception as err:
            if options.on_event:
                options.on_event(
                    {
                        "type": "validation_failed",
                        "resource": context.path,
                        "error": str(err),
                    }
                )
        return None

    return hook


def create_siwx_client_hook(signer: Any):
    """Create an onPaymentRequired hook for client-side SIWX authentication."""
    signer_is_solana = is_solana_signer(signer)
    expected_signature_type: SignatureType = "ed25519" if signer_is_solana else "eip191"

    async def hook(context: Any) -> PaymentRequiredHeadersResult | None:
        extensions = context.payment_required.extensions or {}
        siwx_extension = extensions.get(SIGN_IN_WITH_X)
        if not siwx_extension:
            return None
        if isinstance(siwx_extension, dict):
            supported = siwx_extension.get("supportedChains") or []
            info = siwx_extension.get("info") or {}
        else:
            supported = siwx_extension.supported_chains
            info = siwx_extension.info.model_dump(by_alias=True, exclude_none=True)

        if not supported:
            return None

        try:
            matching = next(
                (
                    c
                    for c in supported
                    if (c.get("type") if isinstance(c, dict) else c.type) == expected_signature_type
                ),
                None,
            )
            if matching is None:
                return None

            chain_id = matching["chainId"] if isinstance(matching, dict) else matching.chain_id
            sig_type = matching["type"] if isinstance(matching, dict) else matching.type
            complete_info = {**info, "chainId": chain_id, "type": sig_type}
            payload = await create_siwx_payload(complete_info, signer)
            header = encode_siwx_header(payload)
            return PaymentRequiredHeadersResult(headers={SIGN_IN_WITH_X: header})
        except Exception:
            return None

    return hook


def create_siwx_client_extension(options: CreateSIWxClientExtensionOptions) -> ClientExtension:
    """Create a SIWX client extension with HTTP transport hooks."""
    hooks = [create_siwx_client_hook(signer) for signer in options.signers]

    class _SIWxClientExtension:
        key = SIGN_IN_WITH_X

        @property
        def transport_hooks(self) -> _SIWxClientTransportHooks:
            return _SIWxClientTransportHooks(hooks=hooks)

    return _SIWxClientExtension()


@dataclass
class _SIWxClientTransportHooks:
    hooks: list[Any]

    @property
    def http(self) -> _SIWxClientHTTPHooks:
        return _SIWxClientHTTPHooks(self.hooks)


@dataclass
class _SIWxClientHTTPHooks:
    hooks: list[Any]

    async def on_payment_required(
        self, _declaration: Any, context: Any
    ) -> PaymentRequiredHeadersResult | None:
        for hook in self.hooks:
            result = await hook(context)
            if result is not None:
                return result
        return None
