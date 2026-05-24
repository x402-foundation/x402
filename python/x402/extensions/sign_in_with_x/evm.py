"""EVM Sign-In-With-Ethereum (SIWE) support."""

from __future__ import annotations

import re
from typing import Any, Protocol

from .types import EVMMessageVerifier

_EVM_CHAIN_RE = re.compile(r"^eip155:(\d+)$")


def extract_evm_chain_id(chain_id: str) -> int:
    """Extract numeric chain ID from CAIP-2 EVM chainId."""
    match = _EVM_CHAIN_RE.match(chain_id)
    if not match:
        raise ValueError(f"Invalid EVM chainId format: {chain_id}. Expected eip155:<number>")
    return int(match.group(1))


def format_siwe_message(info: Any, address: str) -> str:
    """Format SIWE message following EIP-4361."""
    try:
        from siwe import SiweMessage
    except ImportError as e:
        raise ImportError(
            "SIWX EVM support requires signinwithethereum. Install with: pip install x402[extensions]"
        ) from e

    numeric_chain_id = extract_evm_chain_id(
        info.chain_id if hasattr(info, "chain_id") else info["chainId"]
    )

    def _get(name: str, alias: str | None = None) -> Any:
        if hasattr(info, name):
            return getattr(info, name)
        return info.get(alias or name)

    siwe_message = SiweMessage(
        domain=_get("domain"),
        address=address,
        statement=_get("statement"),
        uri=_get("uri"),
        version=_get("version"),
        chain_id=numeric_chain_id,
        nonce=_get("nonce"),
        issued_at=_get("issued_at", "issuedAt"),
        expiration_time=_get("expiration_time", "expirationTime"),
        not_before=_get("not_before", "notBefore"),
        request_id=_get("request_id", "requestId"),
        resources=_get("resources"),
    )
    return siwe_message.prepare_message()


async def verify_evm_signature(
    message: str,
    address: str,
    signature: str,
    verifier: EVMMessageVerifier | None = None,
    *,
    provider: Any | None = None,
) -> bool:
    """Verify EVM signature (EOA by default; smart wallets with verifier or provider)."""
    if verifier is not None:
        return await verifier(address=address, message=message, signature=signature)

    try:
        from siwe import SiweMessage
    except ImportError as e:
        raise ImportError(
            "SIWX EVM support requires signinwithethereum. Install with: pip install x402[extensions]"
        ) from e

    try:
        parsed = SiweMessage.from_message(message)
        parsed.verify(
            signature=signature,
            domain=parsed.domain,
            nonce=parsed.nonce,
            uri=str(parsed.uri),
            chain_id=parsed.chain_id,
            strict=True,
            provider=provider,
        )
        return True
    except Exception:
        return False


class EVMSigner(Protocol):
    """Signer interface for EVM SIWX message signing."""

    async def sign_message(self, *, message: str, account: Any = None) -> str: ...

    @property
    def account(self) -> Any: ...

    @property
    def address(self) -> str: ...


def is_evm_signer(signer: Any) -> bool:
    """Detect if a signer is EVM-compatible."""
    if hasattr(signer, "sign_messages") and callable(getattr(signer, "sign_messages", None)):
        return False
    public_key = getattr(signer, "public_key", None) or getattr(signer, "publicKey", None)
    if public_key is not None:
        if hasattr(public_key, "to_base58") or hasattr(public_key, "toBase58"):
            return False
        if isinstance(public_key, str) and not public_key.startswith("0x"):
            return False
    account = getattr(signer, "account", None)
    if account is not None and getattr(account, "address", None):
        addr = account.address
        if isinstance(addr, str) and addr.startswith("0x"):
            return True
    addr = getattr(signer, "address", None)
    return isinstance(addr, str) and addr.startswith("0x")
