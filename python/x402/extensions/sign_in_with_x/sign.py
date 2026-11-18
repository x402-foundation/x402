"""Message signing for SIWX extension."""

from __future__ import annotations

from typing import Any, Protocol

from .solana import encode_base58


class EVMSigner(Protocol):
    """Signer interface for EVM SIWX message signing."""

    async def sign_message(self, *, message: str, account: Any = None) -> str: ...


class SolanaSigner(Protocol):
    """Solana wallet signer (adapter or solders Keypair wrapper)."""

    async def sign_message(self, message: bytes) -> bytes: ...


SIWxSigner = Any


def get_evm_address(signer: Any) -> str:
    """Get address from an EVM signer."""
    account = getattr(signer, "account", None)
    if account is not None and getattr(account, "address", None):
        return account.address
    address = getattr(signer, "address", None)
    if isinstance(address, str):
        return address
    raise ValueError("EVM signer missing address")


def get_solana_address(signer: Any) -> str:
    """Get address from a Solana signer."""
    address = getattr(signer, "address", None)
    if isinstance(address, str) and address:
        return address
    public_key = getattr(signer, "public_key", None) or getattr(signer, "publicKey", None)
    if public_key is None:
        raise ValueError("Solana signer missing address or publicKey")
    if isinstance(public_key, str):
        return public_key
    if hasattr(public_key, "to_base58"):
        return public_key.to_base58()
    if hasattr(public_key, "toBase58"):
        return public_key.toBase58()
    raise ValueError("Solana signer missing address or publicKey")


async def sign_evm_message(message: str, signer: Any) -> str:
    """Sign a message with an EVM wallet and return hex-encoded signature."""
    try:
        from eth_account.messages import encode_defunct
    except ImportError as e:
        raise ImportError(
            "SIWX EVM signing requires eth-account. Install with: pip install x402[evm]"
        ) from e

    account = getattr(signer, "_account", None) or getattr(signer, "account", None)
    if account is None and hasattr(signer, "sign_message") and hasattr(signer, "address"):
        account = signer

    if account is not None and hasattr(account, "sign_message"):
        signed = account.sign_message(encode_defunct(text=message))
        raw = signed.signature
        return raw if isinstance(raw, str) and raw.startswith("0x") else "0x" + raw.hex()

    if hasattr(signer, "sign_message") and not hasattr(signer, "signMessage"):
        sig = signer.sign_message(message=message, account=getattr(signer, "account", None))
        if hasattr(sig, "__await__"):
            sig = await sig
        return _normalize_evm_signature(sig)

    raise ValueError("EVM signer missing sign_message support")


def _normalize_evm_signature(sig: Any) -> str:
    if hasattr(sig, "signature"):
        raw = sig.signature
        if isinstance(raw, bytes):
            return "0x" + raw.hex()
        return str(raw)
    if isinstance(sig, bytes):
        return "0x" + sig.hex()
    return str(sig)


async def sign_solana_message(message: str, signer: Any) -> str:
    """Sign a message with a Solana wallet and return Base58-encoded signature."""
    message_bytes = message.encode("utf-8")

    if hasattr(signer, "sign_messages") and callable(signer.sign_messages):
        results = signer.sign_messages([{"content": message_bytes, "signatures": {}}])
        if hasattr(results, "__await__"):
            results = await results
        sig_dict = results[0]
        signature_bytes = next(iter(sig_dict.values()))
        return encode_base58(signature_bytes)

    if hasattr(signer, "sign_message"):
        sig = signer.sign_message(message_bytes)
        if hasattr(sig, "__await__"):
            sig = await sig
        return encode_base58(bytes(sig))

    try:
        from solders.keypair import Keypair
    except ImportError as e:
        raise ImportError(
            "SIWX Solana signing requires solders. Install with: pip install x402[svm]"
        ) from e

    keypair = getattr(signer, "keypair", None)
    if isinstance(keypair, Keypair):
        return encode_base58(bytes(keypair.sign_message(message_bytes)))

    if isinstance(signer, Keypair):
        return encode_base58(bytes(signer.sign_message(message_bytes)))

    raise ValueError("Solana signer missing sign_message or sign_messages method")
