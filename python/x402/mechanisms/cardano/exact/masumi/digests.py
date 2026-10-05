"""Domain-separated commitments for Masumi inputs and payment terms."""

import base64
import re
from hashlib import sha256
from typing import Any

from .jcs import jcs


def commitment_part_bytes(part: dict[str, Any]) -> bytes:
    if "content" not in part:
        raise ValueError("Commitment part carries no content to digest")
    content = part["content"]
    if part["canonicalization"] == "raw":
        if not isinstance(content, str) or not re.fullmatch(r"[A-Za-z0-9_-]*", content):
            raise ValueError("Commitment raw content must be canonical unpadded base64url")
        try:
            decoded = base64.urlsafe_b64decode(content + "=" * (-len(content) % 4))
        except ValueError as exc:
            raise ValueError("Invalid base64url content") from exc
        if base64.urlsafe_b64encode(decoded).decode().rstrip("=") != content:
            raise ValueError("Commitment raw content is not canonical unpadded base64url")
        return decoded
    return jcs(content).encode("utf-8")


def commitment_part_digest(part: dict[str, Any]) -> str:
    return sha256(commitment_part_bytes(part)).hexdigest()


def compute_input_hash(commitment: dict[str, Any]) -> str:
    manifest = {
        "version": commitment["version"],
        "algorithm": commitment["algorithm"],
        "parts": [
            {
                key: part[key]
                for key in ("name", "canonicalization", "mediaType", "digest")
                if key in part
            }
            for part in commitment["parts"]
        ],
    }
    return sha256(b"masumi:x402:input:v1\n" + jcs(manifest).encode()).hexdigest()


def build_signed_terms(extra: dict[str, Any], requirements: Any) -> dict[str, Any]:
    return {
        **extra["terms"],
        "scheme": requirements.scheme,
        "assetTransferMethod": extra["assetTransferMethod"],
        "network": requirements.network,
        "contractAddress": requirements.pay_to,
        "amount": requirements.amount,
        "asset": requirements.asset,
        "maxTimeoutSeconds": requirements.max_timeout_seconds,
    }


def compute_terms_digest(signed_terms: dict[str, Any]) -> str:
    return sha256(b"masumi:x402:terms:v1\n" + jcs(signed_terms).encode()).hexdigest()
