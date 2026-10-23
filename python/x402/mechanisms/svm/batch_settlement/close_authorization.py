"""Receiver signatures over the scheme's domain-separated cooperative close."""

import hashlib
import struct
import time
from typing import Any

from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.signature import Signature

from ..payment_channels import PAYMENT_CHANNELS_PROGRAM_ID, MessageSigner, sign_message
from ..payment_channels.codec import checked_int

CLOSE_DOMAIN = b"x402:batch-settlement:svm:close:v1"


def encode_close_authorization_digest(
    *,
    network: str,
    fee_payer: str,
    channel_id: str,
    max_claimable_amount: int,
    valid_before: int,
    voucher_expires_at: int = 0,
    program_id: str = PAYMENT_CHANNELS_PROGRAM_ID,
) -> bytes:
    network_bytes = network.encode("utf-8")
    if not 1 <= len(network_bytes) <= 65535:
        raise ValueError("close authorization network must encode to 1 through 65535 bytes")
    if not 0 < checked_int(valid_before, 53, "valid_before"):
        raise ValueError("valid_before must be positive")
    return hashlib.sha256(
        CLOSE_DOMAIN
        + b"\0"
        + struct.pack("<H", len(network_bytes))
        + network_bytes
        + b"".join(bytes(Pubkey.from_string(key)) for key in (program_id, fee_payer, channel_id))
        + struct.pack(
            "<Qqq",
            checked_int(max_claimable_amount, 64, "max_claimable_amount"),
            checked_int(voucher_expires_at, 64, "voucher_expires_at", signed=True),
            valid_before,
        )
    ).digest()


def sign_close_authorization(signer: MessageSigner | Keypair, **binding: Any) -> dict[str, Any]:
    digest = encode_close_authorization_digest(**binding)
    return {"validBefore": binding["valid_before"], "signature": str(sign_message(signer, digest))}


def verify_close_authorization(
    authorization: dict[str, Any],
    *,
    receiver_authorizer: str,
    max_timeout_seconds: int,
    now_seconds: int | None = None,
    **binding: Any,
) -> bool:
    try:
        now = int(time.time()) if now_seconds is None else now_seconds
        deadline = authorization["validBefore"]
        if type(deadline) is not int or not now < deadline <= now + max_timeout_seconds:
            return False
        return Signature.from_string(authorization["signature"]).verify(
            Pubkey.from_string(receiver_authorizer),
            encode_close_authorization_digest(**binding, valid_before=deadline),
        )
    except (ValueError, TypeError, KeyError, AttributeError):
        return False
