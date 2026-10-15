"""Channel-bound payer proofs for explicitly trusted server voucher signers."""

from __future__ import annotations

import time
from typing import Any

from solders.pubkey import Pubkey
from solders.signature import Signature

from ..payment_channels import sign_message, signer_address
from .constants import AUTHORIZATION_DOMAIN


def encode_batch_authorization_message(
    channel_id: str,
    payer: str,
    operator: str,
    request_id: str,
    authorized_amount: int,
    expires_at: int,
) -> bytes:
    """Encode the protocol's versioned authorization message."""
    if not isinstance(request_id, str):
        raise ValueError("request_id must be a string")
    request = request_id.encode("utf-8")
    if not 1 <= len(request) <= 256:
        raise ValueError("request_id must encode to 1 through 256 bytes")
    if type(authorized_amount) is not int or not 0 <= authorized_amount < 2**64:
        raise ValueError("authorized_amount must fit in a u64")
    if type(expires_at) is not int or not 0 < expires_at <= 2**53 - 1:
        raise ValueError("expires_at must be a positive safe integer")
    return (
        AUTHORIZATION_DOMAIN
        + bytes(Pubkey.from_string(channel_id))
        + bytes(Pubkey.from_string(payer))
        + bytes(Pubkey.from_string(operator))
        + len(request).to_bytes(2, "little")
        + request
        + authorized_amount.to_bytes(8, "little")
        + expires_at.to_bytes(8, "little", signed=True)
    )


def sign_batch_authorization(
    payer: Any,
    channel_id: str,
    operator: str,
    request_id: str,
    authorized_amount: int,
    expires_at: int,
) -> dict[str, Any]:
    """Sign one bearer proof with a Keypair or an SVM message signer."""
    address = signer_address(payer)
    message = encode_batch_authorization_message(
        channel_id, address, operator, request_id, authorized_amount, expires_at
    )
    signature = sign_message(payer, message)
    return {
        "type": "proof",
        "channelId": channel_id,
        "payer": address,
        "requestId": request_id,
        "authorizedAmount": str(authorized_amount),
        "expiresAt": expires_at,
        "signature": str(signature),
    }


def verify_batch_authorization(
    authorization: dict[str, Any], operator: str, now_seconds: int | None = None
) -> bool:
    """Verify the domain, operator binding, payer signature, and expiry."""
    try:
        if authorization.get("type") != "proof":
            return False
        amount = authorization["authorizedAmount"]
        if not isinstance(amount, str) or not amount.isascii() or not amount.isdigit():
            return False
        expires = authorization["expiresAt"]
        if expires <= (int(time.time()) if now_seconds is None else now_seconds):
            return False
        message = encode_batch_authorization_message(
            authorization["channelId"],
            authorization["payer"],
            operator,
            authorization["requestId"],
            int(amount),
            expires,
        )
        return Signature.from_string(authorization["signature"]).verify(
            Pubkey.from_string(authorization["payer"]), message
        )
    except (KeyError, ValueError, TypeError, OverflowError, AttributeError):
        return False
