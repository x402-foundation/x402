"""Solana Sign-In-With-X (SIWS) support."""

from __future__ import annotations

from typing import Any

SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
SOLANA_TESTNET = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z"

_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def extract_solana_chain_reference(chain_id: str) -> str:
    """Extract chain reference from CAIP-2 Solana chainId."""
    return chain_id.split(":", 1)[1]


def decode_base58(encoded: str) -> bytes:
    """Decode Base58 string to bytes."""
    if not encoded:
        return b""
    leading_zeros = len(encoded) - len(encoded.lstrip("1"))
    num = 0
    for char in encoded:
        try:
            num = num * 58 + _BASE58_ALPHABET.index(char)
        except ValueError as e:
            raise ValueError(f"Invalid Base58 character: {char}") from e
    combined = num.to_bytes((num.bit_length() + 7) // 8, "big") if num else b""
    return b"\x00" * leading_zeros + combined


def encode_base58(data: bytes) -> str:
    """Encode bytes to Base58 string."""
    if not data:
        return ""
    leading_zeros = len(data) - len(data.lstrip(b"\x00"))
    num = int.from_bytes(data, "big")
    encoded = ""
    while num > 0:
        num, rem = divmod(num, 58)
        encoded = _BASE58_ALPHABET[rem] + encoded
    return "1" * leading_zeros + (encoded or "1")


def format_siws_message(info: Any, address: str) -> str:
    """Format SIWS message following CAIP-122 ABNF."""

    def _get(name: str, alias: str | None = None) -> Any:
        if hasattr(info, name):
            return getattr(info, name)
        return info.get(alias or name)

    lines = [
        f"{_get('domain')} wants you to sign in with your Solana account:",
        address,
        "",
    ]
    statement = _get("statement")
    if statement:
        lines.extend([statement, ""])
    lines.extend(
        [
            f"URI: {_get('uri')}",
            f"Version: {_get('version')}",
            f"Chain ID: {extract_solana_chain_reference(_get('chain_id', 'chainId'))}",
            f"Nonce: {_get('nonce')}",
            f"Issued At: {_get('issued_at', 'issuedAt')}",
        ]
    )
    expiration = _get("expiration_time", "expirationTime")
    if expiration:
        lines.append(f"Expiration Time: {expiration}")
    not_before = _get("not_before", "notBefore")
    if not_before:
        lines.append(f"Not Before: {not_before}")
    request_id = _get("request_id", "requestId")
    if request_id:
        lines.append(f"Request ID: {request_id}")
    resources = _get("resources")
    if resources:
        lines.append("Resources:")
        for resource in resources:
            lines.append(f"- {resource}")
    return "\n".join(lines)


def verify_solana_signature(message: str, signature: bytes, public_key: bytes) -> bool:
    """Verify Ed25519 signature for SIWS."""
    try:
        from nacl.exceptions import BadSignatureError
        from nacl.signing import VerifyKey
    except ImportError as e:
        raise ImportError(
            "SIWX Solana support requires PyNaCl. Install with: pip install x402[extensions]"
        ) from e

    try:
        VerifyKey(public_key).verify(signature + message.encode("utf-8"))
        return True
    except BadSignatureError:
        return False


def is_solana_signer(signer: Any) -> bool:
    """Detect if a signer is Solana-compatible."""
    if hasattr(signer, "sign_messages") and callable(getattr(signer, "sign_messages", None)):
        return True
    # x402 KeypairSigner wraps solders.Keypair
    if hasattr(signer, "keypair"):
        return True
    public_key = getattr(signer, "public_key", None) or getattr(signer, "publicKey", None)
    if public_key is not None:
        if hasattr(public_key, "to_base58") or hasattr(public_key, "toBase58"):
            return True
        if isinstance(public_key, str) and not public_key.startswith("0x"):
            return True
    return False
