"""Complete client flow for SIWX extension."""

from __future__ import annotations

from typing import Any

from .message import create_siwx_message
from .sign import get_evm_address, get_solana_address, sign_evm_message, sign_solana_message
from .types import SignatureType, SIWxExtensionInfo, SIWxPayload

CompleteSIWxInfo = SIWxExtensionInfo | dict[str, Any]


async def create_siwx_payload(server_extension: Any, signer: Any) -> SIWxPayload:
    """Create a complete SIWX payload from server extension info with selected chain."""
    chain_id = (
        server_extension.chain_id
        if hasattr(server_extension, "chain_id")
        else server_extension["chainId"]
    )
    is_solana = chain_id.startswith("solana:")
    address = get_solana_address(signer) if is_solana else get_evm_address(signer)
    message = create_siwx_message(server_extension, address)
    signature = (
        await sign_solana_message(message, signer)
        if is_solana
        else await sign_evm_message(message, signer)
    )

    def _get(name: str, alias: str | None = None) -> Any:
        if hasattr(server_extension, name):
            return getattr(server_extension, name)
        return server_extension.get(alias or name)

    sig_type: SignatureType = _get("type")
    return SIWxPayload(
        domain=_get("domain"),
        address=address,
        statement=_get("statement"),
        uri=_get("uri"),
        version=_get("version"),
        chain_id=chain_id,
        type=sig_type,
        nonce=_get("nonce"),
        issued_at=_get("issued_at", "issuedAt"),
        expiration_time=_get("expiration_time", "expirationTime"),
        not_before=_get("not_before", "notBefore"),
        request_id=_get("request_id", "requestId"),
        resources=_get("resources"),
        signature_scheme=_get("signature_scheme", "signatureScheme"),
        signature=signature,
    )
