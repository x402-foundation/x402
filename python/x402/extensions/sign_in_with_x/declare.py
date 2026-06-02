"""Server-side declaration helper for SIWX extension."""

from __future__ import annotations

from typing import Any

from .schema import build_siwx_schema
from .types import (
    SIGN_IN_WITH_X,
    DeclareSIWxOptions,
    SignatureType,
    SIWxExtensionInfo,
    SupportedChain,
)


def get_signature_type(network: str) -> SignatureType:
    """Derive signature type from CAIP-2 network identifier."""
    return "ed25519" if network.startswith("solana:") else "eip191"


def declare_siwx_extension(options: DeclareSIWxOptions | None = None) -> dict[str, Any]:
    """Create SIWX extension declaration for PaymentRequired.extensions."""
    opts = options or DeclareSIWxOptions()
    info = SIWxExtensionInfo(version=opts.version or "1")

    if opts.domain:
        info.domain = opts.domain
    if opts.resource_uri:
        info.uri = opts.resource_uri
        info.resources = [opts.resource_uri]
    if opts.statement:
        info.statement = opts.statement

    supported_chains: list[SupportedChain] = []
    if opts.network:
        networks = opts.network if isinstance(opts.network, list) else [opts.network]
        supported_chains = [
            SupportedChain(chain_id=network, type=get_signature_type(network))
            for network in networks
        ]

    declaration: dict[str, Any] = {
        "info": info.model_dump(by_alias=True, exclude_none=True),
        "supportedChains": [c.model_dump(by_alias=True) for c in supported_chains],
        "schema": build_siwx_schema(),
        "_options": opts,
    }
    return {SIGN_IN_WITH_X: declaration}
