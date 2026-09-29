"""Complete client flow for SIWX extension."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from .message import create_siwx_message
from .sign import get_evm_address, get_solana_address, sign_evm_message, sign_solana_message
from .types import SignatureType, SIWxExtensionInfo, SIWxPayload

CompleteSIWxInfo = SIWxExtensionInfo | dict[str, Any]


def assert_siwx_challenge_bound_to_origin(info: Any, response_url: str) -> None:
    """Verify that a SIWX challenge is bound to the origin of the resource that issued the 402.

    Checks `domain` and `uri` only. EIP-4361 `resources` may be cross-origin URIs and are not
    validated here (matching server-side validate_siwx_message).

    Args:
        info: Server extension info from the 402 response.
        response_url: Final URL of the 402 response (after redirects).

    Raises:
        ValueError: When domain or uri origin does not match.
    """
    origin = urlparse(response_url)
    domain = info.domain if hasattr(info, "domain") else info["domain"]
    uri = info.uri if hasattr(info, "uri") else info["uri"]

    if domain != origin.netloc:
        raise ValueError(
            f'SIWX challenge domain "{domain}" does not match response origin host "{origin.netloc}"'
        )

    uri_parsed = urlparse(uri)
    if not uri_parsed.scheme or not uri_parsed.netloc:
        raise ValueError(f'SIWX challenge uri "{uri}" is not a valid URL')

    uri_origin = f"{uri_parsed.scheme}://{uri_parsed.netloc}"
    origin_value = f"{origin.scheme}://{origin.netloc}"
    if uri_origin != origin_value:
        raise ValueError(
            f'SIWX challenge uri origin "{uri_origin}" does not match response origin "{origin_value}"'
        )


async def create_siwx_payload(server_extension: Any, signer: Any, request_url: str) -> SIWxPayload:
    """Create a complete SIWX payload from server extension info with selected chain.

    Args:
        server_extension: Server extension info with chain selected (includes chainId, type).
        signer: Wallet that can sign messages.
        request_url: Final URL of the 402 response (after redirects).
    """
    assert_siwx_challenge_bound_to_origin(server_extension, request_url)
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
