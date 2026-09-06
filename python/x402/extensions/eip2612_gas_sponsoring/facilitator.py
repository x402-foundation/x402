"""Facilitator-side extraction and validation for EIP-2612 Gas Sponsoring."""

from __future__ import annotations

import re
import time

from ...mechanisms.evm.constants import PERMIT2_ADDRESS, PERMIT2_DEADLINE_BUFFER
from ...schemas import PaymentPayload
from .types import EIP2612_GAS_SPONSORING_KEY, Eip2612GasSponsoringInfo

_HEX_ADDRESS = re.compile(r"^0x[a-fA-F0-9]{40}$")
_DECIMAL_STRING = re.compile(r"^[0-9]+$")
_HEX_STRING = re.compile(r"^0x[a-fA-F0-9]+$")
_VERSION_STRING = re.compile(r"^[0-9]+(\.[0-9]+)*$")


def extract_eip2612_gas_sponsoring_info(
    payload: PaymentPayload,
) -> Eip2612GasSponsoringInfo | None:
    """Extract EIP-2612 gas sponsoring info from a payment payload.

    Returns None if the extension is not present or malformed.
    """
    extensions = payload.extensions
    if not extensions:
        return None

    ext_data = extensions.get(EIP2612_GAS_SPONSORING_KEY)
    if not isinstance(ext_data, dict):
        return None

    info = ext_data.get("info")
    if not isinstance(info, dict):
        return None

    required = ["from", "asset", "spender", "amount", "nonce", "deadline", "signature"]
    if not all(isinstance(info.get(k), str) for k in required):
        return None

    return Eip2612GasSponsoringInfo.from_dict(info)


def validate_eip2612_gas_sponsoring_info(info: Eip2612GasSponsoringInfo) -> bool:
    """Validate info fields against the JSON Schema patterns."""
    return (
        bool(_HEX_ADDRESS.match(info.from_address))
        and bool(_HEX_ADDRESS.match(info.asset))
        and bool(_HEX_ADDRESS.match(info.spender))
        and bool(_DECIMAL_STRING.match(info.amount))
        and bool(_DECIMAL_STRING.match(info.nonce))
        and bool(_DECIMAL_STRING.match(info.deadline))
        and bool(_HEX_STRING.match(info.signature))
        and bool(_VERSION_STRING.match(info.version))
    )


def validate_eip2612_permit_for_payment(
    info: Eip2612GasSponsoringInfo,
    payer: str,
    token_address: str,
) -> str:
    """Validate EIP-2612 extension data for a specific payment.

    Returns empty string if valid, or an error reason string.
    """
    if not validate_eip2612_gas_sponsoring_info(info):
        return "invalid_eip2612_extension_format"

    if info.from_address.lower() != payer.lower():
        return "eip2612_from_mismatch"

    if info.asset.lower() != token_address.lower():
        return "eip2612_asset_mismatch"

    if info.spender.lower() != PERMIT2_ADDRESS.lower():
        return "eip2612_spender_not_permit2"

    now = int(time.time())
    try:
        if int(info.deadline) < now + PERMIT2_DEADLINE_BUFFER:
            return "eip2612_deadline_expired"
    except (ValueError, TypeError):
        return "eip2612_deadline_expired"

    return ""
